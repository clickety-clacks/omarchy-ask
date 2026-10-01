import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { test } from "node:test";
import { createResolverClient } from "../bridge/agent-window-resolver.js";

// Read-only integration: the real bundled Python collector verifies this
// owned Node process. No compositor, remote host, tmux or harness is touched.
test("bundled Python resolves and revalidates an actual local process", async () => {
  const stat = await readFile(`/proc/${process.pid}/stat`, "utf8");
  const ticks = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  const client = createResolverClient();
  const request = {
    schema: "agent-window-resolver.request.v1", requestId: "bundled-local-1",
    operation: "resolve", requestedRelation: "visible_exact",
    target: { identity: { machine: hostname(), instanceId: "owned-test-process", pid: process.pid, startTimeTicks: ticks } },
    local: { machine: hostname() },
    windows: [{ stableId: "owned-process", address: "0xabc", pid: process.pid, startTimeTicks: ticks }],
  };
  const result = await client.request(request);
  assert.equal(result.status, "matched", JSON.stringify(result.reasons));
  assert.equal(result.candidates[0].window.pid, process.pid);
  const repeated = await client.request({ ...request, requestId: "bundled-local-2", operation: "revalidate", prior: result.candidates[0] });
  assert.equal(repeated.status, "matched", JSON.stringify(repeated.reasons));
  const wrong = await client.request({ ...request, requestId: "bundled-local-3", target: { identity: { ...request.target.identity, startTimeTicks: (BigInt(ticks) + 1n).toString() } } });
  assert.equal(wrong.status, "unresolved");
  assert.equal(wrong.candidates.length, 0);
});
