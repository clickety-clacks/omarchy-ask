# Pinned frame and native attention verification

Base commit: `28e268d5aad6e4dbf052c2ab5f911aa9c775f5c9` (dirty task worktree).
Tested Conversation.qml SHA-256:
`a25a900f562b396af13d153c401b8b77ba370bbebaa5f90597ab3137a3e7a8c1`.

Changes: pinned conversation and file-browser BorderSurfaces use Border.none()
and plain square backgrounds; compositor owns outer rounding/clipping. Overlay
frames remain themed. Completion uses contentItem.Window.window for both active
and alert(0). Removed ASK_ATTENTION_COMMAND and title-based lookup.

## Live checks

An isolated Quickshell host loaded the source Conversation.qml with a dummy
bridge process. IPC delivered the same `done` JSON event consumed from ACP.
These are completion/UI integration tests, not new model-response tests.
The host subscribed to Hyprland socket2 and compared activewindow addresses.

```text
PASS unfocused completion: correct native urgency, Yoohoo entry, unchanged focus
PASS focused completion: no urgency; focusing clears Yoohoo entry
PASS overlay completion: no urgency
```

The initial native-window probe recorded:

```json
{
  "before": "0x556ef7caa7a0",
  "after": "0x556ef7caa7a0",
  "events": ["urgent>>556ef7441d30"],
  "attention": {
    "address": "0x556ef7441d30",
    "title": "Ask native attention TEST",
    "count": 1,
    "source": "native-urgency"
  }
}
```

QML object inspection of both pinned outer surfaces (858×950) returned
`border:0,radius:0`. The visible surface switched correctly between conversation
and file browser. Unpinning restored `border:2,radius:5` on both surfaces.
The test host's logs contained no alert/active TypeErrors.

No Yoohoo API is called by Ask; the independently observed Hyprland urgent event
is the integration contract. Yoohoo was running for these tests and was not
stopped to simulate its absence. Hyprland's existing focus_on_activate=false
policy was unchanged. Other compositor activation policies were not tested.

The isolated windows/processes were closed after testing. No user configuration
was changed. Deployment waited until no existing Ask conversations remained.

## Installed real-prompt check

After deployment and a shell restart, a newly opened/pinned Ask submitted
`Reply exactly ASK_NATIVE_ATTENTION_OK. Do not use tools.` Focus was moved to
an existing terminal before completion. The socket2 observer returned:

```json
{"result":"PASS installed real prompt completion urgency","target":"0x556ef7b483c0","focusUnchanged":true}
```

Yoohoo listed that address as `Omarchy Ask #1`, count 1, source
`native-urgency`. The new shell log contained no Conversation alert TypeError.
`cmp` confirmed the installed Conversation.qml exactly matches the tested
source. `git diff --check` and `hyprctl configerrors` were clean.
