#!/usr/bin/env node

import { FileFinder } from "@ff-labs/fff-node";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const home = process.env.HOME || process.cwd();
// `@` is a general file finder, so its default scope is the whole home
// directory. ASK_FILE_ROOT is an explicit opt-in for users who want a
// narrower index. Keep the fd fallback and repository discovery on exactly
// the same root so results do not change scope while the primary index warms.
const basePath = resolve(process.env.ASK_FILE_ROOT || home);
const searchRoots = [basePath].filter((path) => existsSync(path));
const priorityFileRoots = ["Downloads", "Documents", "Desktop", "Projects", "Work"]
  .map((name) => join(basePath, name)).filter((path) => existsSync(path));
const settingsPath = join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "omarchy", "ask.json");
let configuredRepoDepth = 6;
try {
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (settings.repoSearchDepth !== undefined)
    configuredRepoDepth = Number(settings.repoSearchDepth);
} catch {}
if (process.env.ASK_REPO_SEARCH_DEPTH !== undefined)
  configuredRepoDepth = Number(process.env.ASK_REPO_SEARCH_DEPTH);
// Zero means unlimited. Bound positive values to keep accidental settings
// from generating nonsensical fd arguments.
const repoSearchDepth = Number.isFinite(configuredRepoDepth)
  ? (configuredRepoDepth <= 0 ? 0 : Math.max(1, Math.min(128, Math.round(configuredRepoDepth))))
  : 6;
const created = FileFinder.create({
  basePath,
  aiMode: false,
  disableMmapCache: true,
  disableContentIndexing: true,
  enableHomeDirScanning: basePath === resolve(home),
});
const finder = created.ok ? created.value : null;
let ready = false;
let repos = [];
let reposReady = false;
let latestRequestId = 0;
let pendingSearchTimer = null;
let activeSearchController = null;
let progressiveTimers = [];
let latestRepoQuery = "";
const execFileAsync = promisify(execFile);
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

function setRepos(paths) {
  repos = Array.from(new Set(repos.concat(
    paths.filter(Boolean).map((path) => dirname(resolve(path)))
  )));
  emitCurrentRepos();
}

async function findRepoMarkers(roots, timeout) {
  const depthArgs = repoSearchDepth > 0 ? ["--max-depth", String(repoSearchDepth)] : [];
  const outputs = await Promise.all(roots.map((root) => execFileAsync("fd", [
    "--hidden", "--no-ignore", ...depthArgs,
    "--exclude", ".cache", "--exclude", "node_modules",
    "^\\.git$", root,
  ], { timeout, maxBuffer: 2 * 1024 * 1024 }).then((value) => value.stdout).catch(() => "")));
  return outputs.join("\n").split("\n").filter(Boolean);
}

async function discoverRepos() {
  try {
    const basePrefix = basePath.endsWith("/") ? basePath : `${basePath}/`;
    const located = await execFileAsync("plocate", ["--regex", "/\\.git/?$"] , {
      timeout: 1200, maxBuffer: 4 * 1024 * 1024,
    }).then((value) => value.stdout).catch(() => "");
    const warm = located.split("\n").filter((path) => {
      if (!path.startsWith(basePrefix) || path.includes("/node_modules/")
          || path.includes("/.cache/")) return false;
      try { return statSync(path).isDirectory(); } catch { return false; }
    });
    if (warm.length > 0) setRepos(warm);

    // Repositories people actively work in usually live in one of these
    // roots. Scan them first so a stale locate database does not make the
    // repo row wait behind caches and application data elsewhere in $HOME.
    const priorityRoots = ["Projects", "Work", "Documents", "Desktop"]
      .map((name) => join(basePath, name)).filter((path) => existsSync(path));
    if (priorityRoots.length > 0) setRepos(await findRepoMarkers(priorityRoots, 3000));

    const scanned = await findRepoMarkers(searchRoots, 15_000);
    if (scanned.length > 0) setRepos(scanned);
  } catch { repos = []; }
  reposReady = true;
  emitCurrentRepos();
}

function fuzzyScore(value, query) {
  const haystack = value.toLowerCase();
  const needle = query.toLowerCase().replace(/\s+/g, "");
  const compact = haystack.replace(/[^a-z0-9]/g, "");
  const exact = haystack.indexOf(query.toLowerCase());
  if (exact >= 0) return exact;
  let at = 0;
  for (let index = 0; index < compact.length && at < needle.length; index++)
    if (compact[index] === needle[at]) at++;
  return at === needle.length ? 100 + compact.length - needle.length : Infinity;
}

