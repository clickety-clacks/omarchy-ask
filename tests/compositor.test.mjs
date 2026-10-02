import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backends, detect } from "../bridge/compositor.js";

test("the session's desktop picks the backend", () => {
  assert.equal(detect({ XDG_CURRENT_DESKTOP: "Scottland:Wayfire:wlroots" }).name, "scottland");
  assert.equal(detect({ XDG_CURRENT_DESKTOP: "Hyprland" }).name, "hyprland");
  assert.equal(detect({}).name, "hyprland");
});

// A fake hyprctl records its arguments, so each backend's focus request is
// checked without touching a real compositor.
async function focusArgs(backend, address) {
  const dir = mkdtempSync(join(tmpdir(), "ask-compositor-"));
  const log = join(dir, "args.json");
  const fake = join(dir, "hyprctl");
  writeFileSync(fake, `#!${process.execPath}\nrequire("fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\nconsole.log("ok");\n`);
  chmodSync(fake, 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    const sent = await backend.focusWindow(address);
    let args = null;
    try { args = JSON.parse(readFileSync(log, "utf8")); } catch { }
    return { sent, args };
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Hyprland focuses through eval", async () => {
  const hypr = await focusArgs(backends.hyprland, "0x5c07000001ea");
  assert.deepEqual(hypr.args, ["eval", 'hl.dispatch(hl.dsp.focus({ window = "address:0x5c07000001ea" }))']);
});

test("malformed addresses never reach the compositor", async () => {
  const hypr = await focusArgs(backends.hyprland, '0x1" }) os.execute("x');
  assert.equal(hypr.sent, false);
  assert.equal(hypr.args, null);
  const sent = [];
  const call = async (method, data) => { sent.push([method, data]); return { result: "ok" }; };
  for (const bad of ['0x1" }) os.execute("x', "0x0", "", "12"]) {
    assert.equal(await backends.scottland.focusWindow(bad, call), false);
    assert.equal(await backends.scottland.presentWindow(bad, call), false);
  }
  assert.deepEqual(sent, []);
});

// A fake Wayfire IPC: records requests, answers from a fixed view list.
function fakeWayfire({ present = { result: "ok" } } = {}) {
  const sent = [];
  const views = [
    { id: 7, pid: -1, role: "toplevel", mapped: false, "app-id": "nil", title: "nil" },
    { id: 0x1ea, pid: 4242, role: "toplevel", mapped: true, "app-id": "com.mitchellh.ghostty",
      title: "[mosh] engram", "last-focus-timestamp": 50 },
    { id: 0x1f0, pid: 4343, role: "toplevel", mapped: true, "app-id": "chromium",
      title: "Docs", "last-focus-timestamp": 90 },
    { id: 0x200, pid: 4444, role: "desktop-environment", mapped: true, "app-id": "bar", title: "layer-shell" },
  ];
  const call = async (method, data) => {
    sent.push([method, data]);
    if (method === "window-rules/list-views") return views;
    if (method === "window-rules/get-focused-view") return { result: "ok", info: views[2] };
    if (method === "scottland/present") return present;
    return { result: "ok" };
  };
  return { sent, call };
}

test("Scottland lists mapped toplevels straight from Wayfire, ranked by last focus", async () => {
  const { call } = fakeWayfire();
  const windows = await backends.scottland.clients(call);
  assert.deepEqual(windows.map((w) => [w.address, w.stableId, w.pid, w.class, w.focusHistoryID]), [
    ["0x1ea", "000001ea", 4242, "com.mitchellh.ghostty", 1],
    ["0x1f0", "000001f0", 4343, "chromium", 0],
  ]);
  assert.equal(await backends.scottland.activeWindowAddress(call), "0x1f0");
});

test("Scottland focuses and presents by window id over Wayfire IPC, never hyprctl", async () => {
  const { sent, call } = fakeWayfire();
  assert.equal(await backends.scottland.focusWindow("0x1ea", call), true);
  assert.equal(await backends.scottland.presentWindow("0x1ea", call), true);
  assert.deepEqual(sent, [
    ["window-rules/focus-view", { id: 0x1ea }],
    ["scottland/present", { window: 0x1ea }],
  ]);
});

test("a Scottland without the present request still focuses the window", async () => {
  const { sent, call } = fakeWayfire({ present: { error: "No such method found!" } });
  assert.equal(await backends.scottland.presentWindow("0x1ea", call), true);
  assert.deepEqual(sent.at(-1), ["window-rules/focus-view", { id: 0x1ea }]);
});
