# Regression testing

Omarchy Ask currently uses a focused manual integration suite because its most
important behavior crosses Quickshell, Hyprland, Node, and a real ACP adapter.
Run this checklist on Omarchy Quattro before a release.

## Static checks

From the repository root:

```sh
node --check bridge/bridge.js
node --test bridge/harness-policy.test.js bridge/harness-errors.test.js
node --test tests/search-settings.test.cjs tests/agentd-hub-bridge.test.mjs tests/agent-window-resolver.test.mjs
node --test tests/resolver-process-cleanup.test.mjs tests/agentd-hub-snapshot.test.mjs
node --test tests/shortcut-*.test.* tests/compositor.test.mjs tests/app-search.test.cjs tests/settings-window.test.cjs
git diff --check

check_dir=$(mktemp -d /tmp/omarchy-ask-check.XXXXXX)
rsync -a --exclude .git --exclude node_modules ./ "$check_dir/"
omarchy plugin validate "$check_dir"
```

The clean copy is required because npm creates symlinks under
`bridge/node_modules/.bin`, while Omarchy correctly rejects symlinks in a
distributable plugin tree.

## Agent search acceptance (unreleased work)

The shared-resolver source migration is implemented. The client test suite uses
controlled subprocesses, not live SSH or the shared Linux collector. Ask's
former private process/transport matcher tests have moved to the shared
resolver's `fixtures/ask-regressions-v1.json` and
`tests/test_ask_regressions.py`; keep their results distinct from Ask adapter
and live desktop acceptance. A passing JSON-client test does not prove a
particular existing window or remote connection can be resolved.

The bundled Python integration has a separate read-only local-process check:
`node --test tests/bundled-resolver-local.test.mjs`. Run it on Plumbus with
the bundled package present. It exercises the actual collector against the
test's own process, including revalidation and wrong-start-tick rejection;
it does not focus a window or contact a remote host. Do not count the
controlled subprocess suite as a substitute for this check.

`tests/bundled-resolver-window.test.mjs` is an explicit desktop opt-in:
set `ASK_RESOLVER_WINDOW_TEST=1` with the intended desktop's verified
`HYPRLAND_INSTANCE_SIGNATURE`, `WAYLAND_DISPLAY`, and `XDG_RUNTIME_DIR`.
It creates one independent Ghostty window, discovers its exact sleep child,
resolves and revalidates that descendant using the real bundled collector,
and invokes production local activation with a synthetic roster. It verifies
the actual active stableId and closes the owned window, then verifies child
exit. It does not establish tmux, SSH, mosh, or cross-workspace matching.
Never count its default skipped result as desktop acceptance.

The [feature contract](agent-search.md) and
[independent review](reviews/2026-09-13-agent-search-sol-review.md) track the
acceptance evidence and residual delivery gaps. Passing parser/search tests alone does not establish remote
attachment correctness. Before accepting this feature, verify:

- Full bucket ordering and balanced fill, including more than twenty Go-plus-
  seed rows, exhausted buckets, and keyboard/click summary activation.
- Ctrl+, settings window: endpoint editing, hub commit on Return or close,
  Escape leaving the hub unchanged, restart persistence, and preservation of
  unrelated settings.
- Pushed complete snapshots, removal, unreachable/unknown status, malformed
  then quiet streams, helper crashes, endpoint changes, and no polling.
- Existing direct/local-tmux and pre-existing SSH/mosh windows resolve to the
  exact agent/pane and focus its workspace without connection changes.
- Stale PID, pane, connection tuple, or window identity never selects an
  unrelated target; ambiguous evidence fails closed.
- New attachment really uses mosh when available, falls back to SSH on startup
  failure, and never reconnects after a normal session exit or detaches another
  client. Missing tmux and transport failure produce distinct truthful notices.

Use disposable tmux sessions and isolated Wayland fixtures with the fake ACP
bridge. Do not submit a model prompt merely to verify search or settings.

## Installation smoke test

For opt-in live system-harness verification, run
`node bridge/model-smoke.js --full`. This sends 41 short tool-free prompts
using existing logins and verifies model/effort metadata and response text.
Omit `--full` for the default plus eight models at low effort.

