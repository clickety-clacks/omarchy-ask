// Parent-owned acceptance checks. They exercise production readers/planners
// with real child processes, independently of the implementation's own suite.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { FileSearchCoordinator, IndexWorker, StreamSource, parseMountInfo, planPartitions } from "../bridge/file-search.js";

test("optional worker startup retains only latest query without applying the query deadline to warmup", async () => {
  const children = []; const replies = []; const unavailable = [];
  const worker = new IndexWorker({ basePath: "/fixture", workerPath: "/unused-injected-fixture",
    timeoutMs: 100, startupTimeoutMs: 1000,
    spawn(command, args, options) {
      const child = spawn(process.execPath, ["-e", `
        require('node:readline').createInterface({input:process.stdin}).on('line', line => {
          const msg=JSON.parse(line);
          process.stdout.write(JSON.stringify({token:msg.token,available:true,rows:[msg.query]})+'\\n');
        });
        setTimeout(()=>process.stdout.write(JSON.stringify({type:'ready',available:true})+'\\n'),300);
      `], options);
      children.push({ child, closed: once(child, "close") }); return child;
    }, onRows: (token, rows) => replies.push({ token, rows }), onUnavailable: token => unavailable.push(token) });
  try {
    for (let i = 0; i < 30; i++) worker.request(`token-${i}`, `query-${i}`, true);
    await delay(160);
    assert.equal(children.length, 1, "warmup does not create one index per keystroke");
    assert.ok(!unavailable.includes("token-29"), "query budget has not begun before readiness");
    await until(() => replies.length > 0);
    assert.deepEqual(replies, [{ token: "token-29", rows: ["query-29"] }]);
    await worker.close();
    assert.ok(children.every(({ child }) => child.exitCode !== null || child.signalCode !== null));
  } finally {
    const cleanup = worker.close();
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
    await cleanup;
  }
});

test("missing optional worker is reported and retry backoff prevents a per-keystroke spawn storm", async () => {
  let attempts = 0; const unavailable = [];
  const worker = new IndexWorker({ basePath: "/fixture", workerPath: "/missing",
    retryBaseMs: 200, retryMaxMs: 400,
    spawn() { attempts++; throw new Error("injected missing runtime"); },
    onUnavailable: token => unavailable.push(token) });
  try {
    for (let i = 0; i < 30; i++) worker.request(`first-${i}`, "needle", true);
    assert.equal(attempts, 1);
    assert.equal(new Set(unavailable).size, 30, "unavailable never leaves a query pending forever");
    await delay(220);
    worker.request("retry", "needle", true);
    assert.equal(attempts, 2);
    assert.ok(unavailable.includes("retry"));
    for (let i = 0; i < 30; i++) worker.request(`second-${i}`, "needle", true);
    assert.equal(attempts, 2);
  } finally { await worker.close(); }
});

test("root mount, stacked mounts, exclusions and path escapes preserve the intended scope", () => {
  const raw = ["1 0 8:1 / / rw - ext4 disk rw",
    "2 1 0:2 / /scope rw - tmpfs none rw",
    "3 2 0:3 / /scope/a\\011tab\\012line\\134slash rw - tmpfs none rw",
    "4 2 0:4 / /scope/node_modules/mnt rw - tmpfs none rw",
    "5 2 0:5 / /scope-neighbor rw - tmpfs none rw",
    ...Array.from({ length: 300 }, (_, i) => `${i + 10} 2 0:6 / /scope/stack rw - tmpfs none rw`),
    "999 2 0:7 / /scope/unique rw - tmpfs none rw"].join("\n");
  const plan = planPartitions("/scope", raw);
  assert.equal(plan.incomplete, false, "stacked duplicates do not consume unique-partition budget");
  assert.deepEqual(plan.partitions.map(p => p.root).sort(),
    ["/scope", "/scope/a\ttab\nline\\slash", "/scope/stack", "/scope/unique"].sort());
  const filesystemRoot = planPartitions("/", "1 0 8:1 / / rw - ext4 disk rw\n2 1 0:2 / /mnt rw - tmpfs none rw\n");
  assert.ok(filesystemRoot.partitions.some(p => p.root === "/mnt"), "filesystem root containment is not a double-slash prefix");
  const limited = planPartitions("/scope", { incomplete: false,
    mounts: Array.from({ length: 260 }, (_, i) => ({ id: String(i), mountPoint: `/scope/m${String(i).padStart(3, "0")}` })) });
  assert.equal(limited.partitions.length, 256);
  assert.equal(limited.incomplete, true);
  assert.equal(limited.partitions[0].prunedMounts.length, 260,
    "omitted mounted jobs must still be excluded from base traversal, including same-device binds");
});

