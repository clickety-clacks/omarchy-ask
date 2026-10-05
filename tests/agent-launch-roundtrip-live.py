"""Testbed-only actual transport launch/repeat gate; no pre-created window.

Synthetic roster and a fixture-proved attach preflight; actual production
launch command, private SSH/tmux, Ghostty, LinuxCollector and focus dispatch.
The parent owns terminal spawning so cleanup never depends on a Node worker
successfully returning a PID. No installed configuration is changed.
Mosh mode runs the native mosh launcher in loopback-only --local mode; its
SSH bootstrap is explicitly outside this gate. No fabricated mosh display
argv or keys: native mosh starts its own real server and client.
"""
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time


BRIDGE = Path(__file__).resolve().parents[1] / "bridge"
SUPPORT = Path(os.environ.get("ASK_CONNECTION_SUPPORT", ""))
TRANSPORT = os.environ.get("ASK_LIVE_TRANSPORT", "ssh")


def run(argv, timeout=5):
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True,
                            text=True, timeout=timeout, check=True)
    if len(result.stdout) > 1048576:
        raise RuntimeError("oversized fixture output")
    return result.stdout


def node(program):
    return json.loads(run([shutil.which("node"), "--input-type=module", "-e", program], 55))


def clients():
    return json.loads(run(["hyprctl", "clients", "-j"]))


def wait(check, description, seconds=6):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        value = check()
        if value:
            return value
        time.sleep(.05)
    raise RuntimeError(description)


