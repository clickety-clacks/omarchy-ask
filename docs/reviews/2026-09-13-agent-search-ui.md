# Agent search/settings — isolated Testbed UI verification

Date: 2026-09-13 (2:30–2:45 PM PT)

This is bounded UI evidence for the completed search/settings work. It uses a
disposable nested Hyprland on Testbed and a deterministic fake ACP bridge; it
does not authenticate, contact a model, use the production Agentd Hub, or touch
the normal Testbed compositor/user shell.

## Fixture

- Nested compositor: Hyprland instance
  `efb50993780079460b0cbed1363e2166a2de1d9f_1789334960_1707429056`, PID
  541042, `WAYLAND_DISPLAY=wayland-2`, with a temporary `HEADLESS-1`
  1920×1080 output. The nested parent Wayland output was removed only from
  this disposable compositor so the UI had a real visual surface.
- Ask fixture: `/tmp/ask-hub-ui.YY1ZCQ/actual-search.qml`, Quickshell PID
  586524, using the copied source and temporary HOME/config. The bridge was
  explicitly configured as
  `['python3', '/tmp/ask-hub-ui.YY1ZCQ/ask/tests/shortcut-fake-bridge.py']`.
- The fixture retry timer was corrected to keep locating the real
  Conversation/MenuSearch tree until it exists. Its test-only IPC also exposes
  the settings TextInputs and ListModel message count for evidence.

## Visual result

`grim` captured the actual overlay and companion Scroll motion panel on the
headless output. The rendered panel showed the curve, Reset control, Agentd
Hub label, host and port fields, and the search rows with visible Ctrl+1 …
Ctrl+5 hints. The final screenshot was
`/tmp/ask-hub-ui.YY1ZCQ/final-settings.png` during the run.

## Settings keyboard transaction

Starting from the isolated settings file with an unrelated nested
`agentdHub.extra: "preserve"` field:

1. Ctrl+, opened the real MotionTuner from the Ask composer.
2. Host `hub-ui.example` + Return committed; port `34567` + Return committed.
3. The temporary settings file contained both new values, retained
   `agentdHub.extra`, and retained all other settings.
4. Reopening the panel, editing uncommitted `temporary.example:45678`, and
   pressing Escape restored the opening `hub-ui.example:34567` values and hid
   only the settings panel.
5. Ctrl+, reopened the panel with the committed values intact.

The live IPC observations were:

```text
committed: visible=true host=hub-ui.example port=34567
edited:    hostText=temporary.example portText=45678, host/port unchanged
escaped:   visible=false host=hub-ui.example port=34567
reopen:    visible=true hostText=hub-ui.example portText=34567
```

## Search and Conversation routing

The actual Conversation was populated with one deterministic row in each
bucket: files, repositories, windows, apps, and agents. For every bucket:

- Aggregate activation exercised the same `MenuSearch.run` →
  `Conversation.menuActivate` path used by a row click, and emitted the
  expected browse mode/query.
- Keyboard activation used the visible Ctrl+1 … Ctrl+5 row hints followed by
  Return. Files entered `@`, repositories `^`, and windows `%`; Apps and
  Agents entered their focused bucket modes.
- With the query cleared, two Backspaces exited each focused bucket and
  restored the ordinary five-summary result list.
- After every activation, `messageCount` remained `0`, `waiting=false`,
  `bridgeReady=true`, and `statusText` empty. No aggregate activation became
  a model prompt.

An explicit control prompt (`fake-prompt` + Return) produced
`messageCount=2` through the fake bridge, proving the same composer was live;
closing and reopening restored a fresh `messageCount=0` Conversation.

The Quickshell log had no QML runtime errors. The only startup warnings were
the expected temporary fixture warning that native shortcut-module loading was
disabled and the source-tree MenuModel scanner warning.

No installed user plugin, settings, normal shell, or normal Testbed compositor
was modified. The post-run read-only check did show an experimental
`ask-shortcut-scope` plugin already listed on original compositor PID 1038; this
lane neither loaded nor unloaded it. The disposable nested compositor and QS
fixture process were stopped, and the original `wayland-1` socket remained.
