#!/usr/bin/env python3
"""Exercise actual Ask QML with the deterministic bridge on the test desktop.

Usage: actual-shortcut-routing.py INSTANCE WAYLAND_SOCKET QUICKSHELL_INSTANCE
Requires actual-ask-root.qml and shortcut-compositor.lua. Never runs a harness.
"""
import json
import os
import subprocess
import sys
import time


def main():
    instance, display, shell = sys.argv[1:]
    env = dict(os.environ, HYPRLAND_INSTANCE_SIGNATURE=instance, WAYLAND_DISPLAY=display)

    def run(*args):
        return subprocess.check_output(args, env=env, text=True, stderr=subprocess.STDOUT).strip()

    def hypr(*args):
        return run("hyprctl", "-i", instance, *args)

    def ipc(*args):
        return run("qs", "ipc", "--id", shell, "call", "askTest", *args)

    def state():
        return json.loads(ipc("state"))

    def wait_for(predicate, message):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.05)
        raise AssertionError(message)

    def send(key, mod=None):
        run("wtype", *(["-M", mod] if mod else []), "-k", key, *(["-m", mod] if mod else []))
        time.sleep(0.1)

    def counts():
        return tuple(map(int, hypr("repl", "return ask_test_counts.system, ask_test_counts.release, ask_test_counts.conflict").split()))

    def passed(name):
        print(json.dumps({"test": name, "result": "pass"}), flush=True)

    assert hypr("repl", "return type(ask_test_counts)") == "table", "not the test compositor"
    assert state()["count"] == 0, "refusing to close preexisting conversations"
    hypr("reload", "config-only")
    try:
        ipc("openPrompt")
        wait_for(lambda: state()["opened"], "Ask never opened")
        # The known registration interval is tested separately; these cases
        # cover handler correctness after the window is fully initialized.
        time.sleep(0.4)
        send("F5")
        assert counts() == (1, 1, 0), counts()
        passed("F5 native press/release works in the real Ask overlay")

        send("comma", "ctrl")
        wait_for(lambda: state()["settings"], "settings never opened from overlay")
        assert counts() == (1, 1, 0), counts()
        send("F5")
        assert counts() == (2, 2, 0), counts()
        passed("actual settings window wins its shortcut and preserves system F5")
        send("Escape")
        wait_for(lambda: not state()["settings"], "settings never closed")

        bridge_pid = state()["bridgePid"]
        assert bridge_pid, state()
        send("p", "ctrl")
        wait_for(lambda: state()["pinned"], "conversation never pinned")
        wait_for(lambda: state()["focused"], "pinned window never gained focus")
        assert state()["unregisteredFocus"] == 0, state()
        assert state()["bridgePid"] == bridge_pid, state()
        passed("pin handoff registers before focus and retains the bridge process")
        assert state()["count"] == 1
        time.sleep(0.2)
        hypr("eval", 'hl.bind("Escape", function() ask_test_counts.system = ask_test_counts.system + 10 end)')
        send("Escape")
        assert state()["count"] == 1
        assert counts() == (12, 2, 0), counts()
        passed("pinned Ask leaves Escape to the system instead of claiming it")

        send("comma", "ctrl")
        wait_for(lambda: state()["settings"], "settings never opened from pinned window")
        assert counts() == (12, 2, 0), counts()
        send("Escape")
        wait_for(lambda: not state()["settings"], "settings Escape did not override native binding")
        assert counts() == (12, 2, 0), counts()
        passed("actual settings Escape overrides native binding only while settings are focused")
        ipc("closePrompts")
        hypr("reload", "config-only")
        for _ in range(5):
            ipc("openPrompt")
            wait_for(lambda: state()["focused"] and state()["ready"] and state()["bridgePid"], "fresh overlay never became ready")
            bridge_pid = state()["bridgePid"]
            send("p", "ctrl")
            wait_for(lambda: state()["pinned"] and state()["focused"], "fresh pin never acquired focus")
            assert state()["ready"] and state()["unregisteredFocus"] == 0, state()
            assert state()["bridgePid"] == bridge_pid, state()
            send("comma", "ctrl")
            wait_for(lambda: state()["settings"], "first pinned shortcut did not open settings")
            assert counts()[2] == 0, counts()
            ipc("closePrompts")
        passed("five fresh pin cycles preserve first-shortcut precedence and bridge identity")
        hypr("reload", "config-only")
        ipc("openPrompt")
        wait_for(lambda: state()["focused"] and state()["ready"] and state()["bridgePid"], "context overlay not ready")
        hypr("eval", 'hl.bind("BackSpace", function() ask_test_counts.system = ask_test_counts.system + 10 end)')
        send("BackSpace")
        assert counts()[0] == 10, counts()
        ipc("searchPrompt")
        wait_for(lambda: state()["searchMode"] == "@" and state()["ready"], "search policy not ready")
        send("BackSpace")
        wait_for(lambda: state()["searchMode"] == "" and state()["ready"], "Backspace did not leave search")
        assert counts()[0] == 10, counts()
        send("BackSpace")
        assert counts()[0] == 20, counts()
        passed("empty-search Backspace temporarily overrides and then restores the native binding")

        hypr("eval", 'hl.bind("Y", function() ask_test_counts.system = ask_test_counts.system + 10 end); hl.bind("N", function() ask_test_counts.system = ask_test_counts.system + 10 end)')
        send("y")
        assert counts()[0] == 30, counts()
        ipc("permissionPrompt")
        wait_for(lambda: state()["permission"] and state()["ready"], "permission policy not ready")
        send("F5")
        assert counts()[0] == 31, counts()
        send("y")
        wait_for(lambda: not state()["permission"] and state()["ready"], "permission shortcut did not answer")
        assert counts()[0] == 31, counts()
        send("n")
        assert counts()[0] == 41, counts()
        passed("permission letters override only during a request and preserve native F5")

        for chord in ("CTRL + H", "CTRL + W", "Left", "Tab"):
            hypr("eval", f'hl.bind("{chord}", function() ask_test_counts.system = ask_test_counts.system + 10 end)')
        ipc("filesPrompt")
        wait_for(lambda: state()["files"] and state()["ready"], "file-browser policy not ready")
        send("h", "ctrl")
        send("w", "ctrl")
        send("Left")
        assert counts()[0] == 71, counts()
        send("Tab")
        assert counts()[0] == 71, counts()
        passed("actual file browser releases composer and horizontal bindings but retains its Tab override")
        assert hypr("configerrors") == ""
        print(json.dumps({"result": "pass", "tests": 9}), flush=True)
    finally:
        ipc("closePrompts")
        hypr("reload", "config-only")


if __name__ == "__main__":
    main()
