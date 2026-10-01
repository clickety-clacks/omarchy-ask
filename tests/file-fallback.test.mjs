import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { FileSearchCoordinator } from "../bridge/file-search.js";

async function until(predicate, milliseconds = 2000) {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(5);
  }
  throw new Error("condition did not become true");
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "ask-file-search-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "ArbitraryFolder"));
  return root;
}

function coordinator(root, emit, sourceTimeoutMs = 300) {
  return new FileSearchCoordinator({ basePath: root, home: root, enableIndex: false,
    mountInfo: { mounts: [], incomplete: false }, sourceTimeoutMs, emit });
}

test("fresh arbitrary-folder file arrives from the live coordinator", async t => {
  const root = fixture(t);
  const path = join(root, "ArbitraryFolder", "fresh.png");
  writeFileSync(path, "fixture");
  const snapshots = [];
  const search = coordinator(root, event => snapshots.push(event));
  try {
    search.request({ id: 1, query: "fresh.png" });
    const result = await until(() => snapshots.find(event => event.rows.some(row => row.path === path)));
    assert.equal(result.rows[0].path, path);
  } finally { await search.close(); }
});

test("timed-out live scans preserve complete records and stay incomplete", async t => {
  const root = fixture(t);
  const path = join(root, "ArbitraryFolder", "fresh.png");
  writeFileSync(path, "fixture");
  const snapshots = [];
  const search = new FileSearchCoordinator({ basePath: root, home: root, enableIndex: false,
    mountInfo: { mounts: [], incomplete: false }, sourceTimeoutMs: 100,
    spawn(command, args, options) {
      return spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(path + "\0")}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`], options);
    }, emit: event => snapshots.push(event) });
  try {
    search.request({ id: 2, query: "fresh.png" });
    const result = await until(() => snapshots.find(event => event.rows.some(row => row.path === path)));
    assert.equal(result.complete, false);
  } finally { await search.close(); }
});

test("failed empty live scan does not claim exhaustive no-match", async t => {
  const root = fixture(t);
  const snapshots = [];
  const search = new FileSearchCoordinator({ basePath: root, home: root, enableIndex: false,
    mountInfo: { mounts: [], incomplete: false }, sourceTimeoutMs: 300,
    spawn(command, args, options) {
      return spawn(process.execPath, ["-e", "process.exit(23)"], options);
    }, emit: event => snapshots.push(event) });
  try {
    search.request({ id: 3, query: "missing.png" });
    const result = await until(() => snapshots.find(event => event.complete === false));
    assert.deepEqual(result.rows, []);
    assert.equal(result.complete, false);
  } finally { await search.close(); }
});

test("punctuation remains a literal live filename query", async t => {
  const root = fixture(t);
  const name = "capture[1]+(edited).png";
  const path = join(root, "ArbitraryFolder", name);
  writeFileSync(path, "fixture");
  writeFileSync(join(root, "ArbitraryFolder", "capture1editedXpng"), "decoy");
  const snapshots = [];
  const search = coordinator(root, event => snapshots.push(event));
  try {
    search.request({ id: 4, query: name });
    const result = await until(() => snapshots.find(event => event.complete));
    assert.deepEqual(result.rows.map(row => row.path), [path]);
  } finally { await search.close(); }
});

test("configured root name is not itself a live-path match", async t => {
  const parent = fixture(t);
  const root = join(parent, "needle-root");
  mkdirSync(root);
  const wanted = join(root, "actual-needle.txt");
  const unrelated = join(root, "unrelated.txt");
  writeFileSync(wanted, "fixture"); writeFileSync(unrelated, "fixture");
  const snapshots = [];
  const search = coordinator(root, event => snapshots.push(event));
  try {
    search.request({ id: 5, query: "needle" });
    const result = await until(() => snapshots.find(event => event.complete));
    assert.deepEqual(result.rows.map(row => row.path), [wanted]);
  } finally { await search.close(); }
});

test("live traversal preserves all literal terms regardless of typed order", async t => {
  const root = fixture(t);
  const wanted = join(root, "ArbitraryFolder", "foo bar.txt");
  const decoy = join(root, "ArbitraryFolder", "bar-only.txt");
  writeFileSync(wanted, "fixture"); writeFileSync(decoy, "fixture");
  const snapshots = [];
  const search = coordinator(root, event => snapshots.push(event));
  try {
    search.request({ id: 6, query: "bar foo" });
    const result = await until(() => snapshots.find(event => event.complete));
    assert.deepEqual(result.rows.map(row => row.path), [wanted]);
  } finally { await search.close(); }
});
