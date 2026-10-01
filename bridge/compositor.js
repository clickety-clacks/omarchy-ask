// The only place the bridge talks to the compositor. Everything else in Ask
// (agents, files, conversations) is compositor-independent and must go
// through these functions instead of calling hyprctl itself.
//
// Window records keep Hyprland's client shape (address, stableId, pid,
// mapped, class, title, workspace, focusHistoryID). Scottland's Omarchy
// adapter serves that same shape through its Hyprland IPC shim, so callers
// share one model.

import { execFile } from "node:child_process";
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

const hyprland = {
  name: "hyprland",
  clients,
  activeWindowAddress,
  async focusWindow(address) {
    if (!addressPattern.test(String(address || ""))) return false;
    await execFileAsync("hyprctl", ["eval", `hl.dispatch(${focusCommand(address)})`], { timeout: 1200 });
    return true;
  },
};

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
