#!/usr/bin/env python3
"""Real client-global-hotkey routing on the explicit disposable compositor."""
import json
import os
from pathlib import Path
import select
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
        return run("qs", "ipc", "--id", shell, "call", "shortcutTest", *args)

    def surface():
        return json.loads(ipc("state"))

    def wait_for(predicate):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.03)
        raise AssertionError("condition did not become true")

    def open_surface():
        ipc("openSurface")
        wait_for(lambda: surface()["ready"] and surface()["focused"])

    def send(key, mod=None):
        run("wtype", *(["-M", mod] if mod else []), "-k", key, *(["-m", mod] if mod else []))

    def passed(name):
        print(json.dumps({"test": name, "result": "pass"}), flush=True)

    assert hypr("repl", "return type(ask_test_counts)") == "table", "not the test compositor"
    hypr("reload", "config-only")
    open_surface()
    hypr("eval", 'hl.unbind("SUPER + comma"); hl.unbind("F5")')
    executable = Path(__file__).resolve().parent / ".build" / "hotkey-client"
    client = subprocess.Popen([str(executable)], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

    def read_state():
        assert select.select([client.stdout], [], [], 3)[0], "hotkey client stopped responding"
        line = client.stdout.readline()
        assert line, f"hotkey client exited: {client.poll()}"
        value = json.loads(line)
        assert value["bound"] == 2 and value["denied"] == value["revoked"] == 0, value
        return value

    def status():
        client.stdin.write("state\n")
        client.stdin.flush()
        return read_state()

    try:
        read_state()
        before = surface()
        send("F5")
        current = status()
        assert current["systemPress"] == current["systemRelease"] == 1, current
        assert surface()["other"] == before["other"], surface()
        passed("global hotkey registered while Ask is open receives native press/release without text leakage")

        send("comma", "logo")
        current = status()
        assert current["ownedPress"] == current["ownedRelease"] == 0, current
        assert surface()["owned"] == before["owned"] + 1, surface()
        passed("Ask wins its own chord over a real client-global-hotkey registration")

        ipc("closeSurface")
        send("comma", "logo")
        current = status()
        assert current["ownedPress"] == current["ownedRelease"] == 1, current
        open_surface()
        send("comma", "logo")
        assert status()["ownedPress"] == 1
        passed("closing Ask restores the client hotkey and reopening reacquires precedence")

        before = surface()["owned"]
        held = subprocess.Popen(["wtype", "-M", "logo", "-P", "comma", "-s", "800", "-p", "comma", "-m", "logo"], env=env)
        try:
            wait_for(lambda: surface()["owned"] > before)
            ipc("closeSurface")
            assert held.wait(timeout=3) == 0
        finally:
            if held.poll() is None:
                held.terminate()
                held.wait()
        current = status()
        assert current["ownedPress"] == current["ownedRelease"] == 1, current
        passed("owned key held across Ask close does not produce a stray protocol release")

        open_surface()
        held = subprocess.Popen(["wtype", "-P", "F5", "-s", "800", "-p", "F5"], env=env)
        try:
            wait_for(lambda: status()["systemPress"] == 2)
            ipc("closeSurface")
            assert held.wait(timeout=3) == 0
        finally:
            if held.poll() is None:
                held.terminate()
                held.wait()
        current = status()
        assert current["systemPress"] == current["systemRelease"] == 2, current
        passed("native client hotkey held across Ask close retains its release event")
        print(json.dumps({"result": "pass", "tests": 5}), flush=True)
    finally:
        if client.poll() is None:
            client.stdin.close()
            client.wait(timeout=3)
        hypr("reload", "config-only")
        assert hypr("configerrors") == ""


if __name__ == "__main__":
    main()
