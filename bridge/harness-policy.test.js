import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveHarness, resolveExecutable } from "./harness-policy.js";

test("system default, explicit override, and missing/unsupported defaults", () => {
  const home = mkdtempSync(join(tmpdir(), "ask-policy-"));
  try {
    const env = { HOME: home };
    assert.throws(() => resolveHarness(env), /No default agent/);
    assert.equal(resolveHarness({ ...env, ASK_AGENT: "claude" }), "claude");
    mkdirSync(join(home, ".config/omarchy/defaults"), { recursive: true });
    const path = join(home, ".config/omarchy/defaults/agent");
    writeFileSync(path, "codex\n");
    assert.equal(resolveHarness(env), "codex");
    writeFileSync(path, "claude\n");
    assert.equal(resolveHarness(env), "claude");
    assert.equal(resolveHarness({ ...env, ASK_AGENT: "codex" }), "codex");
    writeFileSync(path, "gemini\n");
    assert.throws(() => resolveHarness(env), /not supported/);
  } finally { rmSync(home, { recursive: true }); }
});

test("PATH and executable overrides, without bundled fallback", () => {
  const bin = mkdtempSync(join(tmpdir(), "ask-path-"));
  try {
    const env = { PATH: bin };
    assert.throws(() => resolveExecutable("codex", env), /system PATH/);
    mkdirSync(join(bin, "codex"));
    assert.throws(() => resolveExecutable("codex", env), /system PATH/);
    const executable = join(bin, "custom-harness");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    assert.equal(resolveExecutable("codex", { ...env, CODEX_PATH: executable }), executable);
    assert.equal(resolveExecutable("codex", { ...env, CODEX_PATH: "custom-harness" }), executable);
    assert.equal(resolveExecutable("claude", { ...env, CLAUDE_CODE_EXECUTABLE: executable }), executable);
    assert.throws(() => resolveExecutable("codex", { ...env, CODEX_PATH: "/nonexistent/ask-test" }), /configured executable/);
  } finally { rmSync(bin, { recursive: true }); }
});

test("startup failures reach the popup as structured fatal events", () => {
  const home = mkdtempSync(join(tmpdir(), "ask-startup-"));
  try {
    for (const [overrides, expected] of [
      [{ ASK_AGENT: "" }, /No default agent/],
      [{ ASK_AGENT: "gemini" }, /not supported/],
      [{ ASK_AGENT: "codex", CODEX_PATH: "/nonexistent/ask-test" }, /configured executable/],
      [{ ASK_AGENT: "codex", ASK_CODEX_ACP_COMMAND: "invalid" }, /JSON array/],
    ]) {
      const result = spawnSync(process.execPath, [new URL("bridge.js", import.meta.url).pathname], {
        env: { ...process.env, HOME: home, ASK_ACP_COMMAND: "", ASK_CODEX_ACP_COMMAND: "", ...overrides },
        encoding: "utf8", timeout: 10000,
      });
      assert.equal(result.status, 1, result.stderr);
      const event = JSON.parse(result.stdout.trim());
      assert.equal(event.type, "fatal");
      assert.match(event.message, expected);
    }
  } finally { rmSync(home, { recursive: true }); }
});
