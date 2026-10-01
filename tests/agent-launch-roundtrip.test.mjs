import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// SOURCE PREPARATION: requires the upcoming canonical qualified-target fix.
// No real desktop, network, tmux, LinuxCollector or harness is used. This
// bridges production launch output to the real shared parser/matcher, not a
// substitute for the separately required live launch/repeat activation gate.
const self = fileURLToPath(import.meta.url);
const matcher = fileURLToPath(new URL("./launch-roundtrip-matcher.py", import.meta.url));

function sharedMatch(request, records) {
  const result = spawnSync("python3", ["-B", "-S", "-E", matcher], {
    input: JSON.stringify({ request, records }), encoding: "utf8",
    timeout: 4000, maxBuffer: 1048576,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

async function replay(transport, socketKind, naming) {
  // Imported only inside a bounded worker: the production adapter owns a
  // stdin listener, so it must not keep the parent test runner alive.
  const { activate, agentIdentity } = await import("../bridge/agentd-hub.js");
  const directory = mkdtempSync(join(tmpdir(), "ask-launch-replay-"));
  const capture = join(directory, "transport.json");
  const socket = socketKind === "name"
    ? { kind: "name", value: "fixture-server" }
    : { kind: "path", value: join(directory, "private.sock") };
  const session = naming === "distinct"
    ? `session-${randomUUID()}` : `review ${randomUUID()} (roundtrip)`;
  const agent = {
    name: naming === "distinct" ? `agent-${randomUUID()}` : session,
    machine: "launch-fixture.invalid", instanceId: "fixture",
    id: { pid: 800, startTimeTicks: "80" },
    tmux: { session, windowIndex: "3", paneId: "%71", socket },
    hubSourceState: "reporting", presence: { state: "present" },
  };
  const windows = [], records = {}, launches = [], focus = [], events = [], requests = [];
  let latestMatch;
  const dependencies = {
    lookupAgent: () => agent, isHubConnected: () => true,
    compositorWindows: async () => windows.map(w => ({ ...w })),
    hyprClientsSnapshot: async () => windows.map(w => ({ ...w, mapped: true, focusHistoryID: 0 })),
    readStartTicks: async () => "100", activeWindowAddress: async () => "",
    focus: async address => { focus.push(address); return true; },
    emit: event => events.push(event),
    showNotice: async () => assert.fail("unexpected notice"),
    which: async name => name === "mosh" && transport === "ssh" ? "" : join(directory, name),
    resolver: { request: async request => {
      requests.push(request.operation);
      if (request.operation === "verify-target") {
        // Explicit synthetic live-target preflight. Only this strict attach
        // prerequisite is faked; every match invokes the maintained core.
        return { status: "verified", verifiedTarget: {
          identity: request.target.identity,
          location: { kind: "tmux", tmux: { ...agent.tmux } },
        } };
      }
      latestMatch = request;
      return sharedMatch(request, records);
    } },
    spawnDetached: async (terminal, args) => {
      launches.push({ terminal, args });
      assert.equal(launches.length, 1, "repeat activation tried to create a duplicate terminal");
      assert.equal(terminal, join(directory, "ghostty"));
      assert.equal(args[0], "-e");
      if (transport === "mosh") {
        assert.deepEqual(args.slice(1, 3), ["sh", "-lc"]);
        assert.equal(args.length, 4);
        // Execute the exact production fallback script, but without login
        // profiles. Both transport executables are recording stubs; neither
        // executes its remote command or contacts a machine.
        const result = spawnSync("/bin/sh", ["-c", args[3]], {
          env: { PATH: directory, ASK_REPLAY_CAPTURE: capture },
          encoding: "utf8", timeout: 2000, maxBuffer: 65536,
        });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
      } else {
        assert.equal(args[1], "ssh");
        const result = spawnSync(join(directory, "ssh"), args.slice(2), {
          env: { ASK_REPLAY_CAPTURE: capture },
          encoding: "utf8", timeout: 2000, maxBuffer: 65536,
        });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
      }
      const captured = JSON.parse(readFileSync(capture, "utf8"));
      assert.equal(captured.command, transport);
      const window = { stableId: "abc", address: "0xabc", pid: 100,
        startTimeTicks: "100", title: "terminal", class: "com.mitchellh.ghostty" };
      // Replay live mosh-client's documented flattened display representation
      // from captured argv, rather than inventing a bare-session command.
      const transportArgv = transport === "mosh"
        ? ["mosh-client", `-# ${captured.args.join(" ")} |`, "192.0.2.4", "60001"]
        : ["ssh", ...captured.args];
      records.abc = { terminalArgv: [terminal, ...args], transportArgv };
      windows.push(window);
      return true;
    },
  };
  try {
    for (const command of ["mosh", "ssh"]) {
      writeFileSync(join(directory, command), `#!${process.execPath}\n`
        + `require('node:fs').writeFileSync(process.env.ASK_REPLAY_CAPTURE, JSON.stringify({command:${JSON.stringify(command)},args:process.argv.slice(2)}));\n`,
      { mode: 0o700 });
    }
    const id = agentIdentity(agent);
    await activate(id, dependencies);
    assert.equal(events[0]?.existing, false);
    await activate(id, dependencies);
    await activate(id, dependencies);
    assert.equal(launches.length, 1);
    assert.deepEqual(focus, ["0xabc", "0xabc"]);
    assert.deepEqual(events.map(event => [event.ok, event.existing]),
      [[true, false], [true, true], [true, true]]);
    assert.deepEqual(requests, ["match", "verify-target", "match", "match", "match", "match"]);

    // Comparable conflicts must not earn location-supporting evidence, but
    // must not erase independent current-title evidence either.
    for (const mismatch of [
      { windowIndex: "4" }, { paneId: "%72" },
      { socket: { kind: socket.kind, value: socket.value + "-different" } },
    ]) {
      const request = structuredClone(latestMatch);
      Object.assign(request.target.tmux, mismatch);
      for (const titled of [false, true]) {
        request.windows[0].title = titled ? agent.name : "terminal";
        const response = sharedMatch(request, records);
        const evidence = response.candidates.flatMap(c => c.match.evidence);
        assert.equal(evidence.some(e => e.code === "transport_host_session_hint"
          && e.result === "supports"), false, JSON.stringify({ mismatch, response }));
        assert.equal(evidence.some(e => e.code === "process_agent_name_hint"
          && e.result === "supports"), false,
        "contradictory launch argv must not regain support through generic process-name matching: "
          + JSON.stringify({ mismatch, response }));
        if (titled) assert.equal(response.status, "matched",
          "a conflict must not veto independent current-title evidence");
      }
    }
    return { transport, socketKind, naming, launches: launches.length, focused: focus.length };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--worker") {
  try {
    console.log(JSON.stringify(await replay(process.argv[3], process.argv[4], process.argv[5])));
    process.exit(0);
  } catch (error) {
    console.error(error.stack);
    process.exit(1);
  }
} else {
  for (const transport of ["ssh", "mosh"]) for (const socketKind of ["name", "path"])
    for (const naming of ["distinct", "equal"]) {
    test(`production ${transport} launch then repeated activation (${socketKind} socket, ${naming} names)`, () => {
      const result = spawnSync(process.execPath, [self, "--worker", transport, socketKind, naming], {
        encoding: "utf8", timeout: 20000, maxBuffer: 1048576,
      });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.deepEqual(JSON.parse(result.stdout), { transport, socketKind, naming, launches: 1, focused: 2 });
    });
  }
}
