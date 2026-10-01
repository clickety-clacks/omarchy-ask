import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createResolverClient } from "../bridge/agent-window-resolver.js";

const request = {
  schema: "agent-window-resolver.request.v1",
  requestId: "cleanup-regression",
  operation: "resolve",
  requestedRelation: "visible_exact",
  target: {
    identity: {
      machine: "remote.example", instanceId: "roster-1",
      pid: 200, startTimeTicks: "42",
    },
  },
  local: { machine: "local.example" },
  windows: [],
  limits: { maxStdoutBytes: 4096 },
};

function processIsLive(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z";
  } catch { return false; }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

test("output-limit failure kills the resolver's owned descendant group", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ask-resolver-cleanup-"));
  const pidFile = join(directory, "descendant.pid");
  let descendantPid = 0;
  try {
    const program = `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const descendant = spawn(process.execPath,
        ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));
      process.stdout.write("x".repeat(5000));
      setInterval(() => {}, 1000);
    `.replace(/\n/g, " ");
    const client = createResolverClient({
      spawnImpl(_command, _args, options) {
        return spawn(process.execPath, ["-e", program, "--"], options);
      },
    });
    await assert.rejects(client.request(request), { code: "resolver_output_limit" });
    assert.equal(await waitFor(() => {
      try { descendantPid = Number(readFileSync(pidFile, "utf8")); return descendantPid > 1; }
      catch { return false; }
    }), true, "controlled resolver did not publish its descendant PID");
    assert.equal(await waitFor(() => !processIsLive(descendantPid)), true,
      `resolver descendant ${descendantPid} survived adapter cleanup`);
  } finally {
    if (processIsLive(descendantPid)) {
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