test("the configured root's own name does not make every file or repository a query match", async () => {
  const root = mkdtempSync(join(tmpdir(), "needle-root-"));
  const wanted = join(root, "needle-file.txt");
  writeFileSync(wanted, "fixture");
  writeFileSync(join(root, "unrelated.txt"), "fixture");
  mkdirSync(join(root, "unrelated-repo", ".git"), { recursive: true });
  const repo = join(root, "needle-repo"); mkdirSync(join(repo, ".git"), { recursive: true });
  const events = [];
  const coordinator = new FileSearchCoordinator({ basePath: root, home: root, enableIndex: false,
    mountInfo: { mounts: [], incomplete: false }, emit: event => events.push(event) });
  try {
    coordinator.request({ id: 1, query: "needle" });
    const result = await until(() => events.find(event => event.id === 1 && event.complete && event.repoComplete));
    assert.deepEqual(result.rows.map(row => row.path), [wanted]);
    assert.deepEqual(result.repos.map(row => row.path), [repo]);
    coordinator.request({ id: 2, query: "n", focused: true });
    const short = await until(() => events.find(event => event.id === 2));
    assert.equal(short.complete, true, "unsupported short query is terminal, not forever pending");
    const reversed = join(root, "beta-alpha.txt");
    writeFileSync(reversed, "fixture");
    writeFileSync(join(root, "alpha-unrelated.txt"), "fixture");
    coordinator.request({ id: 3, query: "alpha beta" });
    const terms = await until(() => events.find(event => event.id === 3 && event.complete));
    assert.deepEqual(terms.rows.map(row => row.path), [reversed],
      "fresh traversal uses all literal terms regardless of their order, without an index");
  } finally { await coordinator.close(); rmSync(root, { recursive: true, force: true }); }
});

test("real symlink root and per-query mount refresh keep canonical scope and base-relative repo depth", async () => {
  const owned = mkdtempSync(join(tmpdir(), "ask-root-scope-"));
  const root = join(owned, "root with trailing newline\n");
  const alias = join(owned, "alias");
  const mount = join(root, "sub", "mount");
  mkdirSync(mount, { recursive: true });
  symlinkSync(root, alias);
  const wanted = join(root, "needle-local.txt");
  writeFileSync(wanted, "fixture");
  const shallowRepo = join(mount, "needle-repo");
  const deepRepo = join(shallowRepo, "nested", "needle-too-deep");
  mkdirSync(deepRepo, { recursive: true });
  writeFileSync(join(shallowRepo, ".git"), "gitdir: fixture");
  mkdirSync(join(deepRepo, ".git"));
  let mounts = { mounts: [], incomplete: false };
  const events = []; const calls = []; const children = [];
  const coordinator = new FileSearchCoordinator({ basePath: alias, home: root, repoDepth: 4,
    enableIndex: false, readMountInfo: () => mounts,
    spawn(command, args, options) {
      calls.push({ command, args });
      const child = spawn(command, args, options);
      children.push({ child, closed: once(child, "close") });
      return child;
    }, emit: event => events.push(event) });
  try {
    coordinator.request({ id: 1, query: "needle" });
    await until(() => events.find(event => event.id === 1 && event.complete && event.repoComplete));
    assert.ok(events.at(-1).rows.some(row => row.path === wanted), "NUL realpath preserves final newline");
    mounts = { mounts: [{ id: "2", mountPoint: mount }], incomplete: false };
    coordinator.request({ id: 2, query: "needle" });
    const complete = await until(() => events.find(event => event.id === 2 && event.complete && event.repoComplete));
    assert.ok(calls.some(call => call.command === "fd" && call.args.at(-1) === mount), "new query refreshes mount partitions");
    assert.ok(complete.repos.some(row => row.path === shallowRepo), ".git files are repositories");
    assert.ok(!complete.repos.some(row => row.path === deepRepo), "mount does not reset repository depth budget");
  } finally {
    await coordinator.close();
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
    rmSync(owned, { recursive: true, force: true });
  }
});

