import { test } from "node:test";
import assert from "node:assert/strict";
import { explainHarnessError, needsNewSession } from "./harness-errors.js";

test("missing login explains system-harness recovery", () => {
  assert.equal(needsNewSession(new Error("Authentication required")), true);
  assert.equal(needsNewSession(new Error("ACP connection closed")), true);
  assert.equal(needsNewSession(new Error("Rate limit exceeded")), false);
  for (const agent of ["codex", "claude"])
    assert.match(explainHarnessError(new Error("Authentication required"), agent),
      new RegExp(`system ${agent} harness and sign in`));
});
test("outdated harness and closed connection explain next steps", () => {
  assert.match(explainHarnessError(new Error("This model requires a newer version of Codex"), "codex"), /Update the system harness/);
  assert.match(explainHarnessError(new Error("ACP connection closed"), "claude"), /Claude Code closed the connection.*Start a new session/);
});
test("unknown failures retain the original useful detail", () => {
  assert.equal(explainHarnessError(new Error("Configured ACP option unavailable: example"), "codex"),
    "Configured ACP option unavailable: example");
});