function repoResult(query) {
  const matches = repos.map((path) => ({ path, score: fuzzyScore(path, query) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => a.score - b.score);
  return {
    rows: matches.slice(0, 100).map((item) => ({
      name: basename(item.path), path: item.path,
    })),
    totalMatched: Math.min(matches.length, 100),
    capped: matches.length > 100,
  };
}

function emitCurrentRepos() {
  if (latestRequestId <= 0 || latestRepoQuery.length < 2) return;
  const result = repoResult(latestRepoQuery);
  emit({
    id: latestRequestId,
    query: latestRepoQuery,
    basePath,
    repoOnly: true,
    repos: result.rows,
    repoTotalMatched: result.totalMatched,
    repoCapped: result.capped,
    repoComplete: reposReady,
  });
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function initialize() {
  if (!finder) return;
  while (!ready) {
    const completed = await finder.waitForScan(30_000).catch(() => null);
    ready = Boolean(completed && completed.ok && completed.value === true);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

const initializing = initialize();
const repoInitialization = discoverRepos();

function emitSearch(message, query, rows, totalMatched = rows.length, capped = false,
    complete = true) {
  if (Number(message.id) !== latestRequestId) return;
  emit({
    id: message.id,
    query,
    basePath,
    rows,
    totalMatched,
    capped,
    complete,
  });
}

function emitProgressively(message, query, result) {
  const rows = result.rows;
  if (rows.length === 0) {
    emitSearch(message, query, [], 0, false, result.complete !== false);
    return;
  }
  const stops = [1, 5, 10, 25, 50, 100].filter((count) => count < rows.length);
  stops.push(rows.length);
  stops.forEach((count, index) => progressiveTimers.push(setTimeout(() => {
    const final = count === rows.length;
    emitSearch(message, query, rows.slice(0, count),
      final ? result.totalMatched : count,
      final ? result.capped : false,
      final ? result.complete !== false : false);
  }, index * 35)));
}

function strictFileMatch(item, query) {
  const value = `${item.fileName || ""} ${item.relativePath || ""}`.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.length > 0 && terms.every((term) => value.includes(term));
}

function usefulFuzzyMatch(item, score, query) {
  if (strictFileMatch(item, query)) return true;
  // Punctuation-heavy searches such as `.png` express a literal extension,
  // not a request to fuzzily combine p+n+g from unrelated path components.
  if (/[^a-z0-9\s_-]/i.test(query)) return false;
  const length = query.replace(/[^a-z0-9]/gi, "").length;
  return length >= 3 && score
    && Number(score.filenameBonus || 0) >= 3
    && Number(score.baseScore || 0) >= length * 5;
}

async function fallbackFiles(query, signal) {
  try {
    // plocate gives a fast whole-home cold-start path on Omarchy while FFF's
    // in-memory index is still scanning. Its database can be stale, so verify
    // every result and fall through to fd when it has no usable matches.
    const located = await execFileAsync("plocate", [
      "--ignore-case", "--limit", "300", query,
    ], { timeout: 1200, maxBuffer: 2 * 1024 * 1024, signal })
      .then((value) => value.stdout).catch(() => "");
    const basePrefix = basePath.endsWith("/") ? basePath : `${basePath}/`;
    const locatedPaths = located.split("\n").filter((path) => {
      if (!path.startsWith(basePrefix) || path.includes("/node_modules/")
          || path.includes("/.cache/")) return false;
      try { return statSync(path).isFile(); } catch { return false; }
    });
    if (locatedPaths.length > 0) return {
      rows: locatedPaths.slice(0, 100).map((path) => ({
        name: basename(path),
        relativePath: relative(home, path),
        path,
      })),
      totalMatched: Math.min(locatedPaths.length, 100),
      capped: locatedPaths.length > 100,
      complete: located.split("\n").filter(Boolean).length < 300,
    };

    const pattern = query.trim().split(/\s+/).map((part) => part.replace(/[^A-Za-z0-9._-]/g, ""))
      .filter(Boolean).join(".*");
    if (!pattern) return { rows: [], totalMatched: 0, capped: false, complete: true };
    const scan = async (roots, timeout) => Promise.all(roots.map((root) => execFileAsync("fd", [
      "--type", "f", "--hidden", "--ignore-case", "--max-results", "101",
      "--exclude", ".cache", "--exclude", "node_modules", pattern, root,
    ], { timeout, maxBuffer: 2 * 1024 * 1024, signal })
      .then((value) => value.stdout).catch(() => "")));
    // A whole-home traversal is not ordered by relevance and can spend its
    // entire timeout in large hidden trees before reaching Downloads. Search
    // normal user-facing roots first, then fall back to the complete scope.
    const priorityOutputs = await scan(priorityFileRoots, 3000);
    let found = priorityOutputs.join("\n").split("\n").filter(Boolean);
    if (found.length === 0) {
      const outputs = await scan(searchRoots, 15_000);
      found = outputs.join("\n").split("\n").filter(Boolean);
    }
    return { rows: found.slice(0, 100).map((path) => {
      const absolute = resolve(path);
      return {
        name: basename(absolute),
        relativePath: relative(home, absolute),
        path: absolute,
      };
    }), totalMatched: Math.min(found.length, 100), capped: found.length > 100,
    complete: found.length <= 100 };
  } catch { return { rows: [], totalMatched: 0, capped: false, complete: true }; }
}

async function search(message, signal) {
  const query = String(message.query || "").trim();
  if (query.length < 2) {
    emit({ id: message.id, query, basePath, rows: [], totalMatched: 0,
      capped: false, complete: true, repos: [] });
    return;
  }
  latestRepoQuery = query;
  emitCurrentRepos();
  if (!finder || !ready) {
    const result = await fallbackFiles(query, signal);
    emitProgressively(message, query, result);
    return;
  }
  const result = finder.fileSearch(query, { pageSize: 101 });
  if (!result.ok) {
    const fallback = await fallbackFiles(query, signal);
    emitProgressively(message, query, fallback);
    return;
  }
  // Ordinary launcher search should only advertise real textual matches;
  // otherwise a huge home index makes almost any random subsequence look like
  // "100+ files". Explicit @ mode retains FFF's typo-tolerant fuzzy search.
  const indexedItems = result.value.items.filter((item, index) => message.focused === true
    ? usefulFuzzyMatch(item, result.value.scores[index], query)
    : strictFileMatch(item, query));
  const fuzzyCapped = indexedItems.length > 100;
  const visibleItems = indexedItems.slice(0, 100);
  const rows = visibleItems.map((item) => ({
      name: item.fileName,
      relativePath: item.relativePath,
      path: resolve(basePath, item.relativePath),
      size: item.size,
      modified: item.modified,
      gitStatus: item.gitStatus,
    }));
  // FFF can report its scan complete while a newly created file is still
  // absent from its native index. Do not let an empty index result suppress a
  // verified plocate/fd match.
  if (rows.length === 0) {
    const fallback = await fallbackFiles(query, signal);
    emitProgressively(message, query, fallback);
    return;
  }
  const candidatePageComplete = Number(result.value.totalMatched || 0)
    <= result.value.items.length;
  const progressive = {
    rows,
    totalMatched: rows.length,
    capped: fuzzyCapped,
    complete: fuzzyCapped || candidatePageComplete,
  };
  emitProgressively(message, query, progressive);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    latestRequestId = Number(message.id) || 0;
    latestRepoQuery = String(message.query || "").trim();
    emitCurrentRepos();
    if (pendingSearchTimer) clearTimeout(pendingSearchTimer);
    if (activeSearchController) activeSearchController.abort();
    for (const timer of progressiveTimers) clearTimeout(timer);
    progressiveTimers = [];
    pendingSearchTimer = setTimeout(() => {
      pendingSearchTimer = null;
      const controller = new AbortController();
      activeSearchController = controller;
      search(message, controller.signal).finally(() => {
        if (activeSearchController === controller) activeSearchController = null;
      });
    }, 80);
  } catch {}
});

function shutdown() {
  if (pendingSearchTimer) clearTimeout(pendingSearchTimer);
  if (activeSearchController) activeSearchController.abort();
  for (const timer of progressiveTimers) clearTimeout(timer);
  try { finder?.destroy(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
