import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createResolverClient } from "../bridge/agent-window-resolver.js";

// Explicit desktop opt-in: creates, focuses, and closes one owned terminal.
// Never targets a pre-existing window, tmux client, or SSH connection.
test("bundled resolver matches a real owned Hyprland terminal", {
  skip: process.env.ASK_RESOLVER_WINDOW_TEST !== "1",
  timeout: 90000,
}, async () => {
  assert.ok(process.env.HYPRLAND_INSTANCE_SIGNATURE);
  assert.ok(process.env.WAYLAND_DISPLAY);
  const clients = () => JSON.parse(execFileSync("hyprctl", ["-j", "clients"], {
    timeout: 2000, maxBuffer: 262144, encoding: "utf8",
  }));
  const ticks = async pid => {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  };
  const descendant = async root => {
    const queue = [root], seen = new Set(), matches = [];
    while (queue.length) {
      const pid = queue.shift();
      if (seen.has(pid)) continue;
      seen.add(pid);
      assert.ok(seen.size <= 128, "owned process tree exceeded test bound");
      const tasks = await readdir(`/proc/${pid}/task`);
      assert.ok(tasks.length <= 256);
      for (const tid of tasks) {
        const raw = await readFile(`/proc/${pid}/task/${tid}/children`, "utf8");
        queue.push(...raw.trim().split(/\s+/).filter(Boolean).map(Number));
      }
      if (pid !== root) {
        const before = await ticks(pid);
        const argv = await readFile(`/proc/${pid}/cmdline`, "utf8");
        if ((argv === ["/usr/bin/sleep", "25", ""].join("\0")
            || argv === ["sleep", "25", ""].join("\0"))
            && await readlink(`/proc/${pid}/exe`) === "/usr/bin/sleep")
          matches.push({ pid, startTimeTicks: before });
        assert.equal(await ticks(pid), before);
      }
    }
    assert.ok(matches.length <= 1, "ambiguous owned sleep descendants");
    return matches[0];
  };
  const terminal = spawn("/usr/bin/ghostty", [
    "--config-default-files=false", "--gtk-single-instance=false",
    "--confirm-close-surface=false", "-e", "/usr/bin/sleep", "25",
  ], { stdio: "ignore" });
  let spawnError;
  terminal.on("error", error => { spawnError = error; });
  const closed = new Promise(resolve => terminal.once("close", resolve));
  let payload;
  try {
    let window;
    for (let n = 0; n < 50; n++) {
      if (spawnError) throw spawnError;
      assert.equal(terminal.exitCode, null, "owned terminal exited before mapping");
      const found = clients().filter(item => item.pid === terminal.pid);
      assert.ok(found.length <= 1, "owned terminal has ambiguous windows");
      if (found.length) { window = found[0]; break; }
      await delay(100);
    }
    assert.ok(window, "owned terminal did not map");
    const startTimeTicks = await ticks(terminal.pid);
    for (let n = 0; n < 30 && !payload; n++) {
      payload = await descendant(terminal.pid);
      if (!payload) await delay(100);
    }
    assert.ok(payload, "owned sleep descendant did not start");
    assert.match(window.stableId, /^[0-9a-f]+$/i);
    const request = {
      schema: "agent-window-resolver.request.v1", requestId: "owned-window-1",
      operation: "resolve", requestedRelation: "visible_exact",
      target: { identity: { machine: hostname(), instanceId: "owned-terminal-child",
        ...payload } },
      local: { machine: hostname() },
      windows: [{ stableId: window.stableId, address: window.address,
        pid: terminal.pid, startTimeTicks }],
    };
    const client = createResolverClient();
    const result = await client.request(request);
    assert.equal(result.status, "matched", JSON.stringify(result.reasons));
    assert.deepEqual(await descendant(terminal.pid), payload);
    const repeated = await client.request({ ...request, requestId: "owned-window-2",
      operation: "revalidate", prior: result.candidates[0] });
    assert.equal(repeated.status, "matched", JSON.stringify(repeated.reasons));
    // Only the roster is synthetic. Resolution, current desktop/proc checks,
    // and focus use Ask's production activation defaults.
    const agent = { machine: hostname(), instanceId: "owned-terminal-child",
      id: payload, hubSourceState: "reporting", presence: { state: "present" } };
    const activation = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { activate, agentIdentity } from ${JSON.stringify(new URL("../bridge/agentd-hub.js", import.meta.url).href)};
      const agent = ${JSON.stringify(agent)};
      const events = [], notices = [];
      await activate(agentIdentity(agent), {
        lookupAgent: () => agent, isHubConnected: () => true,
        emit: event => events.push(event), showNotice: async (...args) => notices.push(args),
        spawnDetached: async () => { throw new Error("unexpected new attachment"); },
      });
      process.stdout.write(JSON.stringify({ events, notices }));
      process.exit(0);
    `], { encoding: "utf8", timeout: 50000, maxBuffer: 262144 });
    assert.equal(activation.status, 0, activation.stderr);
    const outcome = JSON.parse(activation.stdout);
    assert.equal(outcome.notices.length, 0, JSON.stringify(outcome));
    assert.equal(outcome.events.length, 1, JSON.stringify(outcome));
    assert.equal(outcome.events[0].ok, true, JSON.stringify(outcome));
    assert.equal(outcome.events[0].existing, true);
    const active = JSON.parse(execFileSync("hyprctl", ["-j", "activewindow"], {
      timeout: 2000, maxBuffer: 262144, encoding: "utf8",
    }));
    assert.equal(active.stableId, window.stableId);
    const fresh = clients().filter(item => item.pid === terminal.pid);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].address, window.address);
    assert.equal(fresh[0].stableId, window.stableId);
    assert.equal(await ticks(terminal.pid), startTimeTicks);
  } finally {
    // ChildProcess retains ownership of this unreaped child; never kill by a
    // compositor-provided PID, wildcard, process name, or global tmux target.
    if (terminal.exitCode === null && terminal.signalCode === null) terminal.kill("SIGTERM");
    await Promise.race([closed, delay(2000)]);
    if (terminal.exitCode === null && terminal.signalCode === null) terminal.kill("SIGKILL");
    await closed;
    if (payload) {
      // The payload has a finite lifetime. Wait for its exit without risking a
      // PID-reuse race by signalling a grandchild through a numeric PID.
      let gone = false;
      for (let n = 0; n < 260; n++) {
        try { gone = (await ticks(payload.pid)) !== payload.startTimeTicks; }
        catch (error) {
          if (error.code === "ENOENT" || error.code === "ESRCH") gone = true;
          else throw error;
        }
        if (gone) break;
        await delay(100);
      }
      assert.ok(gone, "owned terminal child survived its bounded lifetime");
    }
    for (let n = 0; n < 20 && clients().some(item => item.pid === terminal.pid); n++)
      await delay(100);
    assert.equal(clients().some(item => item.pid === terminal.pid), false,
      "owned terminal window survived cleanup");
  }
});
