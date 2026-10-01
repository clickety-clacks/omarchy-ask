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

test("Hyprland focuses through eval; Scottland's shim needs dispatch", async () => {
  const hypr = await focusArgs(backends.hyprland, "0x5c07000001ea");
  assert.deepEqual(hypr.args, ["eval", 'hl.dispatch(hl.dsp.focus({ window = "address:0x5c07000001ea" }))']);
  const scott = await focusArgs(backends.scottland, "0x5c07000001ea");
  assert.deepEqual(scott.args, ["dispatch", 'hl.dsp.focus({ window = "address:0x5c07000001ea" })']);
});

test("malformed addresses never reach the compositor", async () => {
  for (const backend of Object.values(backends)) {
    const result = await focusArgs(backend, '0x1" }) os.execute("x');
    assert.equal(result.sent, false);
    assert.equal(result.args, null);
  }
});
