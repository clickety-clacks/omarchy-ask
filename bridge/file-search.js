#!/usr/bin/env node

/*
 * Production file-search coordinator.  The JSON-lines adapter is deliberately
 * tiny; this module owns opaque generations, source lifecycle, bounded stream
 * readers, mount partitioning, and aggregate snapshots.  Process and
 * mount-info seams are public so adversarial sources can be exercised through
 * the production implementation.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_MAX_EVIDENCE = 180;
const DEFAULT_MAX_RECORD_BYTES = 64 * 1024;
const DEFAULT_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_MAX_CONCURRENT = 6;
const DEFAULT_LOCAL_CONCURRENT = 2;
const DEFAULT_MOUNTED_CONCURRENT = 4;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_INDEX_TIMEOUT_MS = 2_000;
const DEFAULT_HELPER_TIMEOUT_MS = 1_200;
const EXCLUDED_DIRS = [".cache", "node_modules"];
const MAX_MOUNTINFO_BYTES = 4 * 1024 * 1024;

// The file scanner enriches fd records inside its owned process group. Never
// stat a result on the coordinator thread: it may live on a stalled mount.
export function spawnSearchProcess(command, args, options = {}) {
  const { fileMetadata, ...childOptions } = options;
  return fileMetadata
    ? nodeSpawn(process.execPath, [new URL("./file-scan-worker.js", import.meta.url).pathname, ...args], childOptions)
    : nodeSpawn(command, args, childOptions);
}

function modifiedTime(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compareFiles(a, b, request, rows = request.rows) {
  const left = modifiedTime(rows.get(a));
  const right = modifiedTime(rows.get(b));
  if (left !== right) {
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left;
  }
  return comparePaths(a, b, request.query, request.indexScores, request.scopeRoot);
}

function lexicalInside(root, candidate) {
  const base = resolve(root);
  const value = resolve(candidate);
  return value === base || (base === sep ? value.startsWith(sep) : value.startsWith(`${base}${sep}`));
}

function decodeMountField(value) {
  return String(value || "").replace(/\\([0-7]{3})/g, (_, octal) => {
    const code = Number.parseInt(octal, 8);
    return Number.isFinite(code) ? String.fromCharCode(code) : `\\${octal}`;
  });
}

function splitMountInfoLine(line) {
  const fields = String(line || "").trim().split(" ");
  const separator = fields.indexOf("-");
  if (separator < 6 || separator + 1 >= fields.length) return null;
  const mountPoint = decodeMountField(fields[4]);
  if (!mountPoint.startsWith("/")) return null;
  return {
    id: fields[0], parent: fields[1], device: fields[2],
    root: decodeMountField(fields[3]), mountPoint,
    filesystem: fields[separator + 1],
  };
}

export function parseMountInfo(text, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const raw = Buffer.from(String(text || ""), "utf8");
  const truncated = raw.length > maxBytes;
  const bounded = (truncated ? raw.subarray(0, maxBytes) : raw).toString("utf8");
  const mounts = [];
  let malformed = truncated || bounded.trim() === "";
  for (const line of bounded.split("\n")) {
    if (!line.trim()) continue;
    const parsed = splitMountInfoLine(line);
    if (!parsed) { malformed = true; continue; }
    mounts.push(parsed);
  }
  return { mounts, incomplete: malformed };
}

function excludedPath(path, root, exclusions = EXCLUDED_DIRS) {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`)) return true;
  return rel.split(sep).filter(Boolean).some((part) => exclusions.includes(part));
}

function fdEscape(value) {
  return String(value).replace(/[\\*?\[\]{}()|+.^$]/g, "\\$&");
}

function globEscape(value) {
  return String(value).replace(/[\\*?\[\]{}]/g, "\\$&");
}

function queryPattern(query) {
  const terms = String(query || "").trim().split(/\s+/).filter(Boolean);
  // Traversal is a candidate generator. Searching the longest literal term is
  // a bounded-output heuristic and a safe superset of the established
  // all-terms-in-any-order match applied before aggregation.
  terms.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return terms.length > 0 ? fdEscape(terms[0]) : "";
}

function scopedQueryPattern(scopeRoot, query) {
  const root = resolve(scopeRoot);
  const prefix = root === sep ? fdEscape(sep) : `${fdEscape(root)}${fdEscape(sep)}`;
  // fd sees absolute paths because each partition root is absolute. Anchor the
  // expression after the canonical common scope so text in /home/user (or in
  // an arbitrary configured root) cannot make every descendant a match.
  return `(?s)^${prefix}.*${queryPattern(query)}`;
}

function mountDepth(root, mountPoint) {
  const value = relative(root, mountPoint);
  return !value || value === "." ? 0 : value.split(sep).filter(Boolean).length;
}

export function planPartitions(basePath, mountInfo, { excluded = EXCLUDED_DIRS } = {}) {
  const root = resolve(basePath);
  const parsed = typeof mountInfo === "string"
    ? parseMountInfo(mountInfo)
    : (mountInfo?.raw !== undefined
      ? { ...parseMountInfo(mountInfo.raw), incomplete: Boolean(mountInfo.truncated) || parseMountInfo(mountInfo.raw).incomplete }
      : (mountInfo || { mounts: [], incomplete: true }));
  const candidates = [];
  for (const mount of parsed.mounts || []) {
    const mountPoint = resolve(mount.mountPoint || "");
    if (!lexicalInside(root, mountPoint) || mountPoint === root) continue;
    if (excludedPath(mountPoint, root, excluded)) continue;
    candidates.push({ ...mount, mountPoint });
  }
  candidates.sort((a, b) => a.mountPoint.length - b.mountPoint.length
    || a.mountPoint.localeCompare(b.mountPoint));
  const uniqueCandidates = []; const seenMounts = new Set();
  for (const candidate of candidates) {
    if (seenMounts.has(candidate.mountPoint)) continue;
    seenMounts.add(candidate.mountPoint);
    uniqueCandidates.push(candidate);
  }
  const mounted = [];
  for (const candidate of uniqueCandidates.slice(0, 255)) {
    mounted.push({ id: `mount:${candidate.id || candidate.mountPoint}`, kind: "mounted",
      root: candidate.mountPoint, mountPoint: candidate.mountPoint,
      depth: mountDepth(root, candidate.mountPoint) });
  }
  // Every discovered mountpoint is pruned from every scheduled parent,
  // including mountpoints beyond the 255 scheduling ceiling. Otherwise the
  // base job could walk an omitted bind/rclone subtree while the result is
  // already marked incomplete.
  const children = uniqueCandidates.map((candidate) => candidate.mountPoint);
  return {
    root, incomplete: Boolean(parsed.incomplete || uniqueCandidates.length > 255),
    partitions: [{ id: "base", kind: "local", root, mountPoint: root, depth: 0 }, ...mounted]
      .map((partition) => ({ ...partition,
        oneFileSystem: Boolean(parsed.incomplete),
        prunedMounts: children.filter((path) => path !== partition.mountPoint
          && lexicalInside(partition.root, path)) })),
  };
}

function recordInsidePartition(root, value) {
  if (!value || value.includes("\0")) return false;
  const candidate = resolve(value);
  return lexicalInside(root, candidate) && !excludedPath(candidate, root);
}

function killOwnedProcess(child, signal = "SIGTERM") {
  if (!child) return;
  if (Number.isInteger(child.pid) && child.pid > 1) {
    try { process.kill(-child.pid, signal); } catch {}
  }
  try { child.kill?.(signal); } catch {}
}

function sourceCommand(partition, query, { repo = false, repoDepth = 0,
  scopeRoot = partition.root } = {}) {
  const args = ["--hidden", "--print0", "--threads", "2"];
  if (partition.oneFileSystem) args.push("--one-file-system");
  if (repo) {
    args.splice(1, 0, "--no-ignore");
    if (repoDepth > 0) args.push("--max-depth", String(repoDepth));
    args.push("--exclude", ".cache", "--exclude", "node_modules");
    for (const mount of partition.prunedMounts || []) {
      const rel = relative(partition.root, mount);
      if (rel && rel !== ".") args.push("--exclude", globEscape(rel));
    }
    args.push("^\\.git$", partition.root);
  } else {
    args.push("--type", "f", "--ignore-case", "--exclude", ".cache", "--exclude", "node_modules",
      "--full-path", scopedQueryPattern(scopeRoot, query));
    for (const mount of partition.prunedMounts || []) {
      const rel = relative(partition.root, mount);
      if (rel && rel !== ".") args.push("--exclude", globEscape(rel));
    }
    args.push(partition.root);
  }
  return { command: "fd", args };
}

export class StreamSource {
  constructor({ id, kind, command, args, spawn = nodeSpawn, onRecord, onTerminal,
    onStatus, fileMetadata = false, detached = true,
    timeoutMs = DEFAULT_TIMEOUT_MS, maxRecordBytes = DEFAULT_MAX_RECORD_BYTES,
    maxStdoutBytes = DEFAULT_MAX_STDOUT_BYTES, maxStderrBytes = DEFAULT_MAX_STDERR_BYTES }) {
    this.id = id; this.kind = kind; this.command = command; this.args = args;
    this.spawn = spawn; this.onRecord = onRecord; this.onTerminal = onTerminal; this.onStatus = onStatus;
    this.fileMetadata = fileMetadata; this.detached = detached;
    this.timeoutMs = timeoutMs; this.maxRecordBytes = maxRecordBytes;
    this.maxStdoutBytes = maxStdoutBytes; this.maxStderrBytes = maxStderrBytes;
    this.child = null; this.timer = null; this.killTimer = null; this.done = false; this.canceled = false; this.timedOut = false;
    this.stopReason = ""; this.failure = null; this.discardUntilNul = false;
    this.donePromise = new Promise((resolveDone) => { this.resolveDone = resolveDone; });
    this.bytes = 0; this.stderrBytes = 0; this.buffer = Buffer.alloc(0); this.overflow = false; this.stderr = "";
  }

  start() {
    let child;
    try {
      child = this.spawn(this.command, this.args, { stdio: ["ignore", "pipe", "pipe"],
        detached: this.detached, fileMetadata: this.fileMetadata });
    } catch (error) { this.finish("failed", error); return this; }
    this.child = child;
    const stdout = child.stdout; const stderr = child.stderr;
    const fail = (error) => {
      if (this.done) return;
      this.failure ||= error;
      this.terminateOwned();
    };
    child.once?.("close", (code, signal) => {
      if (this.done) return;
      const truncated = this.buffer.length > 0 || this.discardUntilNul;
      this.buffer = Buffer.alloc(0);
      if (this.canceled) this.finish("canceled");
      else if (this.timedOut) this.finish("timed-out", new Error("source timeout"));
      else if (this.overflow) this.finish("failed", new Error("source output capped"));
      else if (this.failure) this.finish("failed", this.failure);
      else if (truncated) this.finish("failed", new Error("incomplete NUL record"));
      else if (code === 0) this.finish("exhausted");
      else this.finish("failed", new Error(`fd exited ${code ?? signal ?? "unknown"}`));
    });
    child.once?.("error", fail);
    if (!stdout || !stderr || typeof child.on !== "function") {
      fail(new Error("fd source missing stdio")); return this;
    }
    stdout.on("data", (chunk) => this.consume(chunk));
    stderr.on("data", (chunk) => {
      this.stderrBytes += Buffer.byteLength(chunk);
      if (this.stderr.length < this.maxStderrBytes)
        this.stderr += String(chunk).slice(0, this.maxStderrBytes - this.stderr.length);
    });
    stdout.on("error", fail);
    stderr.on("error", fail);
    this.timer = setTimeout(() => {
      if (this.done) return;
      this.canceled = false; this.timedOut = true; this.overflow = false;
      this.onStatus?.({ id: this.id, kind: this.kind, status: "timed-out", error: new Error("source timeout") });
      this.terminateOwned();
    }, this.timeoutMs);
    return this;
  }

  consume(chunk) {
    if (this.done) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const room = this.maxStdoutBytes - this.bytes;
    const accepted = room > 0 ? data.subarray(0, room) : Buffer.alloc(0);
    this.bytes += accepted.length;
    if (accepted.length > 0) this.buffer = Buffer.concat([this.buffer, accepted]);
    while (true) {
      if (this.discardUntilNul) {
        const boundary = this.buffer.indexOf(0);
        if (boundary < 0) { this.buffer = Buffer.alloc(0); return; }
        this.buffer = this.buffer.subarray(boundary + 1); this.discardUntilNul = false;
      }
      const end = this.buffer.indexOf(0);
      if (end < 0) {
        if (this.buffer.length > this.maxRecordBytes) {
          this.overflow = true; this.discardUntilNul = true; this.buffer = Buffer.alloc(0);
          this.terminateOwned();
        }
        if (data.length > accepted.length) {
          this.overflow = true;
          this.terminateOwned();
        }
        return;
      }
      const record = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      if (record.length === 0) continue;
      if (record.length > this.maxRecordBytes) {
        this.overflow = true; this.discardUntilNul = false; this.terminateOwned(); continue;
      }
      this.onRecord?.(record.toString("utf8"), this);
    }
  }

  cancel(reason = "canceled") {
    if (this.done) return;
    this.stopReason = reason; this.canceled = reason === "canceled";
    this.terminateOwned();
    return this.donePromise;
  }

  terminateOwned() {
    if (!this.child || this.done) return;
    const signalChild = (signal) => {
      if (this.detached) killOwnedProcess(this.child, signal);
      else try { this.child.kill(signal); } catch {}
    };
    signalChild("SIGTERM");
    if (!this.killTimer) this.killTimer = setTimeout(() => {
      if (!this.done) signalChild("SIGKILL");
    }, 250);
  }

  finish(status, error = null) {
    if (this.done) return;
    this.done = true; if (this.timer) clearTimeout(this.timer); this.timer = null;
    if (this.killTimer) clearTimeout(this.killTimer); this.killTimer = null;
    if (this.stopReason === "capped") status = "capped";
    this.resolveDone?.();
    this.onTerminal?.({ id: this.id, kind: this.kind, status, error, stderr: this.stderr });
  }
}

function rankTuple(path, query, indexScore = null, scopeRoot = null) {
  const value = String(scopeRoot ? relative(scopeRoot, path) : path || "").toLowerCase();
  const filename = basename(value);
  const terms = String(query || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
  const filenameLiteral = terms.length > 0 && terms.every((term) => filename.includes(term));
  const pathLiteral = terms.length > 0 && terms.every((term) => value.includes(term));
  if (filenameLiteral) return [0, filename === terms.join("") ? 0 : 1, filename.indexOf(terms[0])];
  if (pathLiteral) return [1, value.indexOf(terms[0]), 0];
  const needle = terms.join("");
  let at = 0;
  for (const char of value.replace(/[^a-z0-9]/g, "")) if (char === needle[at]) at++;
  const fuzzy = needle.length > 0 && at === needle.length;
  if (!fuzzy && !indexScore) return [3, Infinity, value.length];
  const score = indexScore && Number.isFinite(Number(indexScore.total))
    ? Number(indexScore.total) : value.length;
  return [fuzzy ? 2 : 3, score, value.length];
}

function comparePaths(a, b, query, scores = null, scopeRoot = null) {
  const left = rankTuple(a, query, scores?.get(a), scopeRoot);
  const right = rankTuple(b, query, scores?.get(b), scopeRoot);
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return String(a).localeCompare(String(b));
}

function usefulIndexCandidate(candidate, path, query, focused, scopeRoot = null) {
  const text = String(scopeRoot ? relative(scopeRoot, path) : path || "").toLowerCase();
  const terms = String(query || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
  const strict = terms.length > 0 && terms.every((term) => text.includes(term));
  if (!focused) return strict;
  if (strict) return true;
  if (/[^a-z0-9\s_-]/i.test(query)) return false;
  const score = candidate?.score || {};
  const length = String(query || "").replace(/[^a-z0-9]/gi, "").length;
  return length >= 3 && Number(score.filenameBonus || 0) >= 3
    && Number(score.baseScore || 0) >= length * 5;
}

function strictScopedPathMatch(path, query, scopeRoot) {
  const text = String(relative(scopeRoot, path)).toLowerCase();
  const terms = String(query || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
  return terms.length > 0 && terms.every((term) => text.includes(term));
}

function fuzzyScore(path, query, scopeRoot = null) {
  const rank = rankTuple(path, query, null, scopeRoot);
  if (rank[0] === 3) return Infinity;
  return rank[0] * 100000 + rank[1] * 100 + rank[2];
}

function rowForPath(path, home) {
  const absolute = resolve(path);
  return { name: basename(absolute), relativePath: relative(home, absolute), path: absolute };
}

function readRepoDepth(settingsPath, envValue) {
  let configured = 6;
  if (settingsPath) {
    let descriptor = null;
    try {
      descriptor = openSync(settingsPath, "r");
      const buffer = Buffer.alloc(64 * 1024 + 1);
      const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
      if (bytes > 64 * 1024) throw new Error("settings file exceeds 64 KiB");
      const parsed = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
      if (parsed && parsed.repoSearchDepth !== undefined) configured = Number(parsed.repoSearchDepth);
    } catch {
      configured = 6;
    } finally {
      if (descriptor !== null) try { closeSync(descriptor); } catch {}
    }
  }
  if (envValue !== undefined && envValue !== "") configured = Number(envValue);
  if (!Number.isFinite(configured)) return 6;
  if (configured <= 0) return 0;
  return Math.max(1, Math.min(128, Math.round(configured)));
}

function killHelper(child, signal = "SIGTERM") {
  if (!child) return;
  if (Number.isInteger(child.pid) && child.pid > 1) {
    try { process.kill(-child.pid, signal); } catch {}
  }
  try { child.kill?.(signal); } catch {}
}

function readOwnedOutput(spawn, command, args, { maxBytes, timeoutMs = DEFAULT_HELPER_TIMEOUT_MS,
  onChild = () => {}, onDone = () => {}, onBeforeSpawn = () => true } = {}) {
  let child = null; let resolveReaped;
  const reaped = new Promise((resolveReap) => { resolveReaped = resolveReap; });
  let cancel = () => {};
  const result = new Promise((resolveOutput, rejectOutput) => {
    if (!onBeforeSpawn()) {
      resolveReaped(); rejectOutput(new Error("metadata helper limit")); return;
    }
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], detached: true });
    } catch (error) { resolveReaped(); rejectOutput(error); return; }
    const parts = []; let bytes = 0; let settled = false; let closed = false;
    let timer = null; let killTimer = null;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (error) rejectOutput(error); else resolveOutput(value);
    };
    const terminate = (error) => {
      settle(error);
      killHelper(child);
      if (!killTimer) killTimer = setTimeout(() => {
        if (!closed) killHelper(child, "SIGKILL");
      }, 250);
    };
    const ownership = {
      child, reaped,
      cancel: (reason = "metadata helper canceled") => {
        if (closed) return;
        terminate(new Error(reason));
      },
    };
    cancel = ownership.cancel;
    onChild(child, ownership);
    child.once?.("close", (code, signal) => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      timer = null; killTimer = null;
      if (!settled) {
        if (code === 0) settle(null, Buffer.concat(parts).toString("utf8"));
        else settle(new Error(`metadata helper exited ${code ?? signal ?? "unknown"}`));
      }
      onDone(child, ownership);
      resolveReaped();
    });
    child.once?.("error", (error) => terminate(error));
    if (!child.stdout || typeof child.on !== "function") {
      terminate(new Error("metadata helper missing stdout"));
      return;
    }
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const room = maxBytes - bytes;
      if (room <= 0 || data.length > room) {
        terminate(new Error("metadata helper output capped"));
        return;
      }
      bytes += data.length; parts.push(data);
    });
    child.stdout.on("error", (error) => terminate(error));
    timer = setTimeout(() => terminate(new Error("metadata helper timeout")), timeoutMs);
  });
  // The query-facing result has a bounded deadline, while `reaped` represents
  // the independently owned child lifetime and is the capacity/shutdown gate.
  result.cancel = (reason) => cancel(reason);
  result.reaped = reaped;
  result.child = () => child;
  return result;
}

function boundedMountInfo(spawn, options = {}) {
  return readOwnedOutput(spawn, "cat", ["/proc/self/mountinfo"], {
    maxBytes: MAX_MOUNTINFO_BYTES, timeoutMs: 250,
    ...options,
  }).then((raw) => ({ raw, truncated: Buffer.byteLength(raw) >= MAX_MOUNTINFO_BYTES }));
}

function parseSingleNulPath(value) {
  const bytes = Buffer.from(String(value || ""), "utf8");
  const end = bytes.indexOf(0);
  if (end <= 0 || end !== bytes.length - 1) return null;
  return bytes.subarray(0, end).toString("utf8");
}

export class IndexWorker {
  constructor({ spawn = nodeSpawn, workerPath, timeoutMs = DEFAULT_INDEX_TIMEOUT_MS,
    startupTimeoutMs = 30_000, retryBaseMs = 250, retryMaxMs = 4_000, onRows,
    onUnavailable, basePath, mode = "fff" }) {
    this.spawn = spawn; this.workerPath = workerPath; this.timeoutMs = timeoutMs;
    this.startupTimeoutMs = startupTimeoutMs; this.retryBaseMs = retryBaseMs; this.retryMaxMs = retryMaxMs;
    this.onRows = onRows; this.onUnavailable = onUnavailable;
    this.basePath = resolve(basePath); this.mode = mode;
    this.lifecycle = null; this.pending = null; this.closed = false; this.ready = false;
    this.retiring = false; this.restartAfterClose = false; this.failureCount = 0; this.nextRetryAt = 0;
    this.queryTimer = null; this.startupTimer = null; this.killTimer = null;
    this.buffer = Buffer.alloc(0); this.stdoutBytes = 0; this.stderrBytes = 0;
  }

  noteFailure() {
    this.failureCount = Math.min(this.failureCount + 1, 8);
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** (this.failureCount - 1)));
    this.nextRetryAt = Date.now() + delay;
  }

  setBasePath(basePath) {
    const next = resolve(basePath);
    if (next === this.basePath) return;
    this.basePath = next;
    if (this.pending) { this.onUnavailable?.(this.pending.token); this.pending = null; }
    if (this.lifecycle) {
      this.restartAfterClose = false;
      this.retiring = true;
      this.terminate({ intentional: true });
    }
  }

  clearTimers() {
    if (this.queryTimer) clearTimeout(this.queryTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.queryTimer = null; this.startupTimer = null;
  }

  unavailablePending() {
    if (!this.pending) return;
    const token = this.pending.token;
    this.pending = null;
    this.onUnavailable?.(token);
  }

  ensure() {
    if (this.closed || this.lifecycle || this.retiring) return false;
    if (Date.now() < this.nextRetryAt) return false;
    let child;
    try {
      child = this.spawn(process.execPath, [this.workerPath], {
        stdio: ["pipe", "pipe", "pipe"], detached: true,
        env: { ...process.env, ASK_FILE_ROOT: this.basePath, ASK_FILE_INDEX_MODE: this.mode },
      });
    } catch {
      this.noteFailure(); return false;
    }
    let resolveClose;
    const closePromise = new Promise((resolveClosed) => { resolveClose = resolveClosed; });
    const lifecycle = { child, closePromise, resolveClose, closed: false, intentional: false,
      failureNoted: false };
    this.lifecycle = lifecycle; this.ready = false; this.retiring = false;
    this.buffer = Buffer.alloc(0); this.stdoutBytes = 0; this.stderrBytes = 0;
    const failAndRetire = () => {
      if (this.lifecycle !== lifecycle || lifecycle.closed) return;
      if (!lifecycle.failureNoted) { this.noteFailure(); lifecycle.failureNoted = true; }
      this.retiring = true; this.unavailablePending(); this.terminate();
    };
    child.once?.("close", () => {
      if (lifecycle.closed) return;
      lifecycle.closed = true;
      lifecycle.resolveClose();
      if (this.lifecycle !== lifecycle) return;
      this.clearTimers();
      if (this.killTimer) clearTimeout(this.killTimer);
      this.killTimer = null; this.lifecycle = null; this.ready = false; this.retiring = false;
      this.buffer = Buffer.alloc(0);
      if (!lifecycle.intentional && !lifecycle.failureNoted) this.noteFailure();
      if (!this.restartAfterClose) this.unavailablePending();
      const restart = this.restartAfterClose && !this.closed && Boolean(this.pending);
      this.restartAfterClose = false;
      if (restart) {
        if (lifecycle.intentional) this.nextRetryAt = 0;
        if (!this.ensure()) this.unavailablePending();
      }
    });
    child.once?.("error", failAndRetire);
    if (!child.stdout || !child.stdin || typeof child.on !== "function") {
      failAndRetire(); return true;
    }
    child.stdout.on("error", failAndRetire);
    child.stdin.on?.("error", failAndRetire);
    child.stdout.on("data", (chunk) => {
      if (this.lifecycle !== lifecycle || lifecycle.closed) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      this.stdoutBytes += data.length;
      if (this.stdoutBytes > DEFAULT_MAX_STDOUT_BYTES) { failAndRetire(); return; }
      this.buffer = Buffer.concat([this.buffer, data]);
      while (true) {
        const end = this.buffer.indexOf(10);
        if (end < 0) break;
        const line = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
        this.consumeLine(line.toString("utf8"), lifecycle);
      }
    });
    child.stderr?.on("data", (chunk) => {
      this.stderrBytes = Math.min(DEFAULT_MAX_STDERR_BYTES,
        this.stderrBytes + Buffer.byteLength(chunk));
    });
    this.startupTimer = setTimeout(() => {
      if (this.lifecycle !== lifecycle || this.ready) return;
      failAndRetire();
    }, this.startupTimeoutMs);
    return true;
  }

  consumeLine(line, lifecycle) {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.type === "ready") {
      if (this.lifecycle !== lifecycle || this.retiring) return;
      if (this.startupTimer) clearTimeout(this.startupTimer);
      this.startupTimer = null;
      if (message.available === false) {
        this.noteFailure(); this.unavailablePending(); this.retiring = true; this.terminate();
        return;
      }
      this.ready = true; this.failureCount = 0; this.nextRetryAt = 0;
      this.sendPending();
      return;
    }
    if (!this.pending || message.token !== this.pending.token) return;
    const pending = this.pending; this.pending = null;
    if (this.queryTimer) clearTimeout(this.queryTimer);
    this.queryTimer = null;
    this.onRows?.(pending.token, Array.isArray(message.rows) ? message.rows : [], message.available !== false,
      message.capped === true || message.truncated === true);
  }

  sendPending() {
    if (!this.pending || this.pending.sent || !this.ready || this.retiring) return;
    const lifecycle = this.lifecycle;
    if (!lifecycle?.child?.stdin?.writable) { this.unavailablePending(); return; }
    const pending = this.pending;
    try {
      lifecycle.child.stdin.write(`${JSON.stringify({ token: pending.token, query: pending.query,
        focused: pending.focused, basePath: this.basePath })}\n`);
      pending.sent = true;
    } catch {
      this.unavailablePending(); this.noteFailure(); this.retiring = true; this.terminate(); return;
    }
    this.queryTimer = setTimeout(() => {
      if (!this.pending || this.pending.token !== pending.token) return;
      this.unavailablePending(); this.noteFailure(); this.retiring = true; this.terminate();
    }, this.timeoutMs);
  }

  terminate({ intentional = false } = {}) {
    const lifecycle = this.lifecycle;
    if (!lifecycle || lifecycle.closed) return;
    lifecycle.intentional ||= intentional;
    killOwnedProcess(lifecycle.child);
    if (!this.killTimer) this.killTimer = setTimeout(() => {
      if (this.lifecycle === lifecycle && !lifecycle.closed) killOwnedProcess(lifecycle.child, "SIGKILL");
    }, 250);
  }

  request(token, query, focused, basePath) {
    if (this.closed) { this.onUnavailable?.(token); return; }
    if (basePath) this.setBasePath(basePath);
    const previous = this.pending;
    if (previous) this.onUnavailable?.(previous.token);
    this.pending = { token, query, focused, sent: false };
    // FFF search is synchronous inside its isolated worker. Replacement owns
    // a fresh worker so a blocked old call cannot delay the latest query.
    if (previous?.sent && this.mode === "fff" && this.lifecycle) {
      if (this.queryTimer) clearTimeout(this.queryTimer);
      this.queryTimer = null; this.restartAfterClose = true; this.retiring = true;
      this.terminate({ intentional: true }); return;
    }
    if (!this.lifecycle && !this.ensure()) { this.unavailablePending(); return; }
    if (this.retiring) {
      this.restartAfterClose = true;
      return;
    }
    this.sendPending();
  }

  cancel(token) {
    if (!this.pending || (token && this.pending.token !== token)) return Promise.resolve();
    const wasSent = this.pending.sent;
    this.pending = null;
    if (this.queryTimer) clearTimeout(this.queryTimer);
    this.queryTimer = null;
    const lifecycle = this.lifecycle;
    if (!wasSent || !lifecycle) return Promise.resolve();
    this.restartAfterClose = false; this.retiring = true;
    this.terminate({ intentional: true });
    return lifecycle.closePromise;
  }

  async close() {
    this.closed = true; this.restartAfterClose = false; this.clearTimers();
    this.pending = null;
    const lifecycle = this.lifecycle;
    if (!lifecycle) return;
    this.retiring = true; this.terminate({ intentional: true });
    await lifecycle.closePromise;
  }
}

export class FileSearchCoordinator {
  constructor({
    basePath, home = process.env.HOME || process.cwd(), settingsPath, repoDepth,
    emit = () => {}, spawn = spawnSearchProcess, metadataSpawn = nodeSpawn,
    readMountInfo, mountInfo,
    enableIndex = true, workerPath = new URL("./file-index-worker.js", import.meta.url).pathname,
    maxResults = DEFAULT_MAX_RESULTS, maxEvidence = DEFAULT_MAX_EVIDENCE,
    maxConcurrent = DEFAULT_MAX_CONCURRENT, maxLocalConcurrent = DEFAULT_LOCAL_CONCURRENT,
    maxMountedConcurrent = DEFAULT_MOUNTED_CONCURRENT, sourceTimeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    this.basePath = resolve(basePath || home); this.home = resolve(home);
    this.emit = emit; this.spawn = spawn;
    this.metadataSpawn = metadataSpawn;
    this.helpers = new Map();
    this.helperOptionsFor = (request) => ({
      onBeforeSpawn: () => this.helpers.size < 4,
      onChild: (child, ownership) => {
        this.helpers.set(child, ownership);
        request?.helpers?.add(ownership);
      },
      onDone: (child, ownership) => {
        this.helpers.delete(child);
        request?.helpers?.delete(ownership);
      },
    });
    this.readMountInfo = readMountInfo
      || ((request) => boundedMountInfo(metadataSpawn, this.helperOptionsFor(request)));
    this.mountInfo = mountInfo;
    this.repoDepth = readRepoDepth(settingsPath, repoDepth); this.maxResults = maxResults;
    this.maxEvidence = maxEvidence; this.maxConcurrent = Math.max(2, maxConcurrent);
    this.maxLocalConcurrent = Math.max(1, Math.min(maxLocalConcurrent, this.maxConcurrent));
    this.maxMountedConcurrent = Math.max(1, Math.min(maxMountedConcurrent, this.maxConcurrent));
    this.sourceTimeoutMs = sourceTimeoutMs; this.generation = 0; this.current = null; this.closed = false;
    // Lane accounting is coordinator-global, while aggregates remain
    // generation-local.  A dead mounted child from an old query may occupy a
    // mounted lane until it is actually reaped, but it must never consume the
    // reserved local capacity of the replacement query.
    this.runningTotal = 0; this.runningLocal = 0; this.runningMounted = 0;
    this.activeSources = new Set();
    this.index = enableIndex ? new IndexWorker({ spawn, workerPath, basePath: this.basePath,
      onRows: (token, rows, available, capped) => this.acceptIndex(token, rows, available, capped),
      onUnavailable: (token) => this.indexUnavailable(token) }) : null;
    this.plocate = enableIndex ? new IndexWorker({ spawn, workerPath, basePath: this.basePath,
      // This bounds the whole isolated locate+stat validation call even when
      // the worker's own event loop is stuck in a filesystem operation.
      mode: "plocate", timeoutMs: DEFAULT_HELPER_TIMEOUT_MS,
      onRows: (token, rows, available, capped) => this.acceptPlocate(token, rows, available, capped),
      onUnavailable: () => {} }) : null;
  }

  request(message = {}) {
    const generation = ++this.generation;
    this.cancelCurrent();
    const request = {
      generation, id: Number(message.id) || 0, query: String(message.query || "").trim(),
      focused: message.focused === true, states: new Map(), rows: new Map(), repos: new Map(),
      indexScores: new Map(), helpers: new Set(), scopeRoot: this.basePath,
      capped: false, repoCapped: false, fileIncomplete: false, repoIncomplete: false,
      planIncomplete: false, fileDone: false, repoDone: false,
      emitTimer: null, canceled: false, sources: new Map(), queued: [], active: 0,
      activeLocal: 0, activeMounted: 0,
      indexPending: Boolean(this.index && message.focused === true),
      indexUnavailable: !this.index && message.focused === true,
      plocateToken: null,
    };
    this.current = request;
    if (request.query.length < 2) {
      request.indexPending = false; request.indexUnavailable = false;
      request.fileDone = true; request.repoDone = true;
      this.publish(request, true); return generation;
    }
    this.publish(request, false); this.startRequest(request); return generation;
  }

  async startRequest(request) {
    if (!this.isCurrent(request)) return;
    let plan; let canonicalRoot = this.basePath; let canonicalComplete = true;
    try {
      const infoPromise = this.mountInfo !== undefined ? this.mountInfo : this.readMountInfo(request);
      const rootPromise = readOwnedOutput(this.metadataSpawn, "realpath", ["-z", "-e", "--", this.basePath], {
        maxBytes: 16 * 1024, timeoutMs: DEFAULT_HELPER_TIMEOUT_MS,
        ...this.helperOptionsFor(request),
      }).catch(() => null);
      const [info, locatedRoot] = await Promise.all([infoPromise, rootPromise.catch(() => null)]);
      const locatedPath = parseSingleNulPath(locatedRoot);
      if (locatedPath) canonicalRoot = locatedPath;
      else canonicalComplete = false;
      plan = planPartitions(canonicalRoot, info);
    } catch { canonicalComplete = false; plan = planPartitions(canonicalRoot, { mounts: [], incomplete: true }); }
    if (!this.isCurrent(request)) return;
    request.mountPlan = plan; request.scopeRoot = canonicalRoot;
    request.planIncomplete = plan.incomplete || !canonicalComplete;
    if (!canonicalComplete) {
      // Without a trustworthy root identity, fd must not cross devices or
      // symlinked mounts.  This is conservative and deliberately incomplete.
      for (const partition of plan.partitions) partition.oneFileSystem = true;
    }
    const local = plan.partitions.find((partition) => partition.kind === "local")
      || { id: "base", kind: "local", root: this.basePath, prunedMounts: [] };
    this.enqueueSource(request, local, false);
    for (const partition of plan.partitions.filter((item) => item.kind === "mounted"))
      this.enqueueSource(request, partition, false);
    for (const partition of plan.partitions) {
      if (this.repoDepth > 0 && partition.depth >= this.repoDepth) continue;
      const depth = this.repoDepth > 0 ? Math.max(1, this.repoDepth - partition.depth) : 0;
      this.enqueueSource(request, partition, true, depth);
    }
    if (this.index) {
      const token = `${request.generation}:${request.id}:${Math.random().toString(36).slice(2)}`;
      request.indexToken = token; this.index.request(token, request.query, request.focused, request.scopeRoot);
    }
    if (this.plocate) {
      const token = `${request.generation}:${request.id}:plocate:${Math.random().toString(36).slice(2)}`;
      request.plocateToken = token; this.plocate.request(token, request.query, false, request.scopeRoot);
    }
    this.pump(request);
  }

  enqueueSource(request, partition, repo, repoDepth = 0) {
    const id = `${repo ? "repo" : "file"}:${partition.id}`;
    const source = { id, partition, repo, repoDepth, command: sourceCommand(partition, request.query, {
      repo, repoDepth, scopeRoot: request.scopeRoot }),
      rows: new Set(), count: 0, status: "queued", capped: false };
    request.sources.set(id, source); request.queued.push(source);
  }

  pump(request) {
    if (!request || !this.isCurrent(request)) return;
    // Reserve two local slots for the base file and repository scans. Four
    // mounted jobs may run independently, but never consume local capacity.
    while (request.queued.length > 0 && this.runningTotal < this.maxConcurrent
      && this.runningLocal < this.maxLocalConcurrent) {
      const index = request.queued.findIndex((source) => source.partition.kind === "local");
      if (index < 0) break;
      const source = request.queued.splice(index, 1)[0]; this.startSource(request, source);
    }
    while (request.queued.length > 0 && this.runningTotal < this.maxConcurrent
      && this.runningMounted < this.maxMountedConcurrent) {
      const index = request.queued.findIndex((source) => source.partition.kind === "mounted");
      if (index < 0) break;
      const source = request.queued.splice(index, 1)[0]; this.startSource(request, source);
    }
    if (request.queued.length === 0 && request.active === 0) {
      request.fileDone = [...request.sources.values()].filter((source) => !source.repo)
        .every((source) => source.status === "exhausted");
      request.repoDone = [...request.sources.values()].filter((source) => source.repo)
        .every((source) => source.status === "exhausted");
      this.schedulePublish(request, true);
    }
  }

  startSource(request, source) {
    if (!this.isCurrent(request)) return;
    source.status = "running"; source.laneReleased = false;
    request.active++;
    if (source.partition.kind === "local") { request.activeLocal++; this.runningLocal++; }
    else { request.activeMounted++; this.runningMounted++; }
    this.runningTotal++; this.activeSources.add(source);
    const stream = new StreamSource({ id: source.id, kind: source.repo ? "repo" : source.partition.kind,
      ...source.command, fileMetadata: !source.repo, spawn: this.spawn, timeoutMs: this.sourceTimeoutMs,
      onRecord: (record) => this.acceptRecord(request, source, record),
      onStatus: (status) => this.statusSource(request, source, status),
      onTerminal: (terminal) => this.finishSource(request, source, terminal) });
    source.stream = stream; stream.start();
  }

  acceptRecord(request, source, record) {
    if (!this.isCurrent(request) || source.status !== "running") return;
    let modifiedMs = null;
    if (!source.repo && record.startsWith("{")) {
      let item; try { item = JSON.parse(record); } catch { return; }
      if (typeof item.path !== "string") return;
      record = item.path; modifiedMs = modifiedTime(item.modifiedMs);
    }
    if (!recordInsidePartition(source.partition.root, record)) return;
    if (source.repo) {
      const repoPath = dirname(resolve(record));
      if (!Number.isFinite(fuzzyScore(repoPath, request.query, request.scopeRoot))) return;
      if (source.rows.has(repoPath)) return;
      source.count++;
      if (source.rows.size < this.maxEvidence) source.rows.add(repoPath);
      this.insertBounded(request.repos, repoPath, request, true);
    } else {
      const path = resolve(record);
      if (!strictScopedPathMatch(path, request.query, request.scopeRoot)) return;
      if (source.rows.has(path)) return;
      source.count++;
      if (source.rows.size < this.maxEvidence) source.rows.add(path);
      this.insertBounded(request.rows, path, request, false, modifiedMs);
    }
    this.schedulePublish(request, false);
  }

  insertBounded(map, path, request, repo, modifiedMs = null) {
    // A metadata-less observation must not erase a known timestamp.
    map.set(path, repo ? true : modifiedTime(modifiedMs) ?? modifiedTime(map.get(path)));
    if (map.size <= this.maxEvidence) return;
    const values = [...map.keys()].sort((a, b) => repo
      ? comparePaths(a, b, request.query, request.indexScores, request.scopeRoot)
      : compareFiles(a, b, request, map));
    for (const value of values.slice(this.maxEvidence)) map.delete(value);
    if (repo) request.repoCapped = true; else request.capped = true;
  }

  finishSource(request, source, terminal) {
    if (source.laneReleased) return;
    if (source.status !== "running" && source.status !== "timed-out") return;
    source.status = terminal.status; source.error = terminal.error;
    this.releaseSourceLane(request, source);
    if (!this.isCurrent(request)) return;
    if (source.capped || terminal.status === "capped") {
      if (source.repo) request.repoCapped = true; else request.capped = true;
    }
    if (["timed-out", "failed"].includes(terminal.status)) {
      if (source.repo) request.repoIncomplete = true; else request.fileIncomplete = true;
    }
    this.schedulePublish(request, false); this.pump(request);
  }

  releaseSourceLane(request, source) {
    if (source.laneReleased) return;
    source.laneReleased = true;
    this.activeSources.delete(source);
    this.runningTotal = Math.max(0, this.runningTotal - 1);
    if (source.partition.kind === "local") {
      this.runningLocal = Math.max(0, this.runningLocal - 1);
      if (request === this.current) request.activeLocal = Math.max(0, request.activeLocal - 1);
    } else {
      this.runningMounted = Math.max(0, this.runningMounted - 1);
      if (request === this.current) request.activeMounted = Math.max(0, request.activeMounted - 1);
    }
    if (request === this.current) request.active = Math.max(0, request.active - 1);
    this.pump(this.current);
  }

  statusSource(request, source, status) {
    if (!this.isCurrent(request) || source.status !== "running") return;
    source.status = status.status;
    if (["timed-out", "capped", "failed"].includes(status.status)) {
      if (status.status === "capped") {
        if (source.repo) request.repoCapped = true; else request.capped = true;
      } else if (source.repo) request.repoIncomplete = true; else request.fileIncomplete = true;
    }
    this.schedulePublish(request, false);
  }

  acceptIndex(token, rows, available = true, capped = false) {
    const request = this.current;
    if (!request || request.indexToken !== token || request.canceled) return;
    request.indexPending = false;
    if (!available || capped) request.indexUnavailable = true;
    for (const candidate of rows) {
      const path = typeof candidate === "string" ? candidate : candidate?.path;
      if (!recordInsidePartition(request.scopeRoot, path)) continue;
      if (!usefulIndexCandidate(candidate, path, request.query, request.focused, request.scopeRoot)) continue;
      const absolute = resolve(path);
      if (candidate?.score) request.indexScores.set(absolute, candidate.score);
      this.insertBounded(request.rows, absolute, request, false, candidate?.modifiedMs);
    }
    this.schedulePublish(request, false);
  }

  indexUnavailable(token) {
    const request = this.current;
    if (!request || request.indexToken !== token || request.canceled) return;
    request.indexPending = false; request.indexUnavailable = true;
    this.schedulePublish(request, false);
  }

  acceptPlocate(token, rows, available = true, capped = false) {
    const request = this.current;
    if (!request || request.plocateToken !== token || request.canceled) return;
    for (const candidate of rows) {
      const path = typeof candidate === "string" ? candidate : candidate?.path;
      if (!recordInsidePartition(request.scopeRoot, path)) continue;
      if (!usefulIndexCandidate(candidate, path, request.query, false, request.scopeRoot)) continue;
      this.insertBounded(request.rows, resolve(path), request, false, candidate?.modifiedMs);
    }
    if (capped || !available) request.acceleratorIncomplete = true;
    this.schedulePublish(request, false);
  }

  schedulePublish(request, terminal) {
    if (!this.isCurrent(request)) return;
    if (terminal) {
      if (request.emitTimer) clearTimeout(request.emitTimer);
      request.emitTimer = null; this.publish(request, true); return;
    }
    if (request.emitTimer) return;
    request.emitTimer = setTimeout(() => {
      request.emitTimer = null;
      if (this.isCurrent(request)) this.publish(request, false);
    }, 20);
  }

  publish(request, terminal = false) {
    if (!this.isCurrent(request)) return;
    const fileSources = [...request.sources.values()].filter((source) => !source.repo);
    const repoSources = [...request.sources.values()].filter((source) => source.repo);
    const allExhausted = (sources) => sources.length > 0 && sources.every((source) => source.status === "exhausted");
    const fuzzyComplete = !request.focused || (!request.indexPending && !request.indexUnavailable);
    const fileComplete = !request.planIncomplete && !request.fileIncomplete && fuzzyComplete && (request.fileDone
      || (terminal && allExhausted(fileSources)));
    const repoComplete = !request.planIncomplete && !request.repoIncomplete && (request.repoDone
      || (terminal && allExhausted(repoSources)));
    const rows = [...request.rows.keys()].sort((a, b) => compareFiles(a, b, request))
      .slice(0, this.maxResults).map((path) => ({ ...rowForPath(path, this.home),
        modifiedMs: modifiedTime(request.rows.get(path)) }));
    const repos = [...request.repos.keys()].sort((a, b) => comparePaths(a, b, request.query,
      request.indexScores, request.scopeRoot))
      .slice(0, this.maxResults).map((path) => rowForPath(path, this.home));
    this.emit({ id: request.id, query: request.query, basePath: this.basePath, rows,
      totalMatched: Math.min(request.rows.size, this.maxEvidence),
      capped: request.capped || request.rows.size > this.maxResults, complete: fileComplete,
      repos, repoTotalMatched: Math.min(request.repos.size, this.maxEvidence),
      repoCapped: request.repoCapped || request.repos.size > this.maxResults, repoComplete });
  }

  isCurrent(request) { return !this.closed && this.current === request && !request.canceled; }

  cancelCurrent() {
    const request = this.current;
    if (!request) return Promise.resolve();
    request.canceled = true;
    if (request.emitTimer) clearTimeout(request.emitTimer);
    const waits = [];
    for (const source of request.sources.values()) {
      const wait = source.stream?.cancel();
      if (wait) waits.push(wait);
    }
    request.queued = [];
    for (const helper of request.helpers || []) {
      helper.cancel("superseded metadata helper");
      waits.push(helper.reaped);
    }
    request.helpers?.clear();
    if (this.index && request.indexToken) waits.push(this.index.cancel(request.indexToken));
    if (this.plocate && request.plocateToken) waits.push(this.plocate.cancel(request.plocateToken));
    return Promise.all(waits);
  }

  async close() {
    this.closed = true; const barrier = this.cancelCurrent();
    const allSourceWaits = [...this.activeSources].map((source) => source.stream?.cancel("canceled"));
    const allSources = Promise.all(allSourceWaits.filter(Boolean));
    const workerBarrier = Promise.all([this.index?.close(), this.plocate?.close()]);
    const helperBarriers = [];
    for (const ownership of this.helpers.values()) {
      ownership.cancel("coordinator shutdown"); helperBarriers.push(ownership.reaped);
    }
    await Promise.race([
      Promise.all([barrier, allSources, workerBarrier, ...helperBarriers]),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 1_200)),
    ]);
  }
}

function streamCancelSoon(stream, reason) {
  setTimeout(() => stream?.cancel(reason), 0);
}

export const __test = { queryPattern, sourceCommand, lexicalInside, decodeMountField,
  rowForPath, fuzzyScore, globEscape, parseSingleNulPath, readOwnedOutput,
  scopedQueryPattern, usefulIndexCandidate, readRepoDepth, strictScopedPathMatch };
