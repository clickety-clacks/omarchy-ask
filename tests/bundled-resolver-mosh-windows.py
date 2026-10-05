"""Testbed-only two-window real-mosh activation gate.

This opt-in test imports Yoohoo's reviewed private tmux/sshd/mosh lifecycle,
starts two loopback mosh servers for one private tmux pane, and launches two
owned Ghostty windows whose exact mosh-client argv carry normal ``-#`` display
hints.  MOSH_KEY values exist only in process memory/environment and are never
printed or written.  The roster is synthetic; window collection, matching,
selection, revalidation and focus use Ask's production code.
"""
from __future__ import annotations

from dataclasses import dataclass
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time


OPT_IN = "ASK_BUNDLED_MOSH_WINDOWS_LIVE"
SUPPORT_ENV = "ASK_MOSH_SUPPORT_ROOT"
SUPPORT_DEFAULT = Path("~/Projects/yoohoo-hub-work/tests/integration")
REPO = Path(__file__).resolve().parents[1]
BRIDGE = Path(os.environ.get("ASK_MOSH_BRIDGE_ROOT", str(REPO / "bridge"))).resolve()
MAX_OUTPUT = 256 * 1024
MAX_WINDOWS = 64
POLL = 0.05
WAIT = 6.0
_ADDRESS = re.compile(r"^0x[0-9a-f]{1,32}$")
_STABLE = re.compile(r"^[0-9a-f]{1,256}$")


