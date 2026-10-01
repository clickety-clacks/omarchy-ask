#!/usr/bin/env node

// One bounded, streaming file scan per partition. The coordinator owns this
// process group (including fd), so a blocked stat cannot hold up other scans
// or escape query cancellation. Reuse the existing bounded NUL reader.
import { statSync } from "node:fs";
import { StreamSource } from "./file-search.js";

let stopped = false;
const source = new StreamSource({
  id: "files", kind: "files", command: "fd", args: process.argv.slice(2),
  detached: false,
  onRecord(path) {
    if (stopped) return;
    let modifiedMs = null;
    try { modifiedMs = statSync(path).mtimeMs; }
    catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return; }
    process.stdout.write(JSON.stringify({ path, modifiedMs }) + "\0");
  },
  onTerminal(result) {
    process.exitCode = result.status === "exhausted" ? 0 : 1;
  },
});
function stop() {
  if (stopped) return;
  stopped = true;
  source.cancel();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.stdout.on("error", stop);
source.start();
