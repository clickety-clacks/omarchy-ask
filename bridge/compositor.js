// The only place the bridge talks to the compositor. Everything else in Ask
// (agents, files, conversations) is compositor-independent and must go
// through these functions instead of calling hyprctl itself.
//
// Window records keep Hyprland's client shape (address, stableId, pid,
// mapped, class, title, workspace, focusHistoryID); the Scottland backend
// builds the same shape from Wayfire's IPC, so callers share one model.

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

// Scottland is reached directly over Wayfire's IPC ($WAYFIRE_SOCKET), not
// through its Hyprland shim: the shim is a compatibility layer for software
// that only speaks Hyprland, and Ask breaks whenever it is down.
//
// Records keep Ask's shared window shape. A Scottland window id becomes the
// address "0x<id in hex>" and the stableId "<id in hex, 8 digits>"; neither
// leaves Ask. focusHistoryID ranks windows by Wayfire's last-focus time, the
// way the shim does.
function scottlandAddress(id) { return `0x${id.toString(16)}`; }

function scottlandId(address) {
  const id = Number.parseInt(String(address || "").replace(/^0x/i, ""), 16);
  return addressPattern.test(String(address || "")) && Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function scottlandClient(view, focusHistoryID) {
  const id = Number(view.id);
  return {
    address: scottlandAddress(id),
    stableId: id.toString(16).padStart(8, "0"),
    pid: Number(view.pid || 0),
    mapped: true,
    class: String(view["app-id"] || ""),
    title: String(view.title || ""),
    workspace: { id: 0, name: "" },
    focusHistoryID,
  };
}

async function wayfireOk(method, data, call) {
  const reply = await call(method, data);
  if (!reply || reply.error || (reply.result && reply.result !== "ok"))
    throw new Error(`${method}: ${reply?.error || "failed"}`);
  return reply;
}

const scottland = {
  name: "scottland",
  async clients(call = wayfireCall) {
    const views = await call("window-rules/list-views", {});
    if (!Array.isArray(views)) throw new Error("window-rules/list-views: no view list");
    const windows = views.filter((view) => view?.role === "toplevel" && view.mapped
      && Number.isSafeInteger(view.id) && view.id > 0);
    const ranked = [...windows].sort((a, b) =>
      Number(b["last-focus-timestamp"] || 0) - Number(a["last-focus-timestamp"] || 0));
    const order = new Map(ranked.map((view, index) => [view.id, index]));
    return windows.map((view) => scottlandClient(view, order.get(view.id)));
  },
  async activeWindowAddress(call = wayfireCall) {
    try {
      const view = (await call("window-rules/get-focused-view", {}))?.info;
      return view?.role === "toplevel" && view.id > 0 ? scottlandAddress(view.id) : "";
    } catch { return ""; }
  },
  async focusWindow(address, call = wayfireCall) {
    const id = scottlandId(address);
    if (!id) return false;
    await wayfireOk("window-rules/focus-view", { id }, call);
    return true;
  },
  // Opens a widget back into its window and brings a side window to the
  // middle at 100%. A Scottland build without the request still focuses.
  async presentWindow(address, call = wayfireCall) {
    const id = scottlandId(address);
    if (!id) return false;
    try {
      await wayfireOk("scottland/present", { window: id }, call);
      return true;
    } catch { }
    return scottland.focusWindow(address, call);
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