test("bounded top results admit late best matches independent of source record order", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-rank-"));
  const best = join(root, "needle.txt");
  const weak = Array.from({ length: 9 }, (_, i) => join(root, "needle-folder", `weak-${i}.txt`));
  async function run(records) {
    const events = []; const children = [];
    const coordinator = new FileSearchCoordinator({ basePath: root, home: root, enableIndex: false,
      mountInfo: { mounts: [], incomplete: false }, maxResults: 2, maxEvidence: 3,
      spawn(command, args, options) {
        assert.equal(command, "fd");
        const output = args.includes("^\\.git$") ? "" : records.join("\0") + "\0";
        const child = spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(output)})`], options);
        children.push({ child, closed: once(child, "close") });
        return child;
      }, emit: event => events.push(event) });
    try {
      coordinator.request({ id: 1, query: "needle" });
      await until(() => children.length >= 2 && children.every(({ child }) => child.exitCode !== null || child.signalCode !== null));
      await delay(50);
      const result = events.at(-1);
      assert.equal(result.rows[0]?.path, best, "late literal filename outranks earlier directory-only matches");
      assert.equal(result.capped, true);
      assert.ok(result.totalMatched >= 3 && result.totalMatched <= 10, "reported count is observed/saturated, not invented");
      return result.rows.map(row => row.path);
    } finally {
      await coordinator.close();
      for (const { child, closed } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      }
    }
  }
  try { assert.deepEqual(await run([...weak, best]), await run([best, ...weak])); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("stale positive accelerator does not suppress fresh traversal and ordinary search rejects unrelated index rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-index-union-"));
  const stale = join(root, "needle-index.txt");
  const fresh = join(root, "needle-fresh.txt");
  const irrelevant = join(root, "unrelated.txt");
  for (const path of [stale, fresh, irrelevant]) writeFileSync(path, "fixture");
  const events = []; const children = []; let indexReplies = 0;
  const coordinator = new FileSearchCoordinator({ basePath: root, home: root,
    mountInfo: { mounts: [], incomplete: false },
    spawn(command, args, options) {
      const worker = command === process.execPath;
      const child = worker ? spawn(process.execPath, ["-e", `
        process.stdout.write(JSON.stringify({type:'ready',available:true})+'\\n');
        require('node:readline').createInterface({input:process.stdin}).on('line', line => {
          const msg = JSON.parse(line);
          process.stdout.write(JSON.stringify({token:msg.token,available:true,rows:
            process.env.ASK_FILE_INDEX_MODE === 'plocate' ? [] : ${JSON.stringify([stale, irrelevant])}})+'\\n');
        });
      `], options) : spawn(command, args, options);
      if (worker && options.env.ASK_FILE_INDEX_MODE !== "plocate")
        child.stdout.on("data", chunk => { if (chunk.toString().includes('"token":')) indexReplies++; });
      children.push({ child, closed: once(child, "close") });
      return child;
    }, emit: event => events.push(event) });
  try {
    coordinator.request({ id: 1, query: "needle" });
    await until(() => events.some(event => event.rows?.some(row => row.path === fresh)));
    await until(() => indexReplies > 0);
    await delay(50);
    const result = events.at(-1);
    assert.deepEqual(new Set(result.rows.map(row => row.path)), new Set([stale, fresh]));
    assert.equal(result.totalMatched, 2, "index and fd duplicates count once");
    assert.equal(result.capped, false);
  } finally {
    await coordinator.close();
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("TERM-ignoring optional workers neither delay local delivery nor survive coordinator shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-index-stall-"));
  const wanted = join(root, "needle.txt");
  writeFileSync(wanted, "fixture");
  const events = []; const children = []; const workers = [];
  const coordinator = new FileSearchCoordinator({ basePath: root, home: root,
    mountInfo: { mounts: [], incomplete: false },
    spawn(command, args, options) {
      const worker = command === process.execPath;
      const child = worker ? spawn(process.execPath, ["-e", `
        process.on('SIGTERM', () => {}); process.stdin.resume();
        setInterval(() => {},1000);
      `], options) : spawn(command, args, options);
      const owned = { child, closed: once(child, "close") };
      children.push(owned); if (worker) workers.push(owned);
      return child;
    }, emit: event => events.push(event) });
  try {
    coordinator.request({ id: 1, query: "needle", focused: true });
    const early = await until(() => events.find(event => event.rows?.some(row => row.path === wanted)));
    assert.equal(early.complete, false, "hung fuzzy source cannot assert exhaustive coverage");
    await delay(100);
    assert.equal(workers.length, 2, "both optional source boundaries exercised");
    await coordinator.close();
    await until(() => workers.every(({ child }) => child.exitCode !== null || child.signalCode !== null), 800);
  } finally {
    await coordinator.close();
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("metadata timeout is not child exit and cannot release an unexited helper's global slot", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-meta-stall-"));
  writeFileSync(join(root, "needle.txt"), "fixture");
  const helpers = []; const scans = []; const events = [];
  const coordinator = new FileSearchCoordinator({ basePath: root, home: root, enableIndex: false,
    mountInfo: { mounts: [], incomplete: false },
    metadataSpawn() {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => true; child.exitCode = null; child.signalCode = null;
      helpers.push(child); return child;
    },
    spawn(command, args, options) {
      const child = spawn(command, args, options);
      scans.push({ child, closed: once(child, "close") }); return child;
    }, emit: event => events.push(event) });
  try {
    for (let id = 1; id <= 8; id++) coordinator.request({ id, query: "needle" });
    await until(() => events.some(event => event.id === 8 && event.rows?.length), 2200);
    await delay(1600);
    for (let id = 9; id <= 16; id++) coordinator.request({ id, query: "needle" });
    await until(() => events.some(event => event.id === 16 && event.rows?.length), 2200);
    assert.ok(helpers.length <= 4, `all-generation helper ceiling respected (${helpers.length} spawned)`);
    assert.ok(events.filter(event => event.rows?.length).every(event => !event.complete),
      "unresolved root fallback remains incomplete");
  } finally {
    for (const child of helpers) {
      child.signalCode = "SIGKILL"; child.emit("close", null, "SIGKILL");
      child.stdout.destroy(); child.stderr.destroy();
    }
    await coordinator.close();
    for (const { child, closed } of scans) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("one cold focused query receives native fuzzy results after the index becomes ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-native-fuzzy-"));
  const wanted = join(root, "screenshot-native-fixture.png");
  writeFileSync(wanted, "fixture");
  const events = []; const children = [];
  const coordinator = new FileSearchCoordinator({ basePath: root, home: root,
    mountInfo: { mounts: [], incomplete: false },
    spawn(command, args, options) {
      const child = spawn(command, args, { ...options, env: { ...(options.env || process.env),
        HOME: root, XDG_CONFIG_HOME: join(root, ".config"), XDG_CACHE_HOME: join(root, ".cache"),
        XDG_DATA_HOME: join(root, ".local/share"), XDG_STATE_HOME: join(root, ".local/state") } });
      children.push({ child, closed: once(child, "close") }); return child;
    }, emit: event => events.push(event) });
  try {
    // Deliberately not a literal substring, so fresh fd cannot satisfy this
    // gate. No second keystroke/query may be needed to unblock initial FFF.
    coordinator.request({ id: 1, query: "screnshot", focused: true });
    await until(() => events.some(event => event.rows?.some(row => row.path === wanted)), 5000);
  } finally {
    await coordinator.close();
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("real bridge stdin disconnect closes its TERM-ignoring owned scan processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-bridge-eof-"));
  const bin = join(root, "bin"); mkdirSync(bin);
  const log = join(root, "children.jsonl");
  const fixture = `#!${process.execPath}
    const fs = require('node:fs');
    const stat = fs.readFileSync('/proc/self/stat','utf8');
    const ticks = stat.slice(stat.lastIndexOf(')')+2).trim().split(/\\s+/)[19];
    process.on('SIGTERM',()=>{});
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid,ticks})+'\\n');
    process.stdout.write(${JSON.stringify(join(root, "needle.txt") + "\0")});
    setInterval(()=>{},1000);
  `;
  writeFileSync(join(bin, "fd"), fixture, { mode: 0o700 });
  function sameIdentity(identity) {
    assert.ok(Number.isInteger(identity.pid) && identity.pid > 1 && /^\d+$/.test(identity.ticks));
    try {
      const stat = readFileSync(`/proc/${identity.pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      return fields[19] === identity.ticks && fields[0] !== "Z";
    } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }
  const bridge = spawn(process.execPath, [fileURLToPath(new URL("../bridge/files.js", import.meta.url))], {
    env: { ...process.env, HOME: root, ASK_FILE_ROOT: root, ASK_DISABLE_FILE_INDEX: "1",
      XDG_CONFIG_HOME: join(root, ".config"), PATH: `${bin}:${process.env.PATH}` },
    stdio: ["pipe", "pipe", "pipe"], detached: true,
  });
  const closed = once(bridge, "close");
  bridge.stdout.resume(); bridge.stderr.resume();
  let identities = [];
  try {
    bridge.stdin.write(JSON.stringify({ id: 1, query: "needle" }) + "\n");
    await until(() => {
      if (!existsSync(log)) return false;
      const lines = readFileSync(log, "utf8").trim().split("\n");
      if (lines.length < 2) return false;
      identities = lines.map(line => JSON.parse(line)); return true;
    });
    bridge.stdin.end();
    const exited = await Promise.race([closed.then(() => true), delay(2200, false, { ref: false })]);
    assert.equal(exited, true, "protocol EOF must trigger bounded bridge teardown");
    await until(() => identities.every(identity => !sameIdentity(identity)), 700);
  } finally {
    // Backup cleanup is not acceptance. Signals are limited to recorded
    // fixture identities and this directly owned bridge, never a name sweep.
    if (identities.length === 0 && existsSync(log))
      identities = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    for (const identity of identities) if (sameIdentity(identity)) {
      try { process.kill(-identity.pid, "SIGKILL"); }
      catch (error) {
        if (error.code !== "ESRCH") throw error;
        if (sameIdentity(identity)) {
          try { process.kill(identity.pid, "SIGKILL"); }
          catch (directError) { if (directError.code !== "ESRCH") throw directError; }
        }
      }
    }
    if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill("SIGKILL");
    await closed;
    await until(() => identities.every(identity => !sameIdentity(identity)), 1000);
    rmSync(root, { recursive: true, force: true });
  }
});

