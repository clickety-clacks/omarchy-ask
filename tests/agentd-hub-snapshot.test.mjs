import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const bridge = fileURLToPath(new URL("../bridge/agentd-hub.js", import.meta.url));

function duplicateSnapshot() {
  const agent = {
    machine: "test-machine", instanceId: "same-instance",
    id: { pid: 123, startTimeTicks: 42 },
    activity: { state: "idle" }, presence: { state: "present" },
  };
  return {
    type: "snapshot", schema: "agentd-hub.snapshot.v1", revision: 1,
    sources: [{ machine: "test-machine", health: { state: "reporting" }, scan: { state: "complete" } }],
    agents: [agent, { ...agent, id: { ...agent.id, startTimeTicks: "42" } }],
  };
}

test("duplicate normalized activation identities invalidate a complete Hub frame", async () => {
  const server = createServer((request, response) => {
    if (request.url !== "/events") { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`event: snapshot\ndata: ${JSON.stringify(duplicateSnapshot())}\n\n`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const child = spawn(process.execPath, [bridge], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const messages = [];
  try {
    const rejected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for snapshot rejection")), 3000);
      child.once("error", reject);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          messages.push(message);
          if (message.type === "status"
              && message.error === "duplicate agentd-hub agent identity") {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });
    child.stdin.write(`${JSON.stringify({ op: "configure", host: "127.0.0.1", port })}\n`);
    await rejected;
    assert.equal(messages.some((message) => message.type === "snapshot"), false);
    assert.equal(messages.at(-1).connected, false);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => server.close(resolve));
  }
});