def main():
    if TRANSPORT not in {"ssh", "mosh"}:
        raise RuntimeError("unsupported fixture transport")
    if os.environ.get("ASK_TESTBED") != "1" or os.environ.get("ASK_LAUNCH_REPEAT_LIVE") != "1":
        raise RuntimeError("explicit test-machine opt-in required (ASK_TESTBED=1)")
    if not os.environ.get("HYPRLAND_INSTANCE_SIGNATURE") or not os.environ.get("WAYLAND_DISPLAY"):
        raise RuntimeError("desktop environment required")
    if clients():
        raise RuntimeError("test requires an empty dedicated desktop")
    spec = importlib.util.spec_from_file_location("ask_connection", SUPPORT / "connection_fixture.py")
    connection = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = connection
    spec.loader.exec_module(connection)
    private = connection.private_sshd
    if not connection.live_test_authorized():
        raise RuntimeError("connection fixture opt-in required")
    mosh = None
    if TRANSPORT == "mosh":
        spec = importlib.util.spec_from_file_location("ask_live_mosh", SUPPORT / "private_mosh_fixture.py")
        mosh = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mosh
        spec.loader.exec_module(mosh)
    root = Path(tempfile.mkdtemp(prefix="ask-live-launch-"))
    token = secrets.token_hex(5)
    previous_workspace = json.loads(run(["hyprctl", "activeworkspace", "-j"]))["name"]
    pane_record = {}
    terminal = identity = None
    cleanup_ok = False
    launch_count = 0
    repeat_results = []
    fixture = None
    fixture_entered = False
    mosh_identity = None
    mosh_inode = None
    port = 49152 + secrets.randbelow(16000)

    def stop_proven(owned):
        for attempt in range(3):
            if terminal is not None:
                terminal.poll()
            try:
                private._terminate_identities(owned, 1)
                return
            except (private.PrivateSshdSafetyError, private.PrivateSshdUnavailable):
                if attempt == 2:
                    raise
                time.sleep(.05)

    def stop_mosh_server():
        # Closing the client can make its server exit between the initial
        # identity/UDP check and descendant discovery. Retry that observation
        # boundary as well as termination, always against the original proof.
        for attempt in range(3):
            try:
                if private._process_is_gone(mosh_identity):
                    return
                assert mosh._prove_udp_server(mosh_identity, port) == mosh_inode
                stop_proven(private._descendants(mosh_identity) + [mosh_identity])
                return
            except (private.PrivateSshdSafetyError, private.PrivateSshdUnavailable,
                    mosh.PrivateMoshSafetyError):
                if attempt == 2:
                    raise
                time.sleep(.05)

    def setup(pane):
        pane_record["pane"] = pane
        location = {"session": pane.session, "windowIndex": pane.window_index,
                    "paneId": pane.pane_id,
                    "socket": {"kind": "path", "value": str(pane.socket_path)}}
        command = node(
            f"import {{tmuxAttachCommand}} from {json.dumps((BRIDGE / 'agentd-hub.js').as_uri())};"
            f"console.log(JSON.stringify(tmuxAttachCommand({json.dumps({'tmux': location})})));process.exit(0);")
        pane_record.update(location=location, command=command)
        return [connection.SetupCommand(command, original_command=command)]

    def activation(agent, allow_launch):
        # No fake match result, compositor snapshot, process identity or focus.
        # Only verification of the private pane is supplied from the fixture's
        # observed PID/start/session/window/pane, avoiding an unrelated remote
        # probe protocol in this narrowly scoped launch round-trip gate.
        return node(f"""
          import {{activate,agentIdentity}} from {json.dumps((BRIDGE / 'agentd-hub.js').as_uri())};
          import {{createResolverClient}} from {json.dumps((BRIDGE / 'agent-window-resolver.js').as_uri())};
          const agent={json.dumps(agent)}, events=[], launches=[], matches=[], notices=[];
          const client=createResolverClient();
          await activate(agentIdentity(agent),{{
            lookupAgent:()=>agent,isHubConnected:()=>true,
            which:async n=>n==='mosh'?{json.dumps('/usr/bin/mosh' if TRANSPORT == 'mosh' else '')}:n==='ghostty'?'/usr/bin/ghostty':'/usr/bin/'+n,
            resolver:{{request:async r=>{{
              if(r.operation==='verify-target')return {{status:'verified',verifiedTarget:{{
                identity:r.target.identity,location:{{kind:'tmux',tmux:agent.tmux}}}}}};
              const response=await client.request(r);matches.push(response);return response;
            }}}},
            emit:e=>events.push(e),showNotice:async()=>notices.push('notice'),
            spawnDetached:async (exe,args)=>{{launches.push({{exe,args}});return {str(allow_launch).lower()};}},
          }});
          console.log(JSON.stringify({{events,launches,matches,notices}}));process.exit(0);
        """)

    try:
        fixture = connection.ConnectionFixture(session=f"session-{token}", command_factory=setup)
        fixture.__enter__()
        fixture_entered = True
        pane = pane_record["pane"]
        host = fixture.host_alias if TRANSPORT == "ssh" else "127.0.0.1"
        agent = {"machine": host, "instanceId": "owned-fixture",
                 "name": f"agent-{secrets.token_hex(5)}",
                 "id": {"pid": pane.pane_pid, "startTimeTicks": str(pane.pane_start_ticks)},
                 "tmux": pane_record["location"],
                 "hubSourceState": "reporting", "presence": {"state": "present"}}
        first = activation(agent, True)
        assert not first["notices"] and len(first["launches"]) == 1, first
        assert first["events"][0]["ok"] and not first["events"][0]["existing"], first
        launch = first["launches"][0]
        expected = ["-e", "ssh", "-tt", "--", fixture.host_alias, pane_record["command"]]
        if TRANSPORT == "mosh":
            script = node(
                f"import {{transportLaunchScript}} from {json.dumps((BRIDGE / 'agentd-hub.js').as_uri())};"
                f"console.log(JSON.stringify(transportLaunchScript({json.dumps(host)},"
                f"{json.dumps(pane_record['location'])})));process.exit(0);")
            expected = ["-e", "sh", "-lc", script]
        assert launch == {"exe": "/usr/bin/ghostty", "args": expected}, launch
        # Test-only routing supplies private SSH credentials/config; it does
        # not rewrite the production host or remote tmux command.
        shim = root / "ssh"
        shim.write_text("#!/bin/sh\nexec /usr/bin/ssh -F "
                        + shlex.quote(str(fixture.ssh_config)) + ' "$@"\n')
        shim.chmod(0o700)
        environment = dict(os.environ, PATH=f"{root}:/usr/bin:/bin")
        if TRANSPORT == "mosh":
            # Private UDP endpoint must be free before a launch is possible.
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as reservation:
                reservation.bind(("127.0.0.1", port))
            # Preserve all product host/remote-command args. Only native
            # mosh's bootstrap is routed to loopback-local test infrastructure.
            (root / "mosh").write_text("#!/bin/sh\nexec /usr/bin/mosh --local "
                f'--family=inet --bind-server=127.0.0.1 --port={port} "$@"\n')
            (root / "mosh").chmod(0o700)
            shim.write_text("#!/bin/sh\nexit 97\n")  # SSH fallback must not escape fixture.
            (root / ".profile").write_text("export PATH=" + shlex.quote(str(root))
                + ":/usr/bin:/bin\nexport LANG=C.UTF-8\n")
            environment.update(HOME=str(root), MOSH_SERVER_NETWORK_TMOUT="10",
                               LANG="C.UTF-8", TERM="xterm-256color")
        terminal = subprocess.Popen([launch["exe"], "--config-default-files=false",
            "--gtk-single-instance=false", "--confirm-close-surface=false",
            "--title=terminal", *launch["args"]], env=environment,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        launch_count += 1
        identity = private._process_identity(terminal.pid, Path(launch["exe"]))
        window = wait(lambda: next((w for w in clients() if w["pid"] == terminal.pid), None),
                      "launched Ghostty did not map")
        assert window.get("title") == "terminal", "live title must not supply session/name evidence"
        key = (window["stableId"], window["address"], window["pid"], identity.start_ticks)

        def tmux_clients():
            return run(fixture._tmux_command("list-clients", "-F",
                "#{client_pid}\t#{client_session}\t#{window_index}\t#{pane_id}")).strip().splitlines()

        expected_tail = [pane.session, pane.window_index, pane.pane_id]
        attached = wait(lambda: (rows if len(rows := tmux_clients()) == 1
            and rows[0].split("\t")[1:] == expected_tail else None), "SSH did not attach exact pane")
        client_pid = int(attached[0].split("\t")[0])
        tmux_identity = private._process_identity(client_pid)
        if TRANSPORT == "mosh":
            # Adopt only the ancestor of OUR exact tmux client which owns OUR
            # loopback UDP port. Never search/kill by a process-name glob.
            parent = client_pid
            for _ in range(12):
                proof = private._process_identity(parent)
                if proof.executable == Path("/usr/bin/mosh-server"):
                    mosh_identity = proof
                    mosh_inode = mosh._prove_udp_server(proof, port)
                    break
                _state, parent, _ticks = private._proc_fields(parent)
                private._assert_process(proof)
                if parent <= 1:
                    break
            if mosh_identity is None:
                raise RuntimeError("cannot prove private mosh-server ancestry/UDP ownership")
        workspace = "ask-roundtrip-" + token
        run(["hyprctl", "eval", 'hl.dispatch(hl.dsp.window.move({workspace='
             + json.dumps("name:" + workspace) + ',window='
             + json.dumps("address:" + window["address"]) + ',follow=false}))'])
        for _ in range(2):
            run(["hyprctl", "eval", 'hl.dispatch(hl.dsp.focus({workspace='
                 + json.dumps("name:ask-empty-" + token) + '}))'])
            result = activation(agent, False)
            assert not result["launches"] and not result["notices"], result
            assert result["events"][0]["ok"] and result["events"][0]["existing"], result
            assert len(result["matches"]) == 2, result
            for response in result["matches"]:
                candidate = next((c for c in response["candidates"]
                    if c["window"]["stableId"] == window["stableId"]), None)
                assert candidate is not None, response
                assert any(e.get("code") == "transport_host_session_hint"
                    and e.get("result") == "supports" for e in candidate["match"]["evidence"]), response
            focused = json.loads(run(["hyprctl", "activewindow", "-j"]))
            assert focused["address"] == window["address"]
            assert focused["workspace"]["name"] == workspace
            current = clients()
            assert current[0].get("title") == "terminal", "repeat title must remain generic"
            assert len(current) == 1 and (current[0]["stableId"], current[0]["address"],
                current[0]["pid"], private._process_identity(terminal.pid).start_ticks) == key
            private._assert_process(tmux_identity)
            if mosh_identity is not None:
                assert mosh._prove_udp_server(mosh_identity, port) == mosh_inode
            assert tmux_clients() == attached
            repeat_results.append({"existing": True, "newLaunches": 0, "focused": True})
        print(json.dumps({"phase": "behavior-complete", "terminalLaunches": launch_count,
            "attachmentCount": len(attached), "repeats": repeat_results}), flush=True)
    except BaseException as error:
        print(json.dumps({"phase": "behavior-failed", "error": type(error).__name__,
            "detail": str(error), "fixtureRoot": str(root)}), flush=True)
        raise
    finally:
        if terminal is not None:
            if identity is None and terminal.poll() is None:
                raise RuntimeError(f"unproven terminal retained: {terminal.pid}; {root}")
            if identity is not None and not private._process_is_gone(identity):
                private._assert_process(identity)
                owned = private._descendants(identity) + [identity]
                # An exiting descendant can lose /proc/exe before its state
                # becomes a zombie. Retry the SAME strict identity-checked
                # cleanup; never treat an unreadable executable as proof of
                # exit or fall back to unverified signals. Persistent failure
                # still preserves fixture state and raises.
                stop_proven(owned)
            terminal.wait(timeout=3)
            if TRANSPORT == "mosh":
                if mosh_identity is None:
                    raise RuntimeError(f"unproven mosh creation; preserving {root} and {fixture.root}")
                stop_mosh_server()
        if fixture_entered:
            fixture.__exit__(None, None, None)
        if clients():
            raise RuntimeError(f"desktop cleanup incomplete; preserving {root}")
        run(["hyprctl", "eval", 'hl.dispatch(hl.dsp.focus({workspace='
             + json.dumps(previous_workspace) + '}))'])
        shutil.rmtree(root)
        cleanup_ok = True
    print(json.dumps({"transport": TRANSPORT, "terminalLaunches": launch_count,
        "attachmentCount": 1, "repeats": repeat_results, "cleanupVerified": cleanup_ok}))


if __name__ == "__main__":
    main()