```sh
omarchy plugin add https://github.com/clickety-clacks/omarchy-ask.git --enable --yes
cd ~/.config/omarchy/plugins/clickety-clacks.ask/bridge
npm ci
omarchy restart shell
```

Confirm the configured shortcut opens a centered overlay with an input caret,
square marker, Ask/YOLO label, and bottom-right pin icon. Confirm Ask never
changes the active compositor submap, including when another application has
selected a non-default submap. The legacy `useHyprlandShortcutSubmap` preference
must not reenable submap management.

## Shortcut inheritance integration (release gate)

The module in `hyprland/` is an in-progress integration, not a released install
dependency. Build against the exact supported running Hyprland ABI with
`make -C hyprland`; never load development builds into an active user desktop.
The [plumbus evidence](reviews/2026-09-13-plumbus-shortcut-scope.md) records the
disposable compositor setup, fixture paths, and unresolved acceptance work.

- Run `tests/shortcut-routing.py INSTANCE WAYLAND_SOCKET QS_INSTANCE` against
  `tests/ShortcutSurface.qml` and `tests/shortcut-compositor.lua`. It verifies
  native action counters as well as application delivery, including live
  remaps, focus, press/release, repeat, multi-key bindings, foreign submaps and
  module lifecycle. The synthetic-input keymap setting is test-only.
- Run `tests/actual-shortcut-routing.py INSTANCE WAYLAND_SOCKET QS_INSTANCE`
  against `tests/actual-ask-root.qml` with `tests/shortcut-fake-bridge.py` as
  `ASK_BRIDGE_COMMAND`. It verifies actual overlay/selector/pinned-window
  handlers, repeated pin admission, search Backspace, permission letters and
  file-browser context changes; it does not authenticate or test a model.
- `tests/keyboard-routing.py INSTANCE WAYLAND_SOCKET QS_INSTANCE` uses the
  complete-keymap virtual keyboard built by `tests/Makefile`. Unlike the wtype
  fixture, it disables `resolve_binds_by_sym` and tests conventional evdev
  codes, explicit native code bindings, device inclusion filters, shifted
  symbols, US/German layout groups, Caps Lock, keypad Enter and Shift+Tab.
  It also holds the same code on two live keyboards with different keymaps.
  Repeat with `--same-map-groups` to check two identical keymaps with different
  active groups and first-event delivery during a device switch.
  This is protocol-level input, not a claim of physical hardware testing.
- Build the test global-hotkey client with `make -C tests
  HYPRLAND_PROTOCOLS=/path/to/exact-hyprland-source/protocols`, then run
  `tests/hotkey-routing.py INSTANCE WAYLAND_SOCKET QS_INSTANCE` against the
  controlled popup. This registers real client-managed global hotkeys and
  verifies precedence, dynamic registration and held-key release delivery.
- Verify that native window-focus shortcuts can leave a mapped Ask popup;
  the brief opening focus acquisition must not become a permanent grab.
- The controlled popup audits first focus and sends the first chord immediately
  across twenty reopen cycles. Also verify pinned-window startup and context
  transitions; popup admission alone does not prove those cases.
- Verify Ask's context-specific overrides, real physical input/device bindings,
  alternate layouts/shifted symbols and shell failure. These are broader
  requirements than the current automated cases.
- The [management tool](shortcut-module.md) has an opt-in ABI mismatch test and
  has been used for build/load/idempotence/unload/reload on plumbus. Verify normal
  plugin startup integration and recovery after a compositor upgrade before
  treating this worktree as release-ready.
- With no existing actual-Ask fixture running, run
  `tests/shortcut-startup.py INSTANCE WAYLAND_SOCKET /absolute/actual.qml CACHE`.
  It starts and owns its test shells, delays dependency setup to verify opening
  cancellation without a bridge, and checks failed/missing executables do not
  block opening, native F5 or pinning. It uses an isolated executable PATH and
  the deterministic fake bridge, not the user's harness.
- `tests/shortcut-shell-exit.py INSTANCE WAYLAND_SOCKET QS_INSTANCE CONFIG_PATH`
  deliberately kills only the validated disposable shortcut fixture while
  focused, then verifies that native conflicts and F5 recover without a reset.
  Relaunch that fixture and repeat the routing suite afterward. Do not pass
  the user's Omarchy shell or installed configuration.
