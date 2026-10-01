import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

test("real file bridge finds a fresh Pictures file before and after initial search", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-files-bridge-"));
  const pictures = join(root, "Pictures");
  mkdirSync(pictures);
  const first = "screenshot-2026-09-15_18-08-34.png";
  writeFileSync(join(pictures, first), "fixture");
  const child = spawn(process.execPath, [new URL("../bridge/files.js", import.meta.url).pathname], {
    env: { ...process.env, HOME: root, ASK_FILE_ROOT: root,
      XDG_CONFIG_HOME: join(root, ".config"), XDG_CACHE_HOME: join(root, ".cache"),
      XDG_DATA_HOME: join(root, ".local/share"), XDG_STATE_HOME: join(root, ".local/state") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
  async function find(id, name, focused) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`No result for ${name}: ${stderr}`)), 20000);
      const exited = () => finish(new Error(`bridge exited: ${stderr}`));
      const received = line => {
        let value;
        try { value = JSON.parse(line); } catch { return; }
        if (value.id === id && value.rows?.some(row => row.path === join(pictures, name)))
          finish(null, value);
      };
      function finish(error, value) {
        clearTimeout(timer);
        child.off("exit", exited);
        lines.off("line", received);
        if (error) reject(error); else resolve(value);
      }
      lines.on("line", received);
      child.once("exit", exited);
      child.stdin.write(JSON.stringify({ id, query: name, focused }) + "\n");
    });
  }
  try {
    const ordinary = await find(1, first, false);
    assert.equal(ordinary.rows[0].name, first);
    const fresh = "new-capture_[2]+edited.png";
    writeFileSync(join(pictures, fresh), "new fixture");
    const focused = await find(2, fresh, true);
    assert.equal(focused.rows[0].name, fresh);
  } finally {
    lines.close();
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await closed;
    clearTimeout(killTimer);
    rmSync(root, { recursive: true, force: true });
  }
});