async function until(predicate, milliseconds = 1000) {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await delay(5);
  }
  throw new Error(`condition did not become true within ${milliseconds} ms`);
}

async function sourceResult(script, limits = {}) {
  const records = [];
  let child;
  let closed;
  let terminal;
  const finished = new Promise(resolve => { terminal = resolve; });
  const source = new StreamSource({
    id: "acceptance", kind: "local", command: process.execPath,
    args: ["-e", script], timeoutMs: 1000,
    spawn(command, args, options) {
      child = spawn(command, args, options);
      closed = once(child, "close").catch(() => undefined);
      return child;
    },
    onRecord: record => records.push(record), onTerminal: terminal, ...limits,
  });
  source.start();
  try {
    const result = await Promise.race([finished,
      delay(3000, null, { ref: false }).then(() => { throw new Error("source did not terminate within budget"); })]);
    const childExitedByCleanupGrace = await Promise.race([
      closed.then(() => true), delay(700, false, { ref: false }),
    ]);
    return { result, records, childExitedByCleanupGrace };
  } finally {
    // Only this fixture's directly owned child. This is backup test cleanup,
    // not proof that production cancellation succeeded.
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (closed) await closed;
  }
}

test("production reader keeps NUL-complete records across chunks and newline names", async () => {
  const { result, records } = await sourceResult(`
    process.stdout.write('/scope/first');
    setTimeout(() => process.stdout.write('.png\\0/scope/line\\nbreak.png\\0'), 30);
  `);
  assert.deepEqual(records, ["/scope/first.png", "/scope/line\nbreak.png"]);
  assert.equal(result.status, "exhausted");
});