- `tests/installed-shortcut-routing.py INSTANCE WAYLAND_SOCKET QS_SHELL_ID`
  targets a fully installed/enabled Ask in the normal Omarchy shell. It requires
  unused F5 and Super+H and refuses existing Ask conversations. It adds temporary
  native bindings and restores them with config reload. It covers both settings
  popups with the cursor outside their cards, live remapping, pinning and normal
  shell toggling; with a nested compositor present it also checks native focus
  can leave the settings popup. No prompt is sent to the real system harness.
  The optional `--uinput-image sha256:IMAGE_ID` backend repeats these through a
  temporary kernel keyboard in a restricted, already-authorized Docker runtime.
  See [module verification](shortcut-module.md) for the isolation/cleanup rules.

## Conversation checklist

1. Submit a short prompt and confirm streamed text appears incrementally.
2. Submit a prompt that produces multiple assistant messages around a tool
   call; confirm separate ACP message IDs render as separate paragraphs.
3. Confirm assistant text is sans-serif, user prompts remain serif/italic, and
   there is breathing room before the next input.
4. Click a Markdown link and confirm the desktop URL handler opens it.
5. Use arrows, Page Up/Down, and Ctrl+H/J/K/L/U/D to scroll. Confirm each
   press supplies momentum, held/repeated keys build speed, opposite keys
   brake or reverse it, and the transcript coasts to a stop after release.
6. Scroll a long transcript with a trackpad and with a touch drag. Confirm the
   surface coasts after release and stops cleanly at both ends.
7. Press Ctrl+, from the composer and the transcript. Confirm one settings
   window opens as an ordinary window (movable like any other), Ask's popup
   steps aside, and returns with its text when Ctrl+, or Escape closes the
   window. Drag the curve endpoint and verify impulse,
   friction, distance, and duration update live in every open conversation;
   close and reopen Ask and confirm the values persisted. Reset restores the
   defaults.
8. Press Ctrl+, from both overlay and pinned windows. Confirm the settings
   window shows Codex/Claude, model, and thinking controls and that choices
   apply at once. Open a new conversation and confirm the bridge uses the selection,
   then restart the shell and confirm it persists. Verify an already-open
   conversation retains its existing ACP session.
9. Type `Hey what is 5+5`, `sum 10 34 100 110 123`, `72 F to C`, and
   `5 GiB in MB`. Confirm the calculator is always the first row, its equation
   is subordinate to the answer, long equations elide in the middle, and
   selecting it copies the answer. Confirm prose containing an isolated number
   does not produce a calculator row.
9. Type text matching files and repositories. Confirm compact `matched files`
   and `matched git repos` rows rank near the top without flooding ordinary
   menu results. Select each and confirm Ask enters the corresponding inline
   result mode. Repeat by typing `@`, `^`, and `%`; confirm the square marker
   becomes the boxed prefix and Backspace on an empty query restores the
   square. Confirm `%` groups windows under workspace headers without making
   those headers selectable. Confirm hover/keyboard selection reveals the complete action hint.
   Confirm focused modes scroll inside a bounded result viewport and that all
   backend matches remain reachable rather than stopping after eight rows.
   Confirm Return opens the result, Ctrl+Return opens its containing folder,
   and Shift+Return copies the absolute path. Confirm all three actions close
   the transient overlay but leave a pinned Ask window open. Confirm the first
   ten visible rows show Ctrl+1 through
   Ctrl+0, that each shortcut only moves the selection, and that the numbering
   follows the visible viewport 0.5 seconds after scrolling stops. Confirm
   repeating the same shortcut performs the row's normal Return action.
   Confirm arrows scroll the list when selection crosses a viewport edge;
   after independent scrolling leaves selection off-screen, Down snaps to the
   first visible row and Up snaps to the last visible row.
   Configure distinct `fileOpenCommand` and `fileEditCommand` argv arrays;
   confirm Return and Alt+Return append the selected path to the corresponding
   command. Remove them and confirm the legacy fallbacks still run.
   Coast into either end of the transcript and file list. Confirm momentum
   terminates as soon as the boundary is reached rather than leaving the
   surface in a running coast state.
10. While a long response streams, scroll upward. Confirm later chunks do not
   pull the viewport down. Return to the bottom and confirm following resumes.
