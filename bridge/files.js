#!/usr/bin/env node

import { createInterface } from "node:readline";
import { join } from "node:path";
import { FileSearchCoordinator } from "./file-search.js";

const coordinator = new FileSearchCoordinator({
  basePath: process.env.ASK_FILE_ROOT || process.env.HOME || process.cwd(),
  home: process.env.HOME || process.cwd(),
  settingsPath: process.env.ASK_FILE_SETTINGS
    || join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || process.cwd(), ".config"),
      "omarchy", "ask.json"),
  repoDepth: process.env.ASK_REPO_SEARCH_DEPTH,
  enableIndex: process.env.ASK_DISABLE_FILE_INDEX !== "1",
  emit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
});

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  try {
    coordinator.request(JSON.parse(line));
  } catch {
    // One malformed protocol line must not take down the long-lived bridge.
  }
});

let shutdownPromise = null;
function shutdown(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  let resolveShutdown;
  shutdownPromise = new Promise((resolve) => { resolveShutdown = resolve; });
  input.close();
  coordinator.close().finally(() => {
    resolveShutdown();
    process.exit(exitCode);
  });
  return shutdownPromise;
}
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") { shutdown(0); return; }
  shutdown(1);
});
input.on("close", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
