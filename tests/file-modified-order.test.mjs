import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { FileSearchCoordinator } from "../bridge/file-search.js";

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "search did not finish");
    await delay(10);
  }
}

test("real streaming file scans retain newest files before the result cap in main and focused search", async () => {
  assert.equal(hostname(), "testbed");
  const root = mkdtempSync(join(tmpdir(), "ask-mtime-"));
  const directory = join(root, "needle"); mkdirSync(directory);
  const oldest = join(root, "needle.txt");
  const middle = join(root, "needle-middle.txt");
  const newest = join(directory, "z-newest.txt");
  for (const [path, seconds] of [[oldest, 100], [middle, 200], [newest, 300]]) {
    writeFileSync(path, "fixture"); utimesSync(path, seconds, seconds);
  }
  try {
    for (const focused of [false, true]) {
      const snapshots = [];
      const coordinator = new FileSearchCoordinator({ basePath: root, home: root,
        mountInfo: { mounts: [], incomplete: false }, enableIndex: false,
        maxEvidence: 2, maxResults: 2, emit: value => snapshots.push(value) });
      try {
        coordinator.request({ id: String(focused), query: "needle", focused });
        await waitFor(() => coordinator.current?.sources.size > 0 &&
          [...coordinator.current.sources.values()].every(source => source.status === "exhausted"));
        await waitFor(() => snapshots.at(-1)?.rows.length === 2);
        const result = snapshots.at(-1);
        assert.deepEqual(result.rows.map(row => row.path), [newest, middle]);
        assert.deepEqual(result.rows.map(row => row.modifiedMs), [300000, 200000]);
        assert.equal(result.capped, true);
      } finally { await coordinator.close(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("late metadata, unknown times and index union use the same newest-first bounded ordering", async () => {
  assert.equal(hostname(), "testbed");
  const coordinator = new FileSearchCoordinator({ basePath: "/fixture", enableIndex: false,
    maxEvidence: 3, maxResults: 3 });
  const request = { rows: new Map(), repos: new Map(), query: "needle", scopeRoot: "/fixture",
    indexScores: new Map(), canceled: false, indexToken: "index", plocateToken: "locate" };
  coordinator.current = request;
  try {
    const put = (name, time) => coordinator.insertBounded(request.rows, `/fixture/${name}`, request, false, time);
    put("needle-unknown", null); put("needle-old", 10); put("needle-tie-b", 20);
    put("needle-tie-a", 20); put("needle-new", 30);
    put("needle-new", null);
    assert.equal(request.rows.get("/fixture/needle-new"), 30);
    assert.equal(request.rows.has("/fixture/needle-old"), false);
    assert.equal(request.rows.has("/fixture/needle-unknown"), false);
    coordinator.acceptIndex("index", [{path: "/fixture/needle-index", modifiedMs: 40}]);
    coordinator.acceptPlocate("locate", [{path: "/fixture/needle-locate", modifiedMs: 50}]);
    assert.deepEqual([...request.rows.keys()].sort(),
      ["/fixture/needle-index", "/fixture/needle-locate", "/fixture/needle-new"]);
  } finally {
    clearTimeout(request.emitTimer);
    coordinator.current = null;
    await coordinator.close();
  }
});
