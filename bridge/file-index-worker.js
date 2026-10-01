#!/usr/bin/env node

// Optional accelerators live in this child process. Native initialization,
// fuzzy search, plocate, and candidate validation stay away from the
// coordinator's event loop.
import { FileFinder } from "@ff-labs/fff-node";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";

const MAX_ROWS = 180;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
const PLOCATE_TIMEOUT_MS = 1_200;
const root = resolve(process.env.ASK_FILE_ROOT || process.env.HOME || process.cwd());
const mode = process.env.ASK_FILE_INDEX_MODE || "fff";
let finder = null;
let ready = false;
let startupFinished = false;
let warmingMessage = null;
let activePlocate = null;
let queuedPlocate = null;
let shuttingDown = false;

function write(value) {
  try { process.stdout.write(`${JSON.stringify(value)}\n`); } catch { shutdown(); }
}

function reply(message, payload = {}) {
  const value = JSON.stringify({ token: message.token, ...payload });
  if (Buffer.byteLength(value) > MAX_REPLY_BYTES) {
    write({ token: message.token, rows: [], available: false, truncated: true });
    return;
  }
  try { process.stdout.write(`${value}\n`); } catch { shutdown(); }
}

function announceReady(available) { write({ type: "ready", available }); }

function inside(path) {
  const value = resolve(path);
  return value === root || (root === "/" ? value.startsWith("/") : value.startsWith(`${root}/`));
}

function validate(path) {
  if (!path || !inside(path)) return null;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    return { path: resolve(path), modifiedMs: stat.mtimeMs };
  } catch { return null; }
}

function startFff() {
  try {
    const created = FileFinder.create({ basePath: root, aiMode: false, disableMmapCache: true,
      disableContentIndexing: true, enableHomeDirScanning: root === resolve(process.env.HOME || process.cwd()) });
    finder = created.ok ? created.value : null;
  } catch { finder = null; }
  if (!finder) { startupFinished = true; announceReady(false); return; }
  Promise.resolve(finder.waitForScan(30_000)).then((result) => {
    ready = Boolean(result && result.ok && result.value !== false);
    startupFinished = true; announceReady(ready);
    if (ready && warmingMessage) {
      const message = warmingMessage; warmingMessage = null; runFff(message);
    }
  }).catch(() => { startupFinished = true; announceReady(false); });
}

function runFff(message) {
  let rows = []; let capped = false;
  try {
    const result = finder.fileSearch(String(message.query || ""), { pageSize: MAX_ROWS });
    if (!result.ok) { reply(message, { rows: [], available: false }); return; }
    capped = Number(result.value.totalMatched || 0) > result.value.items.length;
    rows = result.value.items.map((item, index) => {
      const path = resolve(root, item.relativePath);
      const score = result.value.scores?.[index] || {};
      const metadata = validate(path);
      if (!metadata) return null;
      return {
        ...metadata,
        path, name: item.fileName || basename(path),
        score: { total: Number(score.total) || 0, baseScore: Number(score.baseScore) || 0,
          filenameBonus: Number(score.filenameBonus) || 0,
          exactMatch: score.exactMatch === true, matchType: String(score.matchType || "fuzzy") },
      };
    }).filter(Boolean);
  } catch { reply(message, { rows: [], available: false }); return; }
  reply(message, { rows: rows.slice(0, MAX_ROWS), available: true, capped });
}

function terminatePlocate(state, reason) {
  if (!state || state.closed) return;
  if (reason) state.stopReason = reason;
  try { state.child.kill("SIGTERM"); } catch {}
  if (!state.killTimer) state.killTimer = setTimeout(() => {
    if (!state.closed) { try { state.child.kill("SIGKILL"); } catch {} }
  }, 250);
}

function finishPlocate(state, code, signal) {
  if (state.closed) return;
  state.closed = true;
  if (state.timer) clearTimeout(state.timer);
  if (state.killTimer) clearTimeout(state.killTimer);
  if (activePlocate === state) activePlocate = null;
  if (!state.canceled) {
    const incompleteRecord = state.buffer.length > 0 || state.discardUntilNul;
    if (state.stopReason === "capped") {
      reply(state.message, { rows: state.rows, available: true, capped: true });
    } else if (state.stopReason === "timeout") {
      reply(state.message, { rows: state.rows, available: false });
    } else if (state.overflow || incompleteRecord || state.failed || code !== 0) {
      reply(state.message, { rows: state.rows, available: false,
        truncated: state.overflow || incompleteRecord });
    } else {
      reply(state.message, { rows: state.rows, available: true, capped: state.omitted });
    }
  }
  if (queuedPlocate && !shuttingDown) {
    const next = queuedPlocate; queuedPlocate = null; startPlocate(next);
  }
}

