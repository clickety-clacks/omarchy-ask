#!/usr/bin/env python3
"""Kill ONLY the disposable shortcut fixture and verify native bindings recover.
Usage: shortcut-shell-exit.py INSTANCE WAYLAND_SOCKET QS_INSTANCE CONFIG_PATH
The caller must relaunch the fixture afterward. Never targets omarchy-shell.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def main():
    instance, display, shell, config = sys.argv[1:]
    env = dict(os.environ, HYPRLAND_INSTANCE_SIGNATURE=instance, WAYLAND_DISPLAY=display)
    def run(*args): return subprocess.check_output(args, env=env, text=True, stderr=subprocess.STDOUT).strip()
    def hypr(*args): return run("hyprctl", "-i", instance, *args)
    def ipc(*args): return run("qs", "ipc", "--id", shell, "call", "shortcutTest", *args)
    def state(): return json.loads(ipc("state"))

    assert hypr("repl", "return type(ask_test_counts)") == "table", "not a disposable compositor"
    pid = state()["pid"]
    args = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
    assert os.fsencode(config) in args and "ask-shortcut-test." in config, args
    assert not config.startswith("/usr/share/"), config
    hypr("reload", "config-only")
    ipc("openSurface")
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if state()["ready"] and state()["focused"]: break
        time.sleep(0.05)
    assert state()["ready"] and state()["focused"], state()
    # Verify both precedence and normal native dispatch before abrupt exit.
    run("wtype", "-M", "logo", "-k", "comma", "-m", "logo")
    run("wtype", "-k", "F5")
    time.sleep(0.1)
    assert tuple(map(int, hypr("repl", "return ask_test_counts.system, ask_test_counts.release, ask_test_counts.conflict").split())) == (1, 1, 0)
    os.kill(pid, signal.SIGKILL)
    deadline = time.monotonic() + 5
    while Path(f"/proc/{pid}").exists() and time.monotonic() < deadline: time.sleep(0.05)
    assert not Path(f"/proc/{pid}").exists(), "test shell has not exited"
    run("wtype", "-M", "logo", "-k", "comma", "-m", "logo")
    run("wtype", "-k", "F5")
    time.sleep(0.1)
    assert tuple(map(int, hypr("repl", "return ask_test_counts.system, ask_test_counts.release, ask_test_counts.conflict").split())) == (2, 2, 1)
    assert hypr("configerrors") == ""
    print(json.dumps({"test":"abrupt test-shell exit restores native conflicts and F5 without resetting bindings", "result":"pass", "terminatedFixturePid":pid}), flush=True)


if __name__ == "__main__": main()