11. With Codex selected, submit a turn that remains active long enough to type
    a correction. Confirm the composer remains enabled, Return inserts the
    correction into the transcript, and the subsequent response follows the
    correction without ending the session. With an agent that does not
    advertise `_meta.steering.supported`, confirm the composer remains hidden
    while its turn is active.

## Permission checklist

1. In Ask mode, request a tool operation. Confirm the centered dialog appears
   above long tool/status text and both buttons work.
2. Repeat using `Y`, then using `N`.
3. Queue more than one permission and confirm the queue count and ordering.
4. Switch to YOLO, restart Omarchy Shell, and confirm YOLO remains selected.
5. Trigger a tool in YOLO and confirm ACP's allow option is selected without a
   dialog.
6. Switch back to Ask and confirm the persisted setting changes.

## Pinning and concurrency checklist

1. Start a conversation and note its bridge PID.
2. Click the pin icon. Confirm Hyprland maps a normal window titled
   `Omarchy Ask` and the bridge PID does not change.
3. Repeat with `Ctrl+P`, from a focused prompt and from a clicked transcript
   selection, and confirm both pin the conversation the same way.
4. Continue the conversation in that window and confirm prior context remains.
5. Invoke the global shortcut once. A fresh overlay must open immediately;
   the pinned window must remain.
6. Confirm there are now two bridge processes.
7. Close the fresh overlay. The pinned window and its bridge must remain.
8. Close the pinned window. Its final bridge process must exit.
9. Leave a pinned conversation unfocused while its reply completes. Confirm
   Hyprland receives one urgency event, focus and workspace do not change, and
   focusing the Ask window clears its attention state. Repeat while Ask is
   focused and confirm it does not enter the attention list. Repeat with two
   pinned conversations using native window urgency; confirm only
   the conversation that completed is marked.

Useful observations:

```sh
pgrep -af '/clickety-clacks.ask/bridge/bridge.js'
hyprctl clients -j | jq '.[] | select(.title == "Omarchy Ask")'
journalctl --user --since '5 minutes ago' --no-pager \
  | rg 'Ask.qml|Conversation.qml|ReferenceError|TypeError|qml.*error'
```

## Release acceptance

The opt-in `tests/preview.test.cjs` checks the real Conversation and GJS
file-preview helper on Plumbus. With its desktop reserved and the active
Wayland/Hyprland environment set, run `ASK_PREVIEW_UI_TEST=1 node --test
tests/preview.test.cjs`. It uses temporary HOME/config/cache, starts no harness,
and checks mixed results, same-index result replacement, `@` search, non-file
selection, legacy file browsing, pointer exit, and close cleanup. The fixture
requires a Wayland backend; offscreen Quickshell has no PanelWindow backend.

For the duplicate-agent-window regression, the opt-in
`tests/bundled-resolver-mosh-windows.py` exercises the real Ask activation path
with two live Ghostty/mosh clients attached to one private tmux pane. Run only
on the authorized Plumbus desktop, after coordinating exclusive desktop use
and reviewing the fixture lifecycle. It requires `ASK_BUNDLED_MOSH_WINDOWS_LIVE=1`,
`YOOHOO_MOSH_LIVE=1`, `YOOHOO_LIVE_TEST_HOST=1`, the active Hyprland/Wayland
environment, and Yoohoo's private fixture helpers (`ASK_MOSH_SUPPORT_ROOT`).
Use `python3 -B`; optional `ASK_MOSH_BRIDGE_ROOT` selects the staged bridge and
`ASK_NODE_EXECUTABLE` selects its Node runtime. This is test configuration,
not product resolver setup. See
[`real-mosh acceptance`](reviews/2026-09-14-real-mosh-acceptance.md) for the
passed run, exact scope, and cleanup evidence.

- Static checks pass.
- No QML errors appear during open, permission, pin, second-open, or close.
- Ask remains the safe default on a clean settings directory.
- The exact open → pin → one shortcut sequence succeeds.
- The manifest version equals the intended tag without the leading `v`.
- The source tree and installed plugin contain every QML entry/dependency file.

The guarded GitHub release workflow and maintainer procedure are documented in
[`release.md`](release.md).