function consumePlocate(state, chunk) {
  if (state.closed || state.stopReason) return;
  const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const room = MAX_REPLY_BYTES - state.bytes;
  const accepted = room > 0 ? data.subarray(0, room) : Buffer.alloc(0);
  state.bytes += accepted.length;
  if (accepted.length > 0) state.buffer = Buffer.concat([state.buffer, accepted]);
  while (!state.stopReason) {
    if (state.discardUntilNul) {
      const boundary = state.buffer.indexOf(0);
      if (boundary < 0) { state.buffer = Buffer.alloc(0); break; }
      state.buffer = state.buffer.subarray(boundary + 1); state.discardUntilNul = false;
    }
    const end = state.buffer.indexOf(0);
    if (end < 0) {
      if (state.buffer.length > MAX_RECORD_BYTES) {
        state.overflow = true; state.discardUntilNul = true; state.buffer = Buffer.alloc(0);
        terminatePlocate(state, "overflow");
      }
      break;
    }
    const record = state.buffer.subarray(0, end); state.buffer = state.buffer.subarray(end + 1);
    if (record.length === 0) continue;
    if (record.length > MAX_RECORD_BYTES) {
      state.overflow = true; state.discardUntilNul = true;
      terminatePlocate(state, "overflow"); break;
    }
    const item = validate(record.toString("utf8"));
    if (!item || state.seen.has(item.path)) continue;
    state.seen.add(item.path);
    if (state.rows.length < MAX_ROWS) state.rows.push(item);
    else {
      state.omitted = true;
      terminatePlocate(state, "capped");
    }
  }
  if (accepted.length !== data.length && !state.stopReason) {
    state.overflow = true; terminatePlocate(state, "overflow");
  }
}

function startPlocate(message) {
  if (shuttingDown) return;
  let child;
  try {
    // The worker itself is a process-group leader owned by the coordinator.
    // Keeping plocate non-detached makes the descendant part of that group.
    child = spawn("plocate", ["--null", "--ignore-case", "--", String(message.query || "")], {
      stdio: ["ignore", "pipe", "ignore"], detached: false,
    });
  } catch { reply(message, { rows: [], available: false }); return; }
  const state = { message, child, rows: [], seen: new Set(), buffer: Buffer.alloc(0),
    bytes: 0, overflow: false, omitted: false, discardUntilNul: false, stopReason: "",
    failed: false, canceled: false, closed: false, timer: null, killTimer: null };
  activePlocate = state;
  child.stdout?.on("data", (chunk) => consumePlocate(state, chunk));
  child.stdout?.on("error", () => { state.failed = true; terminatePlocate(state, "failed"); });
  child.once("error", () => { state.failed = true; terminatePlocate(state, "failed"); });
  child.once("close", (code, signal) => finishPlocate(state, code, signal));
  if (!child.stdout) { state.failed = true; terminatePlocate(state, "failed"); }
  state.timer = setTimeout(() => terminatePlocate(state, "timeout"), PLOCATE_TIMEOUT_MS);
}

function queuePlocate(message) {
  if (!activePlocate) { startPlocate(message); return; }
  queuedPlocate = message;
  activePlocate.canceled = true;
  terminatePlocate(activePlocate, "replaced");
}

if (mode === "plocate") announceReady(true);
else startFff();

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (!message || !message.token) return;
  if (mode === "plocate") { queuePlocate(message); return; }
  if (!startupFinished || !ready) { warmingMessage = message; return; }
  runFff(message);
});

let shutdownPromise = null;
function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true; queuedPlocate = null;
  let resolveShutdown;
  shutdownPromise = new Promise((resolve) => { resolveShutdown = resolve; });
  input.close();
  const shutdownWork = new Promise((resolveWork) => {
    const state = activePlocate;
    if (!state) { resolveWork(); return; }
    state.canceled = true; terminatePlocate(state, "shutdown");
    // The coordinator gives the worker process group 250 ms after TERM. Reap
    // a TERM-ignoring descendant before that outer deadline can kill the
    // worker itself and take away its opportunity to observe child close.
    setTimeout(() => {
      if (!state.closed) { try { state.child.kill("SIGKILL"); } catch {} }
    }, 100);
    Promise.race([
      new Promise((resolveClose) => state.child.once("close", resolveClose)),
      new Promise((resolveWait) => setTimeout(resolveWait, 600)),
    ]).then(resolveWork);
  }).finally(() => {
    try { finder?.destroy(); } catch {}
    resolveShutdown();
    process.exit(0);
  });
  void shutdownWork;
  return shutdownPromise;
}
process.stdout.on("error", shutdown);
input.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