test("truncated final record is neither a path nor exhaustive success", async () => {
  const { result, records } = await sourceResult("process.stdout.write('/scope/ok.png\\0/scope/unfinished')");
  assert.deepEqual(records, ["/scope/ok.png"]);
  assert.notEqual(result.status, "exhausted");
});

test("nonzero exit retains completed paths without claiming exhaustive success", async () => {
  const { result, records } = await sourceResult(`
    process.stdout.write('/scope/found.txt\\0', () => process.exit(17));
  `);
  assert.deepEqual(records, ["/scope/found.txt"]);
  assert.notEqual(result.status, "exhausted");
  assert.notEqual(result.status, "capped");
});

test("output overflow retains prior records but is not evidence of omitted matches", async () => {
  const { result, records } = await sourceResult(`
    process.stdout.write('/scope/ok.png\\0');
    setTimeout(() => process.stdout.write('x'.repeat(8192)), 30);
    setInterval(() => {}, 1000);
  `, { maxStdoutBytes: 1024, maxRecordBytes: 128 });
  assert.deepEqual(records, ["/scope/ok.png"]);
  assert.notEqual(result.status, "exhausted");
  assert.notEqual(result.status, "capped", "byte overflow does not prove another valid match exists");
});

test("overflow in one chunk still retains the complete in-budget prefix", async () => {
  const { result, records } = await sourceResult(`
    process.stdout.write('/scope/prefix.png\\0' + 'x'.repeat(8192));
    setInterval(() => {}, 1000);
  `, { maxStdoutBytes: 1024, maxRecordBytes: 128 });
  assert.deepEqual(records, ["/scope/prefix.png"]);
  assert.notEqual(result.status, "exhausted");
  assert.notEqual(result.status, "capped");
});

