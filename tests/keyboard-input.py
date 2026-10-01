#!/usr/bin/env python3
"""Opt-in desktop test input; uses uinput, not Wayland shortcut-bypassing input.

Run only on an authorized, unlocked test desktop. Each stdin line is a JSON
array of Linux KEY_* numbers forming one chord, e.g. [125, 88] (Super+F12).
No keyboard events, clipboard contents or user text are read. EOF removes the
temporary device. Requires write access to /dev/uinput, never changes its ACL.
"""
import fcntl
import json
import os
import struct
import sys
import time


def main():
    fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
    created = False
    try:
        fcntl.ioctl(fd, 0x40045564, 1)  # UI_SET_EVBIT(EV_KEY)
        for key in range(1, 256):
            fcntl.ioctl(fd, 0x40045565, key)  # UI_SET_KEYBIT
        setup = struct.pack("80sHHHHI", b"ask-shortcut-test", 3, 0x1234, 0x5678, 1, 0)
        os.write(fd, setup + bytes(64 * 4 * 4))  # uinput_user_dev
        fcntl.ioctl(fd, 0x5501)  # UI_DEV_CREATE
        created = True
        time.sleep(0.5)  # allow libinput to discover it
        print("ready", flush=True)

        def event(key, value):
            os.write(fd, struct.pack("llHHi", 0, 0, 1, key, value))
            os.write(fd, struct.pack("llHHi", 0, 0, 0, 0, 0))
            time.sleep(0.04)

        for line in sys.stdin:
            keys = json.loads(line)
            if not isinstance(keys, list) or not keys or any(type(k) is not int or not 1 <= k < 256 for k in keys):
                raise ValueError("expected a nonempty array of Linux key codes (1..255)")
            down = []
            try:
                for key in keys:
                    event(key, 1)
                    down.append(key)
                time.sleep(0.1)
            finally:
                for key in reversed(down):
                    event(key, 0)
            print("sent", flush=True)
    finally:
        if created:
            fcntl.ioctl(fd, 0x5502)  # UI_DEV_DESTROY
        os.close(fd)


if __name__ == "__main__":
    main()
