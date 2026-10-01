// The only place the bridge talks to the compositor. Everything else in Ask
// (agents, files, conversations) is compositor-independent and must go
// through these functions instead of calling hyprctl itself.
//
// Window records keep Hyprland's client shape (address, stableId, pid,
// mapped, class, title, workspace, focusHistoryID). Scottland's Omarchy
// adapter serves that same shape through its Hyprland IPC shim, so callers
// share one model.

import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const addressPattern = /^0x[0-9a-f]+$/i;

async function hyprctlJson(args) {
  const { stdout } = await execFileAsync("hyprctl", [...args, "-j"], {
    timeout: 1200,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function clients() {
  const parsed = await hyprctlJson(["clients"]);
  return Array.isArray(parsed) ? parsed : [];
}

async function activeWindowAddress() {
  try {
    return String((await hyprctlJson(["activewindow"])).address || "").toLowerCase();
  } catch { return ""; }
}

// The only interpolation is a validated hexadecimal address; anything else
// returns false before reaching the compositor.
function focusCommand(address) {
  return `hl.dsp.focus({ window = "address:${address}" })`;
}

// Two verbs. focusWindow: give it keyboard focus. presentWindow: the user
// picked it ("I want to see this now"), so show it, wherever and in whatever
// form it is.
const hyprland = {
  name: "hyprland",
  clients,
  activeWindowAddress,
  async focusWindow(address) {
    if (!addressPattern.test(String(address || ""))) return false;
    await execFileAsync("hyprctl", ["eval", `hl.dispatch(${focusCommand(address)})`], { timeout: 1200 });
    return true;
  },
  // Hyprland's focus already switches to the window's workspace.
  async presentWindow(address) { return hyprland.focusWindow(address); },
};

// One request on Wayfire's IPC socket: a little-endian length, then JSON.
function wayfireCall(method, data, socketPath = process.env.WAYFIRE_SOCKET, timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    if (!socketPath) { reject(new Error("WAYFIRE_SOCKET is not set")); return; }
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Wayfire IPC timed out")); }, timeoutMs);
    const done = (error, value) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    socket.on("connect", () => {
      const body = Buffer.from(JSON.stringify({ method, data }));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const size = buffer.readUInt32LE(0);
      if (buffer.length < 4 + size) return;
      try { done(null, JSON.parse(buffer.subarray(4, 4 + size).toString("utf8"))); }
      catch (error) { done(error); }
    });
    socket.on("error", (error) => done(error));
  });
}

// Scottland's shim answers `dispatch` focus requests but treats `eval` as an
// unsupported no-op that still replies "ok", so focus must use dispatch.
const scottland = {
  name: "scottland",
  clients,
  activeWindowAddress,
  async focusWindow(address) {
    if (!addressPattern.test(String(address || ""))) return false;
    await execFileAsync("hyprctl", ["dispatch", focusCommand(address)], { timeout: 1200 });
    return true;
  },
  // Scottland's present request opens a widget back into its window and
  // brings a side window to the middle at 100%. The shim's stableId is the
  // Scottland window id in hex. A Scottland build without the request still
  // gets the window focused.
  async presentWindow(address, call = wayfireCall) {
    if (!addressPattern.test(String(address || ""))) return false;
    try {
      const window = (await clients()).find((client) =>
        String(client.address || "").toLowerCase() === String(address).toLowerCase());
      const id = Number.parseInt(String(window?.stableId || ""), 16);
      if (Number.isSafeInteger(id) && id > 0) {
        const reply = await call("scottland/present", { window: id });
        if (reply && !reply.error) return true;
      }
    } catch { }
    return scottland.focusWindow(address);
  },
};

export const backends = { hyprland, scottland };

// Chosen from the session Ask runs in, never by probing for the first
// compositor that answers.
export function detect(env = process.env) {
  const desktops = String(env.XDG_CURRENT_DESKTOP || "").split(":")
    .map((name) => name.trim().toLowerCase());
  if (desktops.includes("scottland")) return scottland;
  return hyprland;
}

export const compositor = detect();