test("timeout owns escalation and observes child exit even when TERM is ignored", async () => {
  const { result, childExitedByCleanupGrace } = await sourceResult(`
    process.on('SIGTERM', () => {});
    process.stdout.write('/scope/ok.png\\0');
    setInterval(() => {}, 1000);
  `, { timeoutMs: 150 });
  assert.notEqual(result.status, "exhausted");
  assert.equal(childExitedByCleanupGrace, true,
    "production source must reap its child without the fixture's backup cleanup");
});

test("partition planner retains nested bind mounts and prunes only exact subtrees", () => {
  const mountInfo = [
    "1 0 8:1 / / rw - ext4 /dev/root rw",
    "2 1 0:45 / /scope/remote\\040files rw - fuse.rclone remote rw",
    "3 2 0:45 /other /scope/remote\\040files/nested rw - fuse.rclone remote rw",
    "4 1 8:1 /bind /scope/bind rw - ext4 /dev/root rw",
    "5 1 0:46 / /scope/.cache/remote rw - fuse.rclone excluded rw",
    "6 1 0:47 / /scope-other rw - fuse.rclone outside rw",
  ].join("\n") + "\n";
  const plan = planPartitions("/scope", mountInfo);
  assert.equal(plan.incomplete, false);
  assert.deepEqual(plan.partitions.map(item => item.root).sort(),
    ["/scope", "/scope/bind", "/scope/remote files", "/scope/remote files/nested"].sort());
  const remote = plan.partitions.find(item => item.root === "/scope/remote files");
  assert.deepEqual(remote.prunedMounts, ["/scope/remote files/nested"]);
});

test("empty or truncated mount metadata never claims complete scope", () => {
  assert.equal(planPartitions("/scope", "").incomplete, true);
  assert.equal(planPartitions("/scope", "not mountinfo\n").incomplete, true);
  assert.equal(parseMountInfo("1 0 8:1 / / rw - ext4 disk rw\n", { maxBytes: 10 }).incomplete, true);
});

test("missing scan executable is an unavailable source, not an empty complete search", async () => {
  const { result, records } = await sourceResult("", { command: "/not-an-installed-ask-fd", args: [] });
  assert.deepEqual(records, []);
  assert.notEqual(result.status, "exhausted");
  assert.notEqual(result.status, "capped");
});

