import { test } from "node:test";
import assert from "node:assert/strict";
import { agentModeFor } from "./permission-mode.js";

const mode = (id, kind) => ({ id, name: id, _meta: { kind } });

// As advertised by codex-acp 1.10.0 and claude-agent-acp 0.74.0.
const codex = {
  currentModeId: "agent",
  availableModes: [
    mode("read-only", "standard"),
    mode("agent", "auto_review"),
    mode("agent-full-access", "full_access"),
  ],
};
const claude = {
  currentModeId: "default",
  availableModes: [
    mode("default", "standard"),
    mode("acceptEdits", "standard"),
    mode("plan", "plan"),
    mode("auto", "auto_review"),
    mode("bypassPermissions", "full_access"),
  ],
};

test("YOLO selects the adapter's full-access mode", () => {
  assert.equal(agentModeFor("yolo", codex), "agent-full-access");
  assert.equal(agentModeFor("yolo", claude), "bypassPermissions");
});

test("Ask leaves automatic review for a mode that asks", () => {
  assert.equal(agentModeFor("permission", codex), "read-only");
  assert.equal(agentModeFor("permission", claude), "default");
  assert.equal(agentModeFor("permission",
    { ...claude, currentModeId: "acceptEdits" }), "acceptEdits");
});

test("no matching mode means no mode change", () => {
  assert.equal(agentModeFor("yolo", undefined), null);
  assert.equal(agentModeFor("yolo", { availableModes: [mode("x", "standard")] }), null);
  assert.equal(agentModeFor("permission", { availableModes: [mode("a", "auto_review")] }), null);
});