class GateFailure(RuntimeError):
    pass


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise GateFailure(f"missing reviewed support: {path.name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


support_root = Path(os.environ.get(SUPPORT_ENV, str(SUPPORT_DEFAULT))).resolve()
startup = _load("_ask_private_mosh_startup", support_root / "private_mosh_smoke.py")
connection = startup.connection
mosh = startup.mosh
private_sshd = mosh.private_sshd


@dataclass
class OwnedWindow:
    process: subprocess.Popen[bytes]
    identity: object | None
    argv: tuple[str, ...]
    mosh_identity: object | None = None
    window: dict[str, object] | None = None


def _authorized() -> None:
    if os.environ.get(OPT_IN, "").strip() != "1":
        raise GateFailure(f"set {OPT_IN}=1 for the reviewed Testbed gate")
    if os.environ.get(startup.MOSH_OPT_IN_ENV, "").strip() != "1":
        raise GateFailure(f"set {startup.MOSH_OPT_IN_ENV}=1")
    if not connection.live_test_authorized():
        raise GateFailure("private fixture host opt-in is not authorized")


def _run(argv: list[str], *, timeout: float = 2.0) -> bytes:
    result = subprocess.run(
        argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, close_fds=True, timeout=timeout, check=False,
    )
    if result.returncode != 0 or len(result.stdout) > MAX_OUTPUT:
        raise GateFailure(f"bounded helper failed: {Path(argv[0]).name} {argv[1:]} "
                          f"(exit {result.returncode}): "
                          + result.stderr[:256].decode("utf-8", "replace")
                          + result.stdout[:256].decode("utf-8", "replace"))
    return result.stdout


def _clients(hyprctl: Path) -> list[dict[str, object]]:
    try:
        value = json.loads(_run([str(hyprctl), "-j", "clients"]))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise GateFailure("Hyprland clients response was invalid") from error
    if not isinstance(value, list) or len(value) > MAX_WINDOWS:
        raise GateFailure("Hyprland clients response exceeded its bound")
    return [item for item in value if isinstance(item, dict) and item.get("mapped") is True]


def _active(hyprctl: Path) -> dict[str, object]:
    try:
        value = json.loads(_run([str(hyprctl), "-j", "activewindow"]))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise GateFailure("Hyprland activewindow response was invalid") from error
    return value if isinstance(value, dict) else {}


def _window_key(item: dict[str, object]) -> tuple[str, str, int, int]:
    stable = str(item.get("stableId", ""))
    address = str(item.get("address", "")).lower()
    pid = item.get("pid")
    if (_STABLE.fullmatch(stable) is None or _ADDRESS.fullmatch(address) is None
            or not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1):
        raise GateFailure("Hyprland window identity was invalid")
    identity = private_sshd._process_identity(pid)
    return stable, address, pid, identity.start_ticks


def _wait_window(hyprctl: Path, owned: OwnedWindow) -> dict[str, object]:
    deadline = time.monotonic() + WAIT
    while time.monotonic() < deadline:
        if owned.process.poll() is not None:
            raise GateFailure("owned Ghostty exited before mapping")
        private_sshd._assert_process(owned.identity)
        found = [item for item in _clients(hyprctl)
                 if item.get("pid") == owned.identity.pid]
        if len(found) > 1:
            raise GateFailure("owned Ghostty mapped more than one window")
        if len(found) == 1 and found[0].get("title") == "mosh":
            _window_key(found[0])
            owned.window = found[0]
            return found[0]
        time.sleep(POLL)
    raise GateFailure("owned Ghostty did not map with title mosh")


def _wait_mosh_child(owned: OwnedWindow, expected: list[str]):
    deadline = time.monotonic() + WAIT
    while time.monotonic() < deadline:
        private_sshd._assert_process(owned.identity)
        matches = []
        for identity in private_sshd._descendants(owned.identity):
            try:
                if private_sshd._process_argv(identity.pid) == expected:
                    private_sshd._assert_process(identity)
                    matches.append(identity)
            except (private_sshd.PrivateSshdSafetyError,
                    private_sshd.PrivateSshdUnavailable):
                continue
        if len(matches) > 1:
            raise GateFailure("owned Ghostty had ambiguous mosh-client descendants")
        if matches:
            owned.mosh_identity = matches[0]
            return matches[0]
        time.sleep(POLL)
    raise GateFailure("owned mosh-client descendant did not appear")


def _tmux_rows(fixture, snapshot) -> tuple[tuple[str, int, str, str, str], ...]:
    command = fixture._tmux_command(
        "list-clients", "-F",
        "#{client_name}\t#{client_pid}\t#{client_session}\t#{window_index}\t#{pane_id}",
    )
    deadline = time.monotonic() + WAIT
    while time.monotonic() < deadline:
        fixture._prove_server()
        try:
            status, raw = fixture._bounded_tmux_query(command, timeout=0.5)
        except connection._TmuxQueryRetry:
            continue
        if status != 0 or len(raw) > 4096 or b"\0" in raw or b"\r" in raw:
            raise GateFailure("private tmux client query was invalid")
        rows = []
        for line in raw.splitlines():
            fields = line.decode("utf-8", "strict").split("\t")
            if len(fields) != 5:
                raise GateFailure("private tmux client row was invalid")
            row = (fields[0], int(fields[1]), fields[2], fields[3], fields[4])
            if row[1] <= 1 or row[2:] != (
                    snapshot.session, snapshot.window_index, snapshot.pane_id):
                raise GateFailure("private tmux client selected another pane")
            private_sshd._assert_process(private_sshd._process_identity(row[1]))
            rows.append(row)
        if len(rows) == 2:
            return tuple(sorted(rows))
        if len(rows) > 2:
            raise GateFailure("private pane had an unexpected third client")
        time.sleep(POLL)
    raise GateFailure("two private mosh clients did not attach")


def _spawn_window(
    ghostty: Path, client: Path, server_fixture, host: str, session: str,
    windows: list[OwnedWindow],
) -> OwnedWindow:
    display = (
        f"-- {host} tmux -S {server_fixture._socket_path} "
        f"attach-session -t ={session} |"
    )
    client_argv = [str(client), "-#", display, mosh.LOOPBACK,
                   str(server_fixture.server_identity.port)]
    argv = [
        str(ghostty), "--config-default-files=false",
        "--gtk-single-instance=false", "--confirm-close-surface=false",
        "--title=mosh", "-e", *client_argv,
    ]
    environment = dict(os.environ)
    # The reviewed helper retains the bootstrap key only in a mutable bytearray.
    # Copy it directly into this child's environment and never serialize it.
    environment.update({
        "MOSH_KEY": bytes(server_fixture._key).decode("ascii"),
        "MOSH_NO_TERM_INIT": "1", "MOSH_PREDICTION_DISPLAY": "never",
        "TERM": "xterm-256color",
    })
    process = subprocess.Popen(
        argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, close_fds=True, env=environment,
        start_new_session=False,
    )
    environment["MOSH_KEY"] = ""
    owned = OwnedWindow(process, None, tuple(argv))
    windows.append(owned)
    identity = private_sshd._process_identity(process.pid, ghostty)
    owned.identity = identity
    if private_sshd._process_argv(process.pid) != argv:
        raise GateFailure("owned Ghostty argv changed")
    owned._client_argv = client_argv  # type: ignore[attr-defined]
    return owned


def _stop_owned(owned: OwnedWindow) -> None:
    if owned.identity is None:
        if owned.process.poll() is None:
            raise GateFailure(f"unverified owned Ghostty requires recovery: {owned.process.pid}")
        return
    if not private_sshd._process_is_gone(owned.identity):
        private_sshd._assert_process(owned.identity)
        descendants = private_sshd._descendants(owned.identity)
        private_sshd._terminate_identities(descendants + [owned.identity], 3.0)
    owned.process.wait(timeout=3.0)
    if owned.mosh_identity is not None and not private_sshd._process_is_gone(owned.mosh_identity):
        raise GateFailure("owned mosh-client survived cleanup")


def _node_activation(agent: dict[str, object], bridge: Path, node: Path) -> dict[str, object]:
    program = f"""
      import {{ activate, agentIdentity }} from {json.dumps((bridge / 'agentd-hub.js').as_uri())};
      import {{ createResolverClient }} from {json.dumps((bridge / 'agent-window-resolver.js').as_uri())};
      const agent = {json.dumps(agent, separators=(',', ':'))};
      const events = [], notices = [], matches = [];
      let blockedLaunches = 0;
      const client = createResolverClient();
      await activate(agentIdentity(agent), {{
        lookupAgent: () => agent, isHubConnected: () => true,
        resolver: {{ request: async request => {{
          const response = await client.request(request);
          if (request.operation === 'match') matches.push(response);
          return response;
        }} }},
        emit: event => events.push(event),
        showNotice: async (...args) => notices.push(args),
        spawnDetached: async () => {{ blockedLaunches++; return false; }},
      }});
      process.stdout.write(JSON.stringify({{events, notices, matches, blockedLaunches}}));
      process.exit(0);
    """
    result = subprocess.run(
        [str(node), "--input-type=module", "-e", program],
        cwd=bridge, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, close_fds=True, timeout=65.0, check=False,
    )
    if result.returncode != 0 or len(result.stdout) > MAX_OUTPUT:
        raise GateFailure("production Ask activation subprocess failed")
    try:
        return json.loads(result.stdout)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise GateFailure("production Ask activation response was invalid") from error


def run_gate(activation_callback=None) -> dict[str, object]:
    """Run the shared lifecycle, optionally with another product's adapter.

    Callback receives the synthetic roster agent and returns a dict containing
    ok=True, existing=True, newAttachmentAttempts=0. It must use the product's
    real activation/focus path, blocking (and counting) any attempted attachment.
    The shared gate independently checks MRU focus, workspace and unchanged
    real window/client identities. Callbacks must not mutate fixture lifecycle.
    """
    _authorized()
    ghostty = startup._system_tool("ghostty")
    hyprctl = startup._system_tool("hyprctl")
    mosh_server = startup._system_tool("mosh-server")
    mosh_client = startup._system_tool("mosh-client")
    tmux = startup._system_tool("tmux")
    node_path = os.environ.get("ASK_NODE_EXECUTABLE") or shutil.which("node")
    if not node_path:
        raise GateFailure("Node executable is unavailable")
    node = Path(node_path)
    baseline = _clients(hyprctl)
    if baseline:
        raise GateFailure("isolated Testbed desktop has pre-existing windows")
    active_workspace = json.loads(_run([str(hyprctl), "-j", "activeworkspace"]))
    original_workspace = str(active_workspace.get("name", ""))
    token = secrets.token_hex(6)
    session = f"0_1_9-{token}"
    host = "atlas.invalid"
    ports = [startup._random_port(), startup._random_port()]
    while ports[1] == ports[0]:
        ports[1] = startup._random_port()
    registered: dict[str, object] = {}

    def commands(snapshot):
        fixture = registered.get("fixture")
        if not isinstance(fixture, connection.ConnectionFixture):
            raise GateFailure("connection fixture was not bound")
        values = []
        proofs = []
        for port in ports:
            proof = startup._ConnectionSocketProof(fixture)
            proof.bind(snapshot)
            command = mosh.bootstrap_command(
                server_executable=mosh_server, tmux_executable=tmux,
                socket_path=snapshot.socket_path, session=snapshot.session,
                port=port, prove_socket=proof,
            )
            proofs.append(proof)
            values.append(connection.SetupCommand(command, original_command=command))
        registered.update(snapshot=snapshot, proofs=proofs)
        return values

    fixture = connection.ConnectionFixture(session=session, command_factory=commands)
    registered["fixture"] = fixture
    servers = []
    windows: list[OwnedWindow] = []
    fixture_active = False
    try:
        active = fixture.__enter__()
        fixture_active = True
        snapshot = registered.get("snapshot")
        proofs = registered.get("proofs")
        if snapshot is not active._pane_snapshot_proof or not isinstance(proofs, list):
            raise GateFailure("private pane proof was not retained")
        for port, proof in zip(ports, proofs, strict=True):
            server = mosh.PrivateMoshFixture(
                active._private_sshd, server_executable=mosh_server,
                client_executable=mosh_client, tmux_executable=tmux,
                socket_path=snapshot.socket_path, session=snapshot.session,
                port=port, prove_socket=proof,
            )
            servers.append(server)
            server.start_server()
        for server in servers:
            owned = _spawn_window(ghostty, mosh_client, server, host, session, windows)
            _wait_window(hyprctl, owned)
            _wait_mosh_child(owned, owned._client_argv)  # type: ignore[attr-defined]
        tmux_before = _tmux_rows(active, snapshot)
        identities_before = sorted(_window_key(item) for item in _clients(hyprctl))
        if len(identities_before) != 2:
            raise GateFailure("desktop did not contain exactly two owned windows")

        ws_a, ws_b, ws_empty = (f"ask-mosh-{token}-{suffix}" for suffix in ("a", "b", "empty"))
        for workspace, owned in zip((ws_a, ws_b), windows, strict=True):
            address = str(owned.window["address"])
            _run([str(hyprctl), "eval",
                  'hl.dispatch(hl.dsp.window.move({ workspace = '
                  + json.dumps(f"name:{workspace}") + ', window = '
                  + json.dumps(f"address:{address}") + ', follow = false }))'])
        first_address = str(windows[0].window["address"])
        _run([str(hyprctl), "eval",
              f'hl.dispatch(hl.dsp.focus({{ window = "address:{first_address}" }}))'])
        _run([str(hyprctl), "eval", 'hl.dispatch(hl.dsp.focus({ workspace = '
              + json.dumps(f"name:{ws_empty}") + ' }))'])
        if _active(hyprctl):
            raise GateFailure("empty selection workspace unexpectedly has an active window")

        agent = {
            "name": f"unrelated-agent-{token}", "machine": host,
            "instanceId": f"mosh-two-{token}",
            "id": {"pid": snapshot.pane_pid,
                   "startTimeTicks": str(snapshot.pane_start_ticks)},
            "tmux": {"session": snapshot.session,
                     "windowIndex": snapshot.window_index,
                     "paneId": snapshot.pane_id,
                     "socket": {"kind": "path", "value": str(snapshot.socket_path)}},
            "hubSourceState": "reporting", "presence": {"state": "present"},
        }
        if activation_callback is None:
            outcome = _node_activation(agent, BRIDGE, node)
            matches = outcome.get("matches")
            if not isinstance(matches, list) or len(matches) != 2:
                raise GateFailure("activation did not perform two match passes")
            for response in matches:
                candidates = response.get("candidates") if isinstance(response, dict) else None
                if not isinstance(candidates, list) or len(candidates) != 2:
                    raise GateFailure("match did not retain exactly two candidates")
                if any(item.get("window", {}).get("title") != "mosh" for item in candidates):
                    raise GateFailure("match candidate title changed")
            events = outcome.get("events")
            if not isinstance(events, list) or len(events) != 1 or not events[0].get("ok") \
                    or events[0].get("existing") is not True or outcome.get("notices") != [] \
                    or outcome.get("blockedLaunches") != 0:
                raise GateFailure("production activation did not select an existing window")
        else:
            outcome = activation_callback(agent)
            if (not isinstance(outcome, dict) or outcome.get("ok") is not True
                    or outcome.get("existing") is not True
                    or outcome.get("newAttachmentAttempts") != 0):
                raise GateFailure("adapter did not report existing-window activation")
        if _active(hyprctl).get("stableId") != windows[0].window.get("stableId"):
            raise GateFailure("production activation did not choose the MRU window")
        if _active(hyprctl).get("workspace", {}).get("name") != ws_a:
            raise GateFailure("production activation did not reach the existing workspace")
        if sorted(_window_key(item) for item in _clients(hyprctl)) != identities_before:
            raise GateFailure("activation changed the two-window identity set")
        if _tmux_rows(active, snapshot) != tmux_before:
            raise GateFailure("activation changed the private tmux clients")
        return {"status": "passed", "candidateCount": 2,
                "windowCount": 2, "tmuxClientCount": 2,
                "newAttachmentAttempts": 0, "workspaceSwitched": True}
    finally:
        cleanup_errors = []
        for owned in reversed(windows):
            try:
                _stop_owned(owned)
            except BaseException as error:
                cleanup_errors.append(type(error).__name__)
        if cleanup_errors:
            raise GateFailure("client cleanup incomplete; preserving private servers: "
                              + ",".join(cleanup_errors))
        for server in reversed(servers):
            try:
                server.close()
            except BaseException as error:
                cleanup_errors.append(type(error).__name__)
        if cleanup_errors:
            raise GateFailure("server cleanup incomplete; preserving private tmux: "
                              + ",".join(cleanup_errors))
        if fixture_active:
            fixture_active = False
            active.__exit__(*sys.exc_info())
        deadline = time.monotonic() + WAIT
        while _clients(hyprctl) and time.monotonic() < deadline:
            time.sleep(POLL)
        if _clients(hyprctl):
            raise GateFailure("owned Ghostty windows survived cleanup")
        if original_workspace:
            selector = original_workspace if original_workspace.isdecimal() else f"name:{original_workspace}"
            _run([str(hyprctl), "eval", 'hl.dispatch(hl.dsp.focus({ workspace = '
                  + json.dumps(selector) + ' }))'])


def main() -> int:
    try:
        result = run_gate()
    except BaseException as error:
        sys.stderr.write(f"{type(error).__name__}: {error}\n"[:768])
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