test("real local fd publishes before stalled mounted file/repo scans finish, then unions late matches", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-stream-accept-"));
  const local = join(root, "ArbitraryFolder");
  const mount = join(root, "r[1]");
  mkdirSync(local);
  mkdirSync(mount);
  const localFile = join(local, "needle-local.png");
  const remoteFile = join(mount, "needle-remote.png");
  writeFileSync(localFile, "local fixture");
  writeFileSync(remoteFile, "remote fixture");
  const localRepo = join(local, "needle-repo");
  const remoteRepo = join(mount, "needle-repo");
  const decoyRepo = join(local, "unrelated-repo");
  for (const path of [localRepo, remoteRepo, decoyRepo]) mkdirSync(join(path, ".git"), { recursive: true });
  const processLog = join(root, "processes.jsonl");
  const readyFile = join(root, "mount-emitted");
  const settingsPath = join(root, "fixture-plan.json");
  const extraMounts = Array.from({ length: 4 }, (_, index) => join(root, `slow-${index}`));
  extraMounts.forEach(path => mkdirSync(path));
  writeFileSync(settingsPath, JSON.stringify({ processLog, slowSources: [{
    root: mount, filePath: remoteFile, repoPath: join(remoteRepo, ".git"), delayMs: 500, readyFile,
  }, ...extraMounts.map(path => ({ root: path }))] }));
  const snapshots = [];
  const children = [];
  let activeScans = 0;
  let peakScans = 0;
  const coordinator = new FileSearchCoordinator({
    basePath: root, home: root, enableIndex: false, sourceTimeoutMs: 2500,
    mountInfo: `1 0 8:1 / / rw - ext4 disk rw\n2 1 0:99 / ${mount} rw - fuse.rclone fixture rw\n`
      + extraMounts.map((path, index) => `${index + 3} 1 0:${index + 100} / ${path} rw - fuse.rclone fixture rw\n`).join(""),
    spawn(command, args, options) {
      const child = command === "fd"
        ? spawn(process.execPath, [fileURLToPath(new URL("./streaming-fd-fixture.mjs", import.meta.url)), ...args],
          { ...options, env: { ...process.env, ASK_TEST_STREAM_PLAN: settingsPath } })
        : spawn(command, args, options);
      children.push({ child, closed: once(child, "close") });
      if (command === "fd") {
        activeScans++;
        peakScans = Math.max(peakScans, activeScans);
        child.once("close", () => activeScans--);
      }
      return child;
    },
    emit: event => snapshots.push({ ...event, at: performance.now() }),
  });
  try {
    const started = performance.now();
    coordinator.request({ id: 1, query: "needle", focused: false });
    const early = await until(() => snapshots.find(snapshot => snapshot.rows?.some(row => row.path === localFile)));
    assert.ok(early.at - started < 1000, "arbitrary local folder result arrives within one second");
    assert.equal(existsSync(readyFile), false, "local result precedes mounted source's first record");
    assert.equal(early.rows.some(row => row.path === remoteFile), false,
      "base scan actually prunes glob-sensitive mounted subtree");
    assert.equal(early.complete, false);
    await until(() => snapshots.some(snapshot => snapshot.repos?.some(row => row.path === localRepo)), 800);
    const combined = await until(() => snapshots.find(snapshot =>
      snapshot.rows?.some(row => row.path === localFile)
      && snapshot.rows?.some(row => row.path === remoteFile)), 1500);
    assert.equal(combined.complete, false, "mounted source remains alive after its record");
    await until(() => snapshots.some(snapshot => snapshot.repos?.some(row => row.path === localRepo)
      && snapshot.repos?.some(row => row.path === remoteRepo)), 4000);
    assert.ok(snapshots.every(snapshot => !snapshot.repos?.some(row => row.path === decoyRepo)),
      "repository source is filtered by the user's query");
    const log = readFileSync(processLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(log.some(entry => entry.root === mount), "mounted scope was searched, not dropped");
    coordinator.request({ id: 1, query: "replacement", focused: false });
    coordinator.request({ id: 1, query: "replacement-two", focused: false });
    coordinator.request({ id: 1, query: "replacement-three", focused: false });
    const boundary = snapshots.length;
    await delay(150);
    assert.ok(snapshots.slice(boundary).every(snapshot => snapshot.query === "replacement-three"),
      "reused public ID never accepts the old generation");
    assert.ok(peakScans <= 6, `global scan bound held across replacement (peak ${peakScans})`);
    await coordinator.close();
    await until(() => children.every(({ child }) => child.exitCode !== null || child.signalCode !== null), 1000);
  } finally {
    await coordinator.close();
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("negative control: prior buffered fallback holds a collected file until its timeout", {
  skip: !process.env.ASK_BUFFERED_BASELINE && "requires preserved pre-change source",
}, async () => {
  const source = readFileSync(process.env.ASK_BUFFERED_BASELINE, "utf8");
  const roots = source.slice(source.indexOf("const priorityFileRoots ="), source.indexOf("const settingsPath ="));
  const implementation = source.slice(source.indexOf("async function fallbackFiles("), source.indexOf("async function search("));
  assert.ok(implementation.includes("execFileAsync"), "control is the actual preserved implementation");
  const root = mkdtempSync(join(tmpdir(), "ask-stream-old-"));
  const path = join(root, "needle-local.png");
  const ready = join(root, "record-written");
  writeFileSync(path, "fixture");
  const execute = promisify(execFile);
  const fallback = new Function("basePath", "home", "searchRoots", "execFileAsync", "existsSync", "statSync",
    "basename", "relative", "resolve", "join", `${roots}\n${implementation}\nreturn fallbackFiles;`)(
      root, root, [root], async (command) => {
        if (command === "plocate") return { stdout: "" };
        return execute(process.execPath, ["-e", `
          require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');
          process.stdout.write(${JSON.stringify(path + "\n")});
          setInterval(() => {}, 1000);
        `], { timeout: 1300, maxBuffer: 65536 });
      }, existsSync, statSync, basename, relative, resolve, join);
  try {
    let delivered = false;
    const result = fallback("needle").then(value => { delivered = true; return value; });
    await until(() => existsSync(ready));
    await delay(600);
    assert.equal(delivered, false, "old code has bytes but does not deliver them");
    const completed = await result;
    assert.deepEqual(completed.rows.map(row => row.path), [path]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unexited canceled mount cannot hold the next local query behind its reap barrier", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-stuck-mount-"));
  const mount = join(root, "stalled");
  mkdirSync(mount);
  writeFileSync(join(root, "before.txt"), "fixture");
  const wanted = join(root, "after.txt");
  writeFileSync(wanted, "fixture");
  const snapshots = [];
  const stuckChildren = [];
  const realChildren = [];
  const coordinator = new FileSearchCoordinator({
    basePath: root, home: root, enableIndex: false, sourceTimeoutMs: 4000,
    mountInfo: `1 0 8:1 / / rw - ext4 disk rw\n2 1 0:99 / ${mount} rw - fuse.rclone fixture rw\n`,
    spawn(command, args, options) {
      if (command === "fd" && args.at(-1) === mount) {
        // Simulate a child awaiting kernel IO: cancellation requests do not
        // establish exit. No real unkillable process is created by this gate.
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.kill = () => true;
        child.exitCode = null; child.signalCode = null;
        stuckChildren.push(child);
        return child;
      }
      const child = spawn(command, args, options);
      realChildren.push({ child, closed: once(child, "close") });
      return child;
    },
    emit: value => snapshots.push(value),
  });
  try {
    coordinator.request({ id: 1, query: "before", focused: false });
    await until(() => snapshots.some(value => value.rows?.some(row => row.name === "before.txt")));
    assert.ok(stuckChildren.length > 0, "mounted IO really is still unexited");
    coordinator.request({ id: 2, query: "after", focused: false });
    await until(() => snapshots.some(value => value.id === 2 && value.rows?.some(row => row.path === wanted)));
    assert.ok(stuckChildren.some(child => child.exitCode === null), "local result does not depend on mount exit");
    for (const id of [3, 4]) {
      coordinator.request({ id, query: "after", focused: false });
      await until(() => snapshots.some(value => value.id === id && value.rows?.some(row => row.path === wanted)));
    }
    assert.ok(stuckChildren.length <= 4,
      "unexited mounted children continue occupying their global lane slots across queries");
  } finally {
    // Release simulated children before closing; this does not make the
    // latency assertion above pass if the coordinator serialized on them.
    for (const child of stuckChildren) {
      child.signalCode = "SIGKILL";
      child.emit("close", null, "SIGKILL");
      child.stdout.destroy(); child.stderr.destroy();
    }
    await coordinator.close();
    for (const { child, closed } of realChildren) {
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
