import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { FileSearchCoordinator, IndexWorker, StreamSource, __test, parseMountInfo,
  planPartitions } from "../bridge/file-search.js";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 999999;
  child.kill = () => { child.emit("close", null, "SIGTERM"); };
  return child;
}

test("mount planning decodes escaped nested mounts and prunes each parent", () => {
  const info = [
    String.raw`10 1 0:1 / /tmp/ask\040root/mnt rw - fuse.rclone rclone rw`,
    String.raw`11 10 0:2 / /tmp/ask\040root/mnt/nested rw - tmpfs tmpfs rw`,
  ].join("\n");
  const plan = planPartitions("/tmp/ask root", parseMountInfo(info));
  assert.deepEqual(plan.partitions.map((partition) => partition.root), [
    "/tmp/ask root", "/tmp/ask root/mnt", "/tmp/ask root/mnt/nested",
  ]);
  assert.deepEqual(plan.partitions[0].prunedMounts, ["/tmp/ask root/mnt", "/tmp/ask root/mnt/nested"]);
  assert.deepEqual(plan.partitions[1].prunedMounts, ["/tmp/ask root/mnt/nested"]);
  assert.deepEqual(plan.partitions[2].prunedMounts, []);
});

test("stream source preserves complete NUL records and drops trailing fragments", async () => {
  const child = fakeChild();
  const records = []; let terminal;
  const source = new StreamSource({ id: "fixture", kind: "local", command: "fd", args: [],
    spawn: () => child, timeoutMs: 1000, onRecord: (record) => records.push(record),
    onTerminal: (value) => { terminal = value; } }).start();
  child.stdout.write(Buffer.from("/tmp/a\nname\0/tmp/split"));
  child.stdout.write(Buffer.from("\nname\0")); child.emit("close", 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(records, ["/tmp/a\nname", "/tmp/split\nname"]);
  assert.equal(terminal.status, "exhausted");
  assert.equal(source.buffer.length, 0);
});

test("coordinator publishes local results while a mounted source is still open", async () => {
  const events = []; const children = [];
  const root = "/tmp/ask-fixture"; const mount = `${root}/mounted`;
  const coordinator = new FileSearchCoordinator({ basePath: root, home: root, enableIndex: false,
    mountInfo: { mounts: [{ id: "7", mountPoint: mount }], incomplete: false }, maxConcurrent: 4,
    sourceTimeoutMs: 1000, spawn: (_command, args) => {
      const child = fakeChild(); children.push({ child, args });
      const path = args.at(-1); const isMount = path === mount;
      setTimeout(() => child.stdout.write(`${isMount ? `${mount}/later.png` : `${root}/local.png`}\0`), isMount ? 100 : 5);
      setTimeout(() => { if (!isMount) child.emit("close", 0, null); }, 15);
      return child;
    }, emit: (event) => events.push(event) });
  coordinator.request({ id: 1, query: "png" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const early = events.find((event) => event.rows.some((row) => row.path === `${root}/local.png`));
  assert.ok(early, "local row should be published before mounted source EOF");
  assert.equal(early.complete, false);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const final = events.at(-1);
  assert.ok(final.rows.some((row) => row.path === `${mount}/later.png`));
  await coordinator.close();
  assert.ok(children.length >= 2);
});

test("reused public ids cannot admit old-generation rows", async () => {
  const events = []; const children = [];
  const coordinator = new FileSearchCoordinator({ basePath: "/tmp/ask-generation", home: "/tmp/ask-generation",
    enableIndex: false, mountInfo: { mounts: [], incomplete: false }, sourceTimeoutMs: 1000,
    spawn: (_command, args) => {
      const child = fakeChild(); children.push(child);
      const query = args.at(-2); const row = query === "old" ? "/tmp/ask-generation/old.txt" : "/tmp/ask-generation/new.txt";
      setTimeout(() => child.stdout.write(`${row}\0`), query === "old" ? 80 : 10);
      setTimeout(() => child.emit("close", 0, null), 120);
      return child;
    }, emit: (event) => events.push(event) });
  coordinator.request({ id: 4, query: "old" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  coordinator.request({ id: 4, query: "new" });
  await new Promise((resolve) => setTimeout(resolve, 160));
  const current = events.filter((event) => event.id === 4 && event.query === "new");
  assert.ok(current.length > 0);
  assert.ok(current.every((event) => event.rows.every((row) => !row.path.endsWith("old.txt"))));
  await coordinator.close();
});

test("root helper output is exactly one terminal-NUL record", () => {
  assert.equal(__test.parseSingleNulPath("/tmp/root\0"), "/tmp/root");
  assert.equal(__test.parseSingleNulPath("/tmp/root\0trailing"), null);
  assert.equal(__test.parseSingleNulPath("/tmp/root\0\0"), null);
  assert.equal(__test.parseSingleNulPath("/tmp/root"), null);
});

test("metadata result deadline does not release ownership before close", async () => {
  const child = fakeChild();
  child.kill = () => {};
  let owned = 0; let released = 0;
  const result = __test.readOwnedOutput(() => child, "helper", [], {
    maxBytes: 100, timeoutMs: 10,
    onChild: () => { owned++; }, onDone: () => { released++; },
  });
  await assert.rejects(result, /timeout/);
  assert.equal(owned, 1);
  assert.equal(released, 0, "deadline must not free helper capacity");
  child.emit("close", null, "SIGKILL");
  await result.reaped;
  assert.equal(released, 1);
});

function fakeWorkerChild({ closeOnKill = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.pid = 999998; child.kill = () => {
    if (closeOnKill) setImmediate(() => child.emit("close", null, "SIGTERM"));
    return true;
  };
  return child;
}

test("index worker retains only the latest query through warmup", async () => {
  const children = []; const unavailable = []; const replies = [];
  const worker = new IndexWorker({ workerPath: "/fixture/worker.js", basePath: "/tmp/index-root",
    startupTimeoutMs: 200, timeoutMs: 100,
    spawn: () => { const child = fakeWorkerChild(); children.push(child); return child; },
    onUnavailable: (token) => unavailable.push(token),
    onRows: (token, rows) => replies.push({ token, rows }) });
  worker.request("old", "old", true, "/tmp/index-root");
  worker.request("latest", "latest", true, "/tmp/index-root");
  assert.deepEqual(unavailable, ["old"]);
  assert.equal(children.length, 1);
  let sent = ""; children[0].stdin.on("data", (chunk) => { sent += chunk; });
  children[0].stdout.write(`${JSON.stringify({ type: "ready", available: true })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(sent, /"token":"latest"/);
  assert.doesNotMatch(sent, /"token":"old"/);
  children[0].stdout.write(`${JSON.stringify({ token: "latest", rows: [{ path: "/tmp/index-root/latest" }] })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replies.at(-1).token, "latest");
  await worker.close();
});

test("index worker spawn failures use bounded retry backoff", () => {
  let attempts = 0; const unavailable = [];
  const worker = new IndexWorker({ workerPath: "/missing/worker.js", basePath: "/tmp/index-root",
    retryBaseMs: 10_000, spawn: () => { attempts++; throw new Error("spawn missing"); },
    onUnavailable: (token) => unavailable.push(token) });
  worker.request("one", "one", true, "/tmp/index-root");
  worker.request("two", "two", true, "/tmp/index-root");
  worker.request("three", "three", true, "/tmp/index-root");
  assert.equal(attempts, 1);
  assert.deepEqual(unavailable, ["one", "two", "three"]);
});

test("focused short query completes without starting optional work", () => {
  const events = []; let spawned = 0;
  const coordinator = new FileSearchCoordinator({ basePath: "/tmp/short-query", home: "/tmp",
    enableIndex: true, mountInfo: { mounts: [], incomplete: false },
    spawn: () => { spawned++; return fakeWorkerChild(); }, emit: (event) => events.push(event) });
  coordinator.request({ id: 9, query: "x", focused: true });
  assert.equal(spawned, 0);
  assert.equal(events.at(-1).complete, true);
  assert.deepEqual(events.at(-1).rows, []);
});

test("scope-root text is not an accelerator match", () => {
  assert.equal(__test.usefulIndexCandidate({}, "/tmp/needle-root/unrelated.txt", "needle", false,
    "/tmp/needle-root"), false);
  assert.equal(__test.usefulIndexCandidate({}, "/tmp/needle-root/sub/needle.txt", "needle", false,
    "/tmp/needle-root"), true);
  const command = __test.sourceCommand({ root: "/tmp/needle-root", prunedMounts: [] }, "needle", {
    scopeRoot: "/tmp/needle-root",
  });
  const pattern = command.args[command.args.indexOf("--full-path") + 1];
  const expression = new RegExp(pattern.replace(/^\(\?s\)/, ""), "s");
  assert.equal(expression.test("/tmp/needle-root/unrelated.txt"), false);
  assert.equal(expression.test("/tmp/needle-root/sub/needle.txt"), true);
  assert.equal(expression.test("/tmp/needle-root/sub\nfolder/needle.txt"), true);
});

test("invalid repository depth defaults safely while explicit nonpositive remains unlimited", () => {
  assert.equal(__test.readRepoDepth(null, "invalid"), 6);
  assert.equal(__test.readRepoDepth(null, "0"), 0);
  assert.equal(__test.readRepoDepth(null, "-4"), 0);
  assert.equal(__test.readRepoDepth(null, "500"), 128);
});
