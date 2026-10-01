#!/usr/bin/env python3
"""Live test against the explicit disposable compositor + ShortcutSurface fixture.

Usage: shortcut-routing.py INSTANCE WAYLAND_SOCKET QUICKSHELL_INSTANCE
Never defaults to the user's compositor. No application prompts are submitted.
"""
import json
import os
from pathlib import Path
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

    def state():
        return json.loads(ipc("state"))

    def ready():
        wait_for(lambda: state()["ready"] and state()["focused"],
                 "surface never acquired focus with its scoped shortcut policy")

    def wait_for(predicate, message):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.04)
        raise AssertionError(message)

    def counts():
        return tuple(map(int, hypr("repl", "return ask_test_counts.system, ask_test_counts.release, ask_test_counts.conflict").split()))

    def send(key, mod=None):
        args = ["wtype"]
        mods = [] if mod is None else ([mod] if isinstance(mod, str) else mod)
        for modifier in mods:
            args += ["-M", modifier]
        args += ["-k", key]
        for modifier in reversed(mods):
            args += ["-m", modifier]
        run(*args)
        time.sleep(0.05)

    def passed(name):
        print(json.dumps({"test": name, "result": "pass"}), flush=True)

    def focus_other():
        wait_for(lambda: state()["focusPrimed"], "Ask never relinquished exclusive focus")
        ipc("focusOther")
        wait_for(lambda: any(w["title"] == "Ask Shortcut Test Other" and w["mapped"]
                             for w in json.loads(hypr("clients", "-j"))), "other window never mapped")
        # Invoke a real native shortcut, not an IPC focus workaround in Ask.
        hypr("eval", 'hl.unbind("SUPER + F6"); hl.bind("SUPER + F6", hl.dsp.focus({window="title:Ask Shortcut Test Other"}))')
        send("F6", "logo")
        wait_for(lambda: not state()["focused"], "native focus action never left Ask")

    # Refuse a desktop that is not running our fixture counters.
    assert hypr("repl", "return type(ask_test_counts)") == "table", "not the test compositor"
    ipc("openSurface")
    ipc("focusAsk")
    hypr("reload", "config-only")
    ready()
    assert state()["unregisteredFocus"] == 0, state()
    for _ in range(20):
        ipc("closeSurface")
        ipc("openSurface")
        wait_for(lambda: state()["focused"], "reopened popup never gained focus")
        # No artificial settle delay before the very first chord after focus.
        send("comma", "logo")
        assert counts() == (0, 0, 0), counts()
        assert state()["unregisteredFocus"] == 0, state()
    passed("popup registers before first focus across twenty immediate reopen cycles")
    before = state()
    send("comma", "logo")
    send("Return", "ctrl")
    assert counts() == (0, 0, 0), counts()
    assert state()["owned"] == before["owned"] + 2, state()
    passed("Ask wins both configured conflicts without firing native actions")

    send("F12", "logo")
    send("F5")
    assert counts() == (2, 1, 0), counts()
    assert state()["other"] == before["other"], state()
    passed("unclaimed system chords preserve native press/release and do not type into Ask")

    hypr("eval", 'hl.unbind("F5"); hl.bind("F5", function() ask_test_counts.system = ask_test_counts.system + 10 end); hl.bind("F5", function() ask_test_counts.release = ask_test_counts.release + 10 end, {release = true})')
    send("F5")
    assert counts() == (12, 11, 0), counts()
    passed("live remap while popup stays open")

    hypr("eval", 'hl.bind("SUPER + H", function() ask_test_counts.system = ask_test_counts.system + 100 end)')
    send("h", "logo")
    assert counts() == (112, 11, 0), counts()
    assert state()["other"] == before["other"], state()
    passed("new Super+H mapping works without leaking h into the popup")

    # Matching duplicate system bindings must keep their native semantics.
    hypr("eval", 'hl.bind("F7", function() ask_test_counts.system = ask_test_counts.system + 1 end); hl.bind("F7", function() ask_test_counts.system = ask_test_counts.system + 1 end)')
    send("F7")
    assert counts() == (114, 11, 0), counts()
    passed("multiple native actions on an unclaimed chord remain intact")

    hypr("eval", 'ask_disabled = hl.bind("F8", function() ask_test_counts.system = ask_test_counts.system + 999 end); ask_disabled:set_enabled(false)')
    send("F8")
    assert counts() == (114, 11, 0), counts()
    assert hypr("repl", "return ask_disabled:is_enabled()") == "false"
    passed("disabled bindings are not resurrected")

    # Changing Ask's OWN declaration releases only the no-longer-owned chord.
    ipc("claim", "4:Return")
    ready()
    send("comma", "logo")
    assert counts() == (114, 11, 1), counts()
    ipc("claim", "64:comma 4:Return")
    ready()
    send("comma", "logo")
    assert counts() == (114, 11, 1), counts()
    passed("context-sensitive Ask declaration relinquishes and reclaims precedence")

    ipc("closeSurface")
    time.sleep(0.1)
    send("comma", "logo")
    send("Return", "ctrl")
    assert counts() == (114, 11, 3), counts()
    ipc("openSurface")
    ready()
    send("Return", "ctrl")
    assert counts() == (114, 11, 3), counts()
    passed("close and reopen restore and reacquire scoped precedence")

    hypr("reload", "config-only")
    ready()
    send("Return", "ctrl")
    send("F5")
    assert counts() == (1, 1, 0), counts()
    assert hypr("submap") == "default"
    assert hypr("configerrors") == ""
    passed("compositor config reload preserves scope and refreshed native bindings")

    # Extra modifiers are different shortcuts, not wildcards for Ask's chord.
    hypr("eval", 'hl.bind("SUPER + SHIFT + comma", function() ask_test_counts.system = ask_test_counts.system + 1 end); hl.bind("CTRL + ALT + RETURN", function() ask_test_counts.system = ask_test_counts.system + 1 end)')
    send("comma", ["logo", "shift"])
    send("Return", ["ctrl", "alt"])
    assert counts() == (3, 1, 0), counts()
    passed("extra modifiers preserve distinct native shortcuts")

    focus_other()
    assert state()["visible"], state()
    send("comma", "logo")
    assert counts() == (3, 1, 1), counts()
    ipc("focusAsk")
    ready()
    send("comma", "logo")
    assert counts() == (3, 1, 1), counts()
    passed("mapped but unfocused Ask relinquishes precedence and reacquires on focus")

    hypr("eval", 'hl.bind("CTRL + RETURN", function() ask_test_counts.conflict = ask_test_counts.conflict + 10 end, {release = true})')
    # Keep one input device alive for both halves of each press/release.
    owned = state()["owned"]
    held = subprocess.Popen(["wtype", "-M", "ctrl", "-P", "Return", "-s", "800", "-p", "Return", "-m", "ctrl"], env=env)
    try:
        wait_for(lambda: state()["owned"] > owned, "held Ask key never arrived")
        ipc("closeSurface")
        assert held.wait(timeout=3) == 0
    finally:
        if held.poll() is None:
            held.terminate()
            held.wait()
    assert counts() == (3, 1, 1), counts()
    ipc("openSurface")
    ready()
    passed("an Ask-owned key release does not fire a native action after closing")

    before_release = counts()[1]
    held = subprocess.Popen(["wtype", "-P", "F5", "-s", "800", "-p", "F5"], env=env)
    try:
        wait_for(lambda: counts()[0] == 4, "held system key never arrived")
        focus_other()
        assert held.wait(timeout=3) == 0
    finally:
        if held.poll() is None:
            held.terminate()
            held.wait()
    assert counts()[1] == before_release + 1, counts()
    ipc("focusAsk")
    ready()
    passed("native press/release survives focus leaving Ask while held")

    hypr("eval", 'hl.bind("F9", function() ask_test_counts.system = ask_test_counts.system + 1 end, {repeating = true})')
    before_repeat = counts()[0]
    run("wtype", "-P", "F9", "-s", "1100", "-p", "F9")
    assert counts()[0] > before_repeat + 1, counts()
    passed("native repeating shortcut continues while Ask is focused")

    hypr("eval", 'hl.bind("F10", function() ask_test_counts.system = ask_test_counts.system + 100 end, {long_press = true})')
    before_long = counts()[0]
    send("F10")
    assert counts()[0] == before_long, counts()
    run("wtype", "-P", "F10", "-s", "1100", "-p", "F10")
    assert counts()[0] == before_long + 100, counts()
    passed("native long-press threshold is retained")

    hypr("reload", "config-only")
    ready()
    assert hypr("configerrors") == ""
    hypr("eval", 'hl.bind("CTRL + Return + F11", function() ask_test_counts.system = ask_test_counts.system + 1 end)')
    run("wtype", "-M", "ctrl", "-P", "Return", "-k", "F11", "-p", "Return", "-m", "ctrl")
    assert counts() == (1, 0, 0), counts()
    send("F11", "ctrl")
    assert counts() == (1, 0, 0), counts()
    passed("native multi-key binding sees held Ask key and clears it on release")
    hypr("reload", "config-only")
    ready()

    # Ask must not enter/reset/replace an unrelated application's submap.
    hypr("eval", 'hl.define_submap("ask-test-foreign", function() hl.bind("F5", function() ask_test_counts.system = ask_test_counts.system + 20 end); hl.bind("SUPER + comma", function() ask_test_counts.conflict = ask_test_counts.conflict + 20 end) end); hl.dispatch(hl.dsp.submap("ask-test-foreign"))')
    try:
        send("F5")
        send("comma", "logo")
        assert counts() == (20, 0, 0), counts()
        assert hypr("submap") == "ask-test-foreign"
        ipc("closeSurface")
        send("comma", "logo")
        assert counts() == (20, 0, 20), counts()
        ipc("openSurface")
        ready()
        assert hypr("submap") == "ask-test-foreign"
        send("comma", "logo")
        assert counts() == (20, 0, 20), counts()
        passed("foreign submap remains active across Ask open/close and retains its bindings")
    finally:
        hypr("eval", 'hl.dispatch(hl.dsp.submap("reset"))')
        hypr("reload", "config-only")
    ready()

    pid = str(state()["pid"])
    def rejected(*args):
        # Keep negative malformed modifiers inside the command payload, not
        # as a hyprctl option; the compositor parser is what this test audits.
        result = subprocess.run(["hyprctl", "-i", instance, "askshortcuts", "set " + " ".join(args)],
                                env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        assert result.stdout.strip().startswith("error:"), result.stdout

    for declaration in ["garbage", "-1:h", "4294967296:h", "3:h", "4:NotAKeysym", " ".join(["4:h"] * 129)]:
        rejected(pid, '"omarchy-ask"', declaration)
    rejected("0", '"omarchy-ask"', "64:comma")
    send("comma", "logo")
    assert counts() == (0, 0, 0), counts()
    passed("invalid scope requests are rejected atomically without changing live precedence")

    module = os.environ.get("ASK_SHORTCUT_TEST_MODULE",
        str(Path(__file__).resolve().parents[1] / "hyprland" / "ask-shortcut-scope.so"))
    assert Path(module).is_file(), "test module artifact is missing"
    assert hypr("plugin", "unload", module) == "ok"
    try:
        wait_for(lambda: not state()["ready"], "Ask did not notice module unload")
        send("comma", "logo")
        send("F5")
        assert counts() == (1, 1, 1), counts()
    finally:
        assert hypr("plugin", "load", module) == "ok"
    # No window reopen or explicit config reload is allowed here. Hyprland's
    # module loader itself reloads config, which resets the fixture counters.
    ready()
    restored = counts()
    owned = state()["owned"]
    send("comma", "logo")
    assert counts() == restored, counts()
    assert state()["owned"] == owned + 1, state()
    passed("module unload leaves native bindings usable and reload restores the open surface scope")
    hypr("reload", "config-only")
    ready()
    assert hypr("submap") == "default"
    assert hypr("configerrors") == ""
    print(json.dumps({"result": "pass", "tests": 20}), flush=True)


if __name__ == "__main__":
    main()
