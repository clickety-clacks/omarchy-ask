// Test-only subprocess boundary: ordinary partitions use real fd; designated
// partitions stream a delayed result and then remain alive until canceled.
// This is not a replacement search implementation.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const settings = JSON.parse(readFileSync(process.env.ASK_TEST_STREAM_PLAN, "utf8"));
const root = args.at(-1);
const source = settings.slowSources.find(item => item.root === root);
appendFileSync(settings.processLog, JSON.stringify({ pid: process.pid, root, args }) + "\n");

if (!source) {
  const child = spawn("/usr/bin/fd", args, { stdio: "inherit" });
  child.on("error", () => process.exit(127));
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
} else {
  const isRepo = args.includes("^\\.git$");
  const record = isRepo ? source.repoPath : source.filePath;
  const delimiter = args.includes("--print0") || args.includes("-0") ? "\0" : "\n";
  setTimeout(() => {
    if (record) process.stdout.write(record + delimiter);
    if (source.readyFile) writeFileSync(source.readyFile, String(process.pid));
  }, source.delayMs ?? 300);
  setInterval(() => {}, 1000);
}
