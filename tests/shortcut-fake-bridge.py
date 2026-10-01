#!/usr/bin/env python3
"""No harness/account/network: deterministic bridge for shortcut GUI tests only."""
import json
import sys


def emit(event):
    print(json.dumps(event), flush=True)


emit({"type": "ready", "permissionMode": "permission"})
for line in sys.stdin:
    event = json.loads(line)
    if event.get("type") == "prompt":
        emit({"type": "text", "text": "Keyboard test response.", "messageId": "test"})
        emit({"type": "done"})
