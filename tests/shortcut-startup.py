#!/usr/bin/env python3
"""Real Ask startup/failure tests. Requires the disposable compositor and no
running instance of actual.qml. Uses only a fake bridge; no harness/account.
Usage: shortcut-startup.py INSTANCE WAYLAND_SOCKET /absolute/actual.qml CACHE
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time


def main():
    instance, display, config, cache = sys.argv[1:]
    env = dict(os.environ, HYPRLAND_INSTANCE_SIGNATURE=instance, WAYLAND_DISPLAY=display)
    qs, hyprctl = shutil.which("qs"), shutil.which("hyprctl")
    python, node = shutil.which("python"), shutil.which("node")

    def run(*args):
        return subprocess.check_output(args, env=env, text=True, stderr=subprocess.STDOUT).strip()

    assert run(hyprctl, "-i", instance, "repl", "return type(ask_test_counts)") == "table"

    for scenario in ("delayed", "failed-loader", "missing-node", "missing-hyprctl"):
        with tempfile.TemporaryDirectory(prefix="ask-startup-test-") as temporary:
            folder = Path(temporary)
            bin_dir = folder / "bin"
            bin_dir.mkdir()
            gate = folder / "continue"
            if scenario != "missing-hyprctl": (bin_dir / "hyprctl").symlink_to(hyprctl)
            if scenario in ("delayed", "failed-loader"):
                wrapper = bin_dir / "node"
                wrapper.write_text(f"#!{python}\nimport os, sys, time\n"
                    f"while not os.path.exists({str(gate)!r}): time.sleep(0.02)\n"
                    + ("sys.stderr.write('deliberate test loader failure\\n')\nsys.exit(23)\n"
                       if scenario == "failed-loader" else f"os.execv({node!r}, [{node!r}] + sys.argv[1:])\n"))
                wrapper.chmod(0o700)
            elif scenario != "missing-node": (bin_dir / "node").symlink_to(node)
            child_env = dict(env, PATH=str(bin_dir), ASK_SHORTCUT_CACHE_DIR=cache,
                ASK_BRIDGE_COMMAND=json.dumps([python, "-u", str(Path(config).parent / "ask/tests/shortcut-fake-bridge.py")]))
            log_path = folder / "shell.log"
            with log_path.open("w+") as log:
                child = subprocess.Popen([qs, "-p", config], env=child_env, stdout=log, stderr=log)
                shell = None
                try:
                    deadline = time.monotonic() + 8
                    while not shell and time.monotonic() < deadline:
                        match = re.search(r"by-id/([^/]+)/log.qslog", log_path.read_text())
                        if match: shell = match[1]
                        else: time.sleep(0.05)
                    assert shell, log_path.read_text()

                    def ipc(method): return run(qs, "ipc", "--id", shell, "call", "askTest", method)
                    def state(): return json.loads(ipc("state"))
                    def wait_for(predicate, label):
                        deadline = time.monotonic() + 12
                        while time.monotonic() < deadline:
                            current = state()
                            if predicate(current): return current
                            time.sleep(0.05)
                        raise AssertionError(f"{scenario}: {label}: {state()}\n{log_path.read_text()}")

                    wait_for(lambda s: True, "IPC ready")
                    if scenario in ("delayed", "failed-loader"):
                        ipc("openPrompt")
                        pending = state()
                        assert pending["opened"] and pending["runtimePending"] and pending["count"] == 0, pending
                        assert pending["bridgePid"] is None, pending
                        ipc("closePrompts")
                        assert not state()["opened"]
                        gate.touch()
                    ready = wait_for(lambda s: not s["runtimePending"], "loader settles")
                    assert ready["count"] == 0, ready
                    assert ready["runtimeReady"] == (scenario == "delayed"), ready
                    if scenario != "delayed": assert ready["runtimeError"], ready
                    ipc("openPrompt")
                    wait_for(lambda s: s["count"] == 1 and s["focused"], "Ask opens after setup")
                    run(hyprctl, "-i", instance, "reload", "config-only")
                    run("wtype", "-k", "F5")
                    time.sleep(0.15)
                    counts = run(hyprctl, "-i", instance, "repl", "return ask_test_counts.system, ask_test_counts.release")
                    assert tuple(map(int, counts.split())) == (1, 1), counts
                    ipc("pinPrompt")
                    wait_for(lambda s: s["pinned"] and not s["pinPending"] and s["focused"], "pin fallback finishes")
                    ipc("closePrompts")
                    print(json.dumps({"test": scenario, "result":"pass"}), flush=True)
                finally:
                    if shell:
                        try: ipc("closePrompts")
                        except subprocess.CalledProcessError: pass
                    child.terminate()
                    try: child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill(); child.wait()
    assert run(hyprctl, "-i", instance, "configerrors") == ""


if __name__ == "__main__": main()
