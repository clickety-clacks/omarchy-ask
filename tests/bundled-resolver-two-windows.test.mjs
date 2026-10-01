import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createResolverClient } from "../bridge/agent-window-resolver.js";

// Explicit isolated-desktop opt-in. The test requires an empty Hyprland
// desktop, creates and focuses only two owned Ghostty windows, and never opens
// a real remote connection or attaches to a tmux client.
test("best-effort activation selects the active of two matching owned windows", {
  skip: process.env.ASK_RESOLVER_TWO_WINDOWS_TEST !== "1",
  timeout: 120000,
}, async () => {
  assert.ok(process.env.HYPRLAND_INSTANCE_SIGNATURE);
  assert.ok(process.env.WAYLAND_DISPLAY);

  const originalPath = process.env.PATH;
  const originalGuard = process.env.ASK_RESOLVER_SSH_GUARD;
  const guardDirectory = await mkdtemp(join(tmpdir(), "ask-two-window-"));
  const guardMarker = join(guardDirectory, "ssh-invoked");
  const sshGuard = join(guardDirectory, "ssh");
  await writeFile(sshGuard,
    "#!/bin/sh\n: > \"$ASK_RESOLVER_SSH_GUARD\"\nexit 97\n", { mode: 0o700 });
  await chmod(sshGuard, 0o700);
  for (const command of ["mosh", "mosh-client", "mosh-server"])
    await writeFile(join(guardDirectory, command),
      "#!/bin/sh\n: > \"$ASK_RESOLVER_SSH_GUARD\"\nexit 97\n", { mode: 0o700 });
  process.env.PATH = `${guardDirectory}:${originalPath || "/usr/bin:/bin"}`;
  process.env.ASK_RESOLVER_SSH_GUARD = guardMarker;

  const clients = () => JSON.parse(execFileSync("hyprctl", ["-j", "clients"], {
    timeout: 2000, maxBuffer: 262144, encoding: "utf8",
  })).filter(item => item?.mapped === true);
  const activeWindow = () => JSON.parse(execFileSync("hyprctl", ["-j", "activewindow"], {
    timeout: 2000, maxBuffer: 262144, encoding: "utf8",
  }));
  const ticks = async pid => {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  };
  const sleepDescendant = async root => {
    const queue = [root], seen = new Set(), matches = [];
    while (queue.length) {
      const pid = queue.shift();
      if (seen.has(pid)) continue;
      seen.add(pid);
      assert.ok(seen.size <= 128, "owned process tree exceeded test bound");
      const tasks = await readdir(`/proc/${pid}/task`);
      assert.ok(tasks.length <= 256, "owned process thread count exceeded test bound");
      for (const tid of tasks) {
        const raw = await readFile(`/proc/${pid}/task/${tid}/children`, "utf8");
        queue.push(...raw.trim().split(/\s+/).filter(Boolean).map(Number));
      }
      if (pid !== root) {
        const before = await ticks(pid);
        const argv = await readFile(`/proc/${pid}/cmdline`, "utf8");
        if ((argv === ["/usr/bin/sleep", "45", ""].join("\0")
            || argv === ["sleep", "45", ""].join("\0"))
            && await readlink(`/proc/${pid}/exe`) === "/usr/bin/sleep")
          matches.push({ pid, startTimeTicks: before });
        assert.equal(await ticks(pid), before);
      }
    }
    assert.ok(matches.length <= 1, "ambiguous owned sleep descendants");
    return matches[0];
  };
  const identityKey = async item => JSON.stringify([
    String(item.stableId), String(item.address).toLowerCase(), Number(item.pid),
    await ticks(Number(item.pid)),
  ]);
  const snapshotKeys = async () => (await Promise.all(clients().map(identityKey))).sort();
  const terminalRecords = [];
  const spawnTerminal = title => {
    const child = spawn("/usr/bin/ghostty", [
      "--config-default-files=false", "--gtk-single-instance=false",
      "--confirm-close-surface=false", `--title=${title}`,
      "-e", "/usr/bin/sleep", "45",
    ], { stdio: "ignore" });
    const record = { child, spawnError: null, payload: null,
      closed: new Promise(resolve => child.once("close", resolve)) };
    child.on("error", error => { record.spawnError = error; });
    terminalRecords.push(record);
    return record;
  };
  const waitForWindow = async (record, title) => {
    for (let n = 0; n < 60; n++) {
      if (record.spawnError) throw record.spawnError;
      assert.equal(record.child.exitCode, null, "owned terminal exited before mapping");
      const found = clients().filter(item => item.pid === record.child.pid);
      assert.ok(found.length <= 1, "owned terminal has ambiguous windows");
      if (found.length && found[0].title === title) return found[0];
      await delay(100);
    }
    assert.fail("owned terminal did not map with its requested title");
  };
  const waitForPayload = async record => {
    for (let n = 0; n < 30; n++) {
      record.payload = await sleepDescendant(record.child.pid);
      if (record.payload) return record.payload;
      await delay(100);
    }
    assert.fail("owned sleep descendant did not start");
  };
  const waitForIdentityGone = async identity => {
    if (!identity) return;
    let gone = false;
    for (let n = 0; n < 460; n++) {
      try { gone = (await ticks(identity.pid)) !== identity.startTimeTicks; }
      catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) gone = true; else throw error; }
      if (gone) break;
      await delay(100);
    }
    assert.ok(gone, `owned terminal child ${identity.pid} survived its bounded lifetime`);
  };

  try {
    assert.deepEqual(clients(), [], "isolated desktop has pre-existing windows");
    const title = `0_1_9-ask-two-${process.pid}-${Date.now()}`;
    const first = spawnTerminal(title);
    const firstWindow = await waitForWindow(first, title);
    await waitForPayload(first);
    const second = spawnTerminal(title);
    const secondWindow = await waitForWindow(second, title);
    await waitForPayload(second);

    for (const window of [firstWindow, secondWindow]) {
      assert.match(window.stableId, /^[0-9a-f]+$/i);
      assert.match(window.address, /^0x[0-9a-f]+$/i);
    }
    assert.notEqual(firstWindow.stableId, secondWindow.stableId);
    assert.notEqual(firstWindow.address, secondWindow.address);
    const expectedKeys = await snapshotKeys();
    assert.equal(expectedKeys.length, 2, "isolated desktop did not contain exactly two owned windows");

    // Establish an unambiguous active/MRU preference without touching any
    // pre-existing window. Both candidates otherwise have equal match scores.
    execFileSync("hyprctl", ["eval",
      `hl.dispatch(hl.dsp.focus({ window = \"address:${firstWindow.address}\" }))`], {
        timeout: 2000, maxBuffer: 262144, encoding: "utf8",
      });
    assert.equal(activeWindow().stableId, firstWindow.stableId);
    const selectionSnapshot = clients();
    const activeClient = selectionSnapshot.find(item => item.stableId === firstWindow.stableId);
    const otherClient = selectionSnapshot.find(item => item.stableId === secondWindow.stableId);
    assert.equal(activeClient.focusHistoryID, 0);
    assert.ok(Number.isInteger(otherClient.focusHistoryID)
      && otherClient.focusHistoryID > activeClient.focusHistoryID);

    const windows = [];
    for (const item of selectionSnapshot) {
      windows.push({ stableId: String(item.stableId), address: String(item.address).toLowerCase(),
        pid: Number(item.pid), startTimeTicks: await ticks(Number(item.pid)),
        class: String(item.class || ""), title: String(item.title || "") });
    }
    const target = {
      identity: { machine: "gibson.invalid", instanceId: `two-window-${process.pid}`,
        pid: 4000000, startTimeTicks: "9" },
      tmux: { session: "0_1_9", windowIndex: "0", paneId: "%1",
        socket: { kind: "path", value: "/tmp/ask-two-window-unused.sock" } },
      name: title,
    };
    const result = await createResolverClient().request({
      schema: "agent-window-resolver.request.v1", requestId: "owned-two-window-match",
      operation: "match", target, local: { machine: hostname() }, windows,
    });
    assert.equal(result.status, "matched", JSON.stringify(result.reasons));
    assert.equal(result.candidates.length, 2, "resolver did not retain both eligible title matches");
    assert.equal(new Set(result.candidates.map(item => item.match.score)).size, 1,
      "owned title matches did not have equal rank");
    assert.deepEqual(result.candidates.map(item => item.window.stableId).sort(),
      [firstWindow.stableId, secondWindow.stableId].sort());
    for (const candidate of result.candidates) {
      assert.ok(candidate.match.evidence.some(item =>
        item.code === "window_title_target_name" && item.result === "supports"));
      assert.ok(clients().some(item => item.stableId === candidate.window.stableId
        && String(item.address).toLowerCase() === candidate.window.address
        && Number(item.pid) === candidate.window.pid));
    }
    assert.deepEqual(await snapshotKeys(), expectedKeys, "matching changed the desktop window set");
    assert.equal(existsSync(guardMarker), false, "best-effort matching attempted SSH");

    const agent = { name: title, machine: target.identity.machine,
      instanceId: target.identity.instanceId,
      id: { pid: target.identity.pid, startTimeTicks: target.identity.startTimeTicks },
      tmux: target.tmux, hubSourceState: "reporting", presence: { state: "present" } };
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
    `], { encoding: "utf8", timeout: 65000, maxBuffer: 262144 });
    assert.equal(activation.status, 0, activation.stderr);
    const outcome = JSON.parse(activation.stdout);
    assert.equal(outcome.notices.length, 0, JSON.stringify(outcome));
    assert.deepEqual(outcome.events, [{ type: "activation",
      id: JSON.stringify([agent.machine, agent.instanceId, agent.id.pid,
        agent.id.startTimeTicks]), ok: true, existing: true }]);
    assert.equal(activeWindow().stableId, firstWindow.stableId,
      "activation did not preserve the active/MRU candidate preference");
    assert.deepEqual(await snapshotKeys(), expectedKeys,
      "activation opened, closed, or substituted a window");
    assert.equal(existsSync(guardMarker), false, "activation attempted SSH");
  } finally {
    try {
      for (const record of terminalRecords) {
        if (!record.payload && record.child.pid && record.child.exitCode === null) {
          try { record.payload = await sleepDescendant(record.child.pid); } catch {}
        }
      }
      for (const record of terminalRecords)
        if (record.child.exitCode === null && record.child.signalCode === null)
          record.child.kill("SIGTERM");
      await Promise.all(terminalRecords.map(async record => {
        await Promise.race([record.closed, delay(2000)]);
        if (record.child.exitCode === null && record.child.signalCode === null)
          record.child.kill("SIGKILL");
        await record.closed;
      }));
      await Promise.all(terminalRecords.map(record => waitForIdentityGone(record.payload)));
      for (let n = 0; n < 30 && clients().length; n++) await delay(100);
      assert.deepEqual(clients(), [], "owned terminal windows survived cleanup");
      assert.equal(existsSync(guardMarker), false, "cleanup observed an unexpected SSH attempt");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalGuard === undefined) delete process.env.ASK_RESOLVER_SSH_GUARD;
      else process.env.ASK_RESOLVER_SSH_GUARD = originalGuard;
      await rm(guardDirectory, { recursive: true, force: true });
    }
  }
});
