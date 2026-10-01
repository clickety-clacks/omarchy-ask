#!/usr/bin/env python3
"""Opt-in real-shell test on an authorized test desktop, not a user session.

Usage: installed-shortcut-routing.py INSTANCE WAYLAND_SOCKET QS_SHELL_ID
       [--uinput-image sha256:PINNED_PYTHON_IMAGE_ID]
Requires Ask already installed/enabled, no open Ask conversations, and unused
F5/Super+H. Adds temporary native bindings; closes its conversations and reloads
the original config afterward. No prompt is submitted to the real harness.
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
    uinput_image = None
    if sys.argv[4:]:
        assert len(sys.argv) == 6 and sys.argv[4] == "--uinput-image", "invalid input backend arguments"
        uinput_image = sys.argv[5]
        assert uinput_image.startswith("sha256:") and len(uinput_image) == 71, "use a pinned local Python image ID"
    env = dict(os.environ, HYPRLAND_INSTANCE_SIGNATURE=instance, WAYLAND_DISPLAY=display)
    def run(*args): return subprocess.check_output(args, env=env, text=True, stderr=subprocess.STDOUT).strip()
    def hypr(*args): return run("hyprctl", "-i", instance, *args)
    def ipc(*args): return run("qs", "ipc", "--id", shell, "call", "shell", *args)
    def layer(name):
        return any(item.get("namespace") == name for monitor in json.loads(hypr("layers", "-j")).values()
                   for level in monitor["levels"].values() for item in level)
    def windows(): return [w for w in json.loads(hypr("clients", "-j")) if w.get("title", "").startswith("Omarchy Ask #")]
    def wait_for(predicate, message):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if predicate(): return
            time.sleep(0.05)
        raise AssertionError(message)
    def counts(): return tuple(map(int, hypr("repl", "return ask_installed_test.system, ask_installed_test.release").split()))
    def passed(name): print(json.dumps({"test":name, "result":"pass"}), flush=True)

    plugins = json.loads(ipc("listPlugins"))
    assert any(p["id"] == "clickety-clacks.ask" and p["enabled"] for p in plugins), "Ask is not enabled"
    assert not layer("omarchy-ask") and not windows(), "refusing to close preexisting Ask conversations"
    assert hypr("configerrors") == "", "desktop has preexisting config errors"
    bindings = json.loads(hypr("binds", "-j"))
    assert not any((b["modmask"], b["key"].lower()) in [(0, "f5"), (64, "h")] for b in bindings), "F5 or Super+H is already assigned"
    assert any(b["modmask"] == 64 and b["key"].lower() == "comma" and not b["non_consuming"] for b in bindings), "expected the normal consuming Super+comma desktop binding"
    test_dir = Path(__file__).resolve().parent
    input_command = [str(test_dir / ".build/keyboard-client"), "us"]
    if uinput_image:
        # No privileged container, host network, home-directory mount, or ACL
        # changes. Only the temporary keyboard device and this read-only script.
        input_command = ["docker", "run", "--rm", "--interactive", "--pull=never",
            "--name", f"ask-shortcut-uinput-{os.getpid()}", "--network=none",
            "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--pids-limit=32", "--memory=128m", "--device=/dev/uinput:/dev/uinput:rw",
            "--mount", f"type=bind,source={test_dir / 'keyboard-input.py'},target=/keyboard-input.py,readonly",
            uinput_image, "python", "-u", "/keyboard-input.py"]
    keyboard = subprocess.Popen(input_command,
                                env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    def read_line():
        assert select.select([keyboard.stdout], [], [], 3)[0], "keyboard client timeout"
        return keyboard.stdout.readline().strip()
    def command(action, code):
        keyboard.stdin.write(f"{action} {code}\n"); keyboard.stdin.flush()
        assert read_line() == "ok"
    def key(code, *mods):
        if uinput_image:
            keyboard.stdin.write(json.dumps([*mods, code]) + "\n"); keyboard.stdin.flush()
            assert read_line() == "sent"
            return
        for mod in mods: command("press", mod)
        command("press", code); command("release", code)
        for mod in reversed(mods): command("release", mod)
        time.sleep(0.1)
    try:
        assert read_line() == "ready"
        if uinput_image:
            devices = json.loads(hypr("devices", "-j"))["keyboards"]
            assert any(k["name"] == "ask-shortcut-test" for k in devices), devices
        hypr("eval", 'ask_installed_test = {system=0, release=0}; hl.bind("F5", function() ask_installed_test.system = ask_installed_test.system + 1 end); hl.bind("F5", function() ask_installed_test.release = ask_installed_test.release + 1 end, {release=true}); hl.bind("SUPER + H", function() ask_installed_test.system = ask_installed_test.system + 10 end)')
        assert ipc("summon", "clickety-clacks.ask", "{}") == "ok"
        wait_for(lambda: layer("omarchy-ask"), "installed overlay did not appear")
        # A mapped layer is not yet keyboard-focused: Ask registers its scope
        # before asking for focus. The dedicated fixture audits that boundary;
        # this test exercises coexistence after normal shell initialization.
        time.sleep(0.4)
        # Opening the selector with a chord normally consumed by the desktop
        # proves this is the focused Ask, not just native dispatch elsewhere.
        key(51, 125)
        wait_for(lambda: layer("omarchy-ask-harness"), "installed selector shortcut lost to desktop binding")
        key(63); key(35, 125)
        assert counts() == (11, 1), counts()
        key(1)
        wait_for(lambda: not layer("omarchy-ask-harness"), "selector did not close")
        passed("installed Ask selector overrides the desktop chord and preserves native F5/Super+H")

        key(51, 29)
        wait_for(lambda: layer("omarchy-ask-motion"), "installed motion popup did not open")
        time.sleep(0.2)
        key(63)
        assert counts() == (12, 2), counts()
        key(1)
        wait_for(lambda: not layer("omarchy-ask-motion"), "motion popup lost keyboard focus with pointer outside its card")
        passed("installed motion popup retains keyboard focus outside its card and preserves native F5")

        key(63); key(35, 125)
        assert counts() == (23, 3), counts()
        hypr("eval", 'hl.unbind("SUPER + H"); hl.bind("SUPER + H", function() ask_installed_test.system = ask_installed_test.system + 100 end)')
        key(35, 125)
        assert counts() == (123, 3), counts()
        passed("installed overlay respects a newly changed binding without reopening")

        key(25, 29)  # Ctrl+P
        wait_for(lambda: len(windows()) == 1 and not layer("omarchy-ask"), "installed pin handoff did not finish")
        key(51, 125)
        wait_for(lambda: layer("omarchy-ask-harness"), "first installed pinned shortcut failed")
        key(1)
        wait_for(lambda: not layer("omarchy-ask-harness"), "pinned selector did not close")
        key(63); key(35, 125)
        assert counts() == (224, 4), counts()
        passed("installed pinned window preserves app precedence and live native bindings")

        ipc("toggle", "clickety-clacks.ask", "{}")
        wait_for(lambda: layer("omarchy-ask"), "first summon after pin did not open a new overlay")
        assert len(windows()) == 1
        ipc("hide", "clickety-clacks.ask")
        wait_for(lambda: not layer("omarchy-ask"), "shell hide did not close overlay")
        assert len(windows()) == 1
        passed("normal shell toggle opens on the first press after pin and leaves pinned conversations intact")

        # If the disposable nested compositor is present, use its outer
        # window as a harmless native focus target. Do not create a harness
        # window or send text into another application to test this.
        peers = [w for w in json.loads(hypr("clients", "-j")) if w.get("class") == "aquamarine"]
        if len(peers) == 1:
            key(51, 125)
            wait_for(lambda: layer("omarchy-ask-harness"), "selector did not reopen for focus test")
            time.sleep(0.2)
            hypr("eval", f'hl.unbind("SUPER + H"); hl.bind("SUPER + H", hl.dsp.focus({{window="address:{peers[0]["address"]}"}}))')
            key(35, 125)
            wait_for(lambda: json.loads(hypr("activewindow", "-j")).get("address") == peers[0]["address"], "native focus shortcut could not leave the settings popup")
            assert layer("omarchy-ask-harness"), "focus test unexpectedly closed the popup"
            passed("native focus shortcut leaves the still-mapped installed settings popup")
        if uinput_image: passed("all installed-shell cases used the kernel uinput keyboard, not Wayland virtual input")
    finally:
        if keyboard.poll() is None:
            keyboard.stdin.close(); keyboard.wait(timeout=10)
        if uinput_image:
            wait_for(lambda: not any(k["name"] == "ask-shortcut-test" for k in json.loads(hypr("devices", "-j"))["keyboards"]), "temporary kernel keyboard was not removed")
        ipc("call", "clickety-clacks.ask", "closeAll", "")
        hypr("reload", "config-only")
        assert hypr("configerrors") == ""
        assert not any((b["modmask"], b["key"].lower()) in [(0, "f5"), (64, "h")] for b in json.loads(hypr("binds", "-j"))), "temporary bindings were not removed"


if __name__ == "__main__": main()
