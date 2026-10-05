import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

function lineReader(stream) {
  let buffer = ""; const waiting = []; const queued = [];
  stream.on("data", (chunk) => {
    buffer += String(chunk);
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let value; try { value = JSON.parse(line); } catch { continue; }
      if (waiting.length) waiting.shift()(value); else queued.push(value);
    }
  });
  return () => queued.length ? Promise.resolve(queued.shift())
    : new Promise((resolveLine, rejectLine) => {
      const timer = setTimeout(() => rejectLine(new Error("worker reply timeout")), 4_000);
      waiting.push((value) => { clearTimeout(timer); resolveLine(value); });
    });
}

test("plocate worker owns one descendant, replaces it, preserves records, and proves caps", async t => {
  assert.equal(hostname(), "testbed", "runtime worker tests belong on Testbed");
  const fixture = mkdtempSync(join(tmpdir(), "ask-index-worker-"));
  const bin = join(fixture, "bin"); const root = join(fixture, "root");
  mkdirSync(bin); mkdirSync(root);
  const latest = join(root, "latest.txt"); writeFileSync(latest, "latest");
  const complete = join(root, "complete.txt"); writeFileSync(complete, "complete");
  for (let index = 0; index < 181; index++) writeFileSync(join(root, `cap-${index}.txt`), "cap");
  const pidLog = join(fixture, "pids"); const overlapLog = join(fixture, "overlap");
  const executable = join(bin, "plocate");
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const query = process.argv.at(-1);
const root = process.env.PLOCATE_FIXTURE_ROOT;
const pidLog = process.env.PLOCATE_PID_LOG;
if (query === 'slow') {
  process.on('SIGTERM', () => {});
  fs.appendFileSync(pidLog, String(process.pid) + '\\n');
  setInterval(() => {}, 1000);
} else {
  fs.appendFileSync(pidLog, String(process.pid) + '\\n');
  const first = Number((fs.readFileSync(pidLog, 'utf8').trim().split('\\n')[0]));
  try { process.kill(first, 0); fs.writeFileSync(process.env.PLOCATE_OVERLAP_LOG, 'overlap'); } catch {}
  if (query === 'latest') process.stdout.write(path.join(root, 'latest.txt') + '\\0');
  if (query === 'fragment') process.stdout.write(path.join(root, 'complete.txt') + '\\0' + path.join(root, 'partial'));
  if (query === 'cap') for (let i = 0; i < 181; i++) process.stdout.write(path.join(root, 'cap-' + i + '.txt') + '\\0');
}
`);
  chmodSync(executable, 0o755);

  const worker = spawn(process.execPath, [resolve("bridge/file-index-worker.js")], {
    cwd: resolve("."), detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ASK_FILE_ROOT: root, ASK_FILE_INDEX_MODE: "plocate",
      PATH: `${bin}:${process.env.PATH}`, PLOCATE_FIXTURE_ROOT: root,
      PLOCATE_PID_LOG: pidLog, PLOCATE_OVERLAP_LOG: overlapLog },
  });
  const next = lineReader(worker.stdout);
  const workerClosed = new Promise((resolveClose) => worker.once("close", resolveClose));
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) {
      try { process.kill(-worker.pid, "SIGKILL"); } catch {}
    }
    const confirmed = worker.exitCode !== null || worker.signalCode !== null || await Promise.race([
      workerClosed.then(() => true),
      new Promise((resolveWait) => setTimeout(() => resolveWait(false), 1_000)),
    ]);
    // Preserve evidence rather than risking PID-reuse cleanup after uncertain
    // process ownership.
    if (confirmed) rmSync(fixture, { recursive: true, force: true });
  });
  assert.deepEqual(await next(), { type: "ready", available: true });

  worker.stdin.write(`${JSON.stringify({ token: "old", query: "slow" })}\n`);
  const startedDeadline = Date.now() + 1_000;
  while (Date.now() < startedDeadline) {
    try { if (readFileSync(pidLog, "utf8").trim()) break; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.ok(readFileSync(pidLog, "utf8").trim(), "old descendant reached its TERM handler");
  worker.stdin.write(`${JSON.stringify({ token: "latest", query: "latest" })}\n`);
  const latestReply = await next();
  assert.equal(latestReply.token, "latest");
  assert.deepEqual(latestReply.rows.map(row => row.path), [latest]);
  assert.ok(Number.isFinite(latestReply.rows[0].modifiedMs));
  assert.equal(latestReply.available, true);
  assert.throws(() => readFileSync(overlapLog), /ENOENT/,
    "replacement must start only after the prior descendant closes");

  const oldPid = Number(readFileSync(pidLog, "utf8").trim().split("\n")[0]);
  assert.throws(() => process.kill(oldPid, 0), /ESRCH/);

  worker.stdin.write(`${JSON.stringify({ token: "fragment", query: "fragment" })}\n`);
  const fragment = await next();
  assert.equal(fragment.token, "fragment");
  assert.deepEqual(fragment.rows.map(row => row.path), [complete]);
  assert.equal(fragment.available, false);
  assert.equal(fragment.truncated, true);

  worker.stdin.write(`${JSON.stringify({ token: "cap", query: "cap" })}\n`);
  const cap = await next();
  assert.equal(cap.token, "cap");
  assert.equal(cap.rows.length, 180);
  assert.equal(cap.capped, true, "cap requires the 181st distinct valid file");

  worker.kill("SIGTERM");
  const exit = await new Promise((resolveExit) => worker.once("exit", (code, signal) => resolveExit({ code, signal })));
  assert.ok(exit.code === 0 || exit.signal === "SIGTERM", JSON.stringify(exit));
});
