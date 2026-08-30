import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const addressPattern = /^0x[0-9a-f]+$/i;
const stableIdPattern = /^[0-9a-f]+$/i;

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function clients() {
  const { stdout } = await execFileAsync("hyprctl", ["clients", "-j"], {
    timeout: 1200,
    maxBuffer: 2 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [];
}

async function processTree() {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid="], {
    timeout: 800,
    maxBuffer: 1024 * 1024,
  });
  const children = new Map();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  return children;
}

function descendants(pid, children) {
  const found = [];
  const pending = [Number(pid)];
  while (pending.length && found.length < 128) {
    const parent = pending.shift();
    for (const child of children.get(parent) || []) {
      found.push(child);
      pending.push(child);
    }
  }
  return found;
}

async function commandLine(pid) {
  try {
    const value = await readFile(`/proc/${pid}/cmdline`);
    return value.toString().split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function commandIndex(args, name) {
  return args.findIndex((arg) => String(arg).split("/").pop() === name);
}

function optionValue(args, start, names) {
  for (let index = start; index < args.length - 1; index++) {
    if (names.includes(args[index])) return args[index + 1];
  }
  return "";
}

function remoteHost(args, executable) {
  const start = commandIndex(args, executable);
  if (start < 0) return "";
  if (executable.startsWith("mosh")) {
    const separator = args.indexOf("--", start + 1);
    return separator >= 0 ? String(args[separator + 1] || "") : "";
  }
  const takesValue = new Set(["-B", "-b", "-c", "-D", "-E", "-e", "-F",
    "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-P", "-p", "-Q",
    "-R", "-S", "-W", "-w"]);
  for (let index = start + 1; index < args.length; index++) {
    const arg = String(args[index]);
    if (takesValue.has(arg)) { index++; continue; }
    if (arg.startsWith("-")) continue;
    return arg.includes("@") ? arg.split("@").pop() : arg;
  }
  return "";
}

function terminalContext(commandLines) {
  let host = "";
  let session = "";
  let transport = "";
  for (const args of commandLines) {
    const mosh = commandIndex(args, "mosh") >= 0 ? "mosh"
      : (commandIndex(args, "mosh-client") >= 0 ? "mosh-client" : "");
    const ssh = commandIndex(args, "ssh") >= 0 ? "ssh" : "";
    if (!host && mosh) { host = remoteHost(args, mosh); transport = "mosh"; }
    if (!host && ssh) { host = remoteHost(args, ssh); transport = "ssh"; }
    const tmux = commandIndex(args, "tmux");
    if (!session && tmux >= 0)
      session = optionValue(args, tmux + 1, ["-s", "-t"]);
  }
  if (host && session) return { label: `${host} · ${session}`, detail: `${transport} · tmux` };
  if (host) return { label: `${transport} · ${host}`, detail: transport };
  if (session) return { label: `tmux · ${session}`, detail: "tmux" };
  return null;
}

async function enrichWindow(window, children) {
  const pid = Number(window.pid || 0);
  if (!pid) return null;
  const pids = [pid, ...descendants(pid, children)];
  const commandLines = await Promise.all(pids.map(commandLine));
  return terminalContext(commandLines.filter((args) => args.length));
}

function scoreWindow(window, query) {
  if (!query) return 0;
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const title = String(window.title || "").toLocaleLowerCase();
  const klass = String(window.class || "").toLocaleLowerCase();
  const detail = String(window.detail || "").toLocaleLowerCase();
  const haystack = `${title} ${klass} ${detail}`;
  if (!words.every((word) => haystack.includes(word))) return null;
  if (title === query) return 0;
  if (title.startsWith(query)) return 1;
  if (title.includes(query)) return 2;
  if (klass.startsWith(query)) return 3;
  return 4;
}

async function search(message) {
  const query = String(message.query || "").trim().toLocaleLowerCase();
  const [windowList, children] = await Promise.all([clients(), processTree()]);
  const enriched = await Promise.all(windowList.map(async (window) => ({
    ...window,
    context: await enrichWindow(window, children),
  })));
  const rows = enriched.flatMap((window) => {
    const address = String(window.address || "");
    const stableId = String(window.stableId || "");
    const originalTitle = String(window.title || "").trim();
    const title = String(window.context?.label || originalTitle).trim();
    if (!window.mapped || !title || !addressPattern.test(address)
        || address === "0x0" || !stableIdPattern.test(stableId)) return [];
    const detail = String(window.context?.detail || "");
    const score = scoreWindow({ ...window, title, detail }, query);
    if (score === null) return [];
    return [{
      stableId,
      title,
      detail,
      originalTitle,
      class: String(window.class || ""),
      workspace: String(window.workspace?.name || window.workspace?.id || ""),
      score,
    }];
  }).sort((a, b) => a.score - b.score || a.title.localeCompare(b.title)).slice(0, 40);
  emit({ id: message.id, rows });
}

async function focus(message) {
  const stableId = String(message.stableId || "");
  if (!stableIdPattern.test(stableId)) return;

  // Re-resolve immediately before dispatch. Never reuse an address returned
  // by search: the window may have closed or Hyprland may have restarted.
  const window = (await clients()).find((candidate) =>
    String(candidate.stableId || "") === stableId && candidate.mapped);
  const address = String(window?.address || "");
  if (!addressPattern.test(address) || address === "0x0") return;

  // The only interpolation is a validated hexadecimal address. An empty,
  // malformed, or disappeared target exits above and never reaches Lua.
  const code = `hl.dispatch(hl.dsp.focus({ window = "address:${address}" }))`;
  await execFileAsync("hyprctl", ["eval", code], { timeout: 1200 });
}

if (process.argv[2] === "--focus") {
  await focus({ stableId: process.argv[3] }).catch(() => {});
} else {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      search(message).catch(() => emit({ id: message.id, rows: [] }));
    } catch { }
  });
}
