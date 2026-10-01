#!/usr/bin/env python3
"""Native evdev-code/layout tests using a full-keymap virtual keyboard.

This is not a physical hardware test, but it deliberately disables the sparse
wtype map accommodation and exercises conventional codes, groups and modifiers.
"""
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import time


def main():
    instance, display, shell = sys.argv[1:4]
    same_map_groups = sys.argv[4:] == ["--same-map-groups"]
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

    def counts():
        return tuple(map(int, hypr("repl", "return ask_test_counts.system, ask_test_counts.release, ask_test_counts.conflict").split()))

    def claim(chords):
        ipc("claim", chords)
        wait_for(lambda: surface()["ready"] and surface()["focused"])

    def passed(name):
        print(json.dumps({"test": name, "result": "pass"}), flush=True)

    assert hypr("repl", "return type(ask_test_counts)") == "table", "not the test compositor"
    hypr("reload", "config-only")
    hypr("eval", 'hl.config({input={resolve_binds_by_sym=false}})')
    ipc("openSurface")
    claim("64:comma 4:Return")
    keyboard = subprocess.Popen([str(Path(__file__).resolve().parent / ".build" / "keyboard-client"), "us,de"],
                                env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

    def read_line(client=keyboard):
        assert select.select([client.stdout], [], [], 3)[0], "keyboard client stopped responding"
        line = client.stdout.readline().strip()
        assert line, f"keyboard client exited: {client.poll()}"
        return line

    def command(action, code, client=keyboard):
        client.stdin.write(f"{action} {code}\n")
        client.stdin.flush()
        assert read_line(client) == "ok"

    def key(code, *mods):
        for mod in mods:
            command("press", mod)
        command("press", code)
        command("release", code)
        for mod in reversed(mods):
            command("release", mod)
        time.sleep(0.04)

    try:
        assert read_line() == "ready"
        before = surface()
        key(63)  # F5, conventional evdev code
        assert counts() == (1, 1, 0), counts()
        assert surface()["other"] == before["other"], surface()
        passed("native F5 works with conventional keycodes and symbol accommodation disabled")

        hypr("eval", 'hl.bind("SUPER + H", function() ask_test_counts.system = ask_test_counts.system + 10 end)')
        key(35, 125)  # Super + H
        assert counts() == (11, 1, 0), counts()
        assert surface()["other"] == before["other"], surface()
        key(51, 125)  # Super + comma
        assert counts() == (11, 1, 0), counts()
        assert surface()["owned"] == before["owned"] + 1, surface()
        passed("full-map Super+H stays native while Super+comma reaches Ask")

        # Native explicit XKB keycode is evdev + 8 (F13 = evdev183 + 8).
        hypr("eval", 'hl.bind("code:191", function() ask_test_counts.system = ask_test_counts.system + 100 end)')
        key(183)
        assert counts() == (111, 1, 0), counts()
        passed("a live native keycode binding works inside the popup")

        devices = json.loads(hypr("devices", "-j"))["keyboards"]
        names = [device["name"] for device in devices if "virtual" in device["name"]]
        assert len(names) == 1, devices
        name = json.dumps(names[0])
        hypr("eval", f'hl.bind("F6", function() ask_test_counts.system = ask_test_counts.system + 1000 end, {{device={{list={{{name}}}}}}}); hl.bind("F6", function() ask_test_counts.system = ask_test_counts.system + 99999 end, {{device={{list={{"not-this-device"}}}}}})')
        key(64)
        assert counts() == (1111, 1, 0), counts()
        passed("device inclusion filters retain their native behavior")

        # The client sends the shifted plus symbol; the normal keybind lookup
        # still uses the configured unshifted physical '=' binding.
        claim("5:plus")
        hypr("eval", 'hl.bind("CTRL + SHIFT + equal", function() ask_test_counts.conflict = ask_test_counts.conflict + 1 end)')
        key(13, 29, 42)  # Ctrl + Shift + =, producing + in the US layout
        assert counts()[2] == 0, (counts(), surface())
        assert surface()["lastKey"] == ord("+"), surface()
        passed("Ask shifted-symbol claim follows the symbol delivered to Qt")

        # In group 1 (German), physical US Y produces Z. Native bindings remain
        # on their ordinary configured keymap; app claims follow the client map.
        claim("0:z")
        hypr("eval", 'hl.bind("Y", function() ask_test_counts.conflict = ask_test_counts.conflict + 1 end)')
        command("group", 1)
        key(21)
        assert counts()[2] == 0, (counts(), surface())
        assert surface()["lastKey"] == ord("Z"), surface()
        passed("Ask claims follow the active client layout without changing native binding layout")

        claim("")
        key(21)
        assert counts()[2] == 1, counts()
        passed("relinquishing a layout-specific claim restores unchanged native keymap resolution")

        command("group", 0)
        claim("4:h")
        hypr("eval", 'hl.bind("CTRL + H", function() ask_test_counts.conflict = ask_test_counts.conflict + 10 end)')
        key(58)  # Caps Lock on
        key(35, 29)
        assert counts()[2] == 1, (counts(), surface())
        assert surface()["lastKey"] == ord("H"), surface()
        key(58)  # Caps Lock off
        passed("Caps Lock does not turn an Ask chord into a different shortcut")

        claim("0:KP_Enter 1:ISO_Left_Tab")
        hypr("eval", 'hl.bind("KP_Enter", function() ask_test_counts.conflict = ask_test_counts.conflict + 10 end); hl.bind("SHIFT + Tab", function() ask_test_counts.conflict = ask_test_counts.conflict + 10 end)')
        key(96)  # keypad Enter
        assert counts()[2] == 1, (counts(), surface())
        assert surface()["lastKey"] == 0x01000005, surface()  # Qt.Key_Enter
        key(15, 42)  # Shift+Tab produces ISO_Left_Tab
        assert counts()[2] == 1, (counts(), surface())
        assert surface()["lastKey"] == 0x01000002, surface()  # Qt.Key_Backtab
        passed("keypad Enter and shifted Tab match their actual application symbols")

        second = subprocess.Popen([str(Path(__file__).resolve().parent / ".build" / "keyboard-client"), "us,de" if same_map_groups else "de"],
                                  env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            assert read_line(second) == "ready"
            claim("0:z")
            command("group", 1 if same_map_groups else 0)
            command("group", 0, second)
            before = counts()[2]
            for cycle in range(5):
                # Same physical code held on two live keyboards, with different
                # active layouts. Ownership must use the event's device, not
                # whichever keyboard last delivered input to the seat.
                if same_map_groups:
                    # Same keymap, different groups: Hyprland only sends the
                    # new group's modifiers AFTER the first key. Qt still
                    # sees Y on this first event, so native Y must win.
                    command("press", 21)
                    time.sleep(0.03)
                    assert counts()[2] == before + cycle + 1, (counts(), surface())
                    # Switching back now delivers Z (the prior seat group),
                    # which really is an Ask chord and must reach the client.
                    command("press", 21, second)
                    time.sleep(0.03)
                    assert counts()[2] == before + cycle + 1, (counts(), surface())
                    assert surface()["lastKey"] == ord("Z"), surface()
                    command("release", 21)
                    command("release", 21, second)
                    continue
                command("press", 21, second)
                time.sleep(0.03)
                assert counts()[2] == before + cycle, (counts(), surface())
                assert surface()["lastKey"] == ord("Z"), surface()
                command("press", 21)
                command("release", 21)
                command("release", 21, second)
                time.sleep(0.03)
                assert counts()[2] == before + cycle + 1, (counts(), surface())
            passed("same-keymap group switches match the symbol actually delivered to Qt" if same_map_groups
                   else "two concurrent keyboards retain separate layout ownership for the same held physical code")
        finally:
            if second.poll() is None:
                second.stdin.close()
                second.wait(timeout=3)
        print(json.dumps({"result": "pass", "tests": 10}), flush=True)
    finally:
        if keyboard.poll() is None:
            keyboard.stdin.close()
            keyboard.wait(timeout=3)
        ipc("claim", "64:comma 4:Return")
        hypr("reload", "config-only")
        assert hypr("configerrors") == ""


if __name__ == "__main__":
    main()
