# Regression testing

Omarchy Ask currently uses a focused manual integration suite because its most
important behavior crosses Quickshell, Hyprland, Node, and a real ACP adapter.
Run this checklist on Omarchy Quattro before a release.

## Static checks

From the repository root:

```sh
node --check bridge/bridge.js
git diff --check

check_dir=$(mktemp -d /tmp/omarchy-ask-check.XXXXXX)
rsync -a --exclude .git --exclude node_modules ./ "$check_dir/"
omarchy plugin validate "$check_dir"
```

The clean copy is required because npm creates symlinks under
`bridge/node_modules/.bin`, while Omarchy correctly rejects symlinks in a
distributable plugin tree.

## Installation smoke test

```sh
omarchy plugin add https://github.com/clickety-clacks/omarchy-ask.git --enable --yes
cd ~/.config/omarchy/plugins/clickety-clacks.ask/bridge
npm ci
omarchy restart shell
```

Confirm the configured shortcut opens a centered overlay with an input caret,
`>` marker, Ask/YOLO label, and bottom-right pin icon.

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
7. Press Ctrl+, from the composer and the transcript. Confirm the motion editor
   opens as a companion popup immediately right of Ask and both remain usable.
   Drag its curve endpoint and verify impulse,
   friction, distance, and duration update live in every open conversation;
   close and reopen Ask and confirm the values persisted. Reset restores the
   defaults.
8. While a long response streams, scroll upward. Confirm later chunks do not
   pull the viewport down. Return to the bottom and confirm following resumes.

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

Useful observations:

```sh
pgrep -af '/clickety-clacks.ask/bridge/bridge.js'
hyprctl clients -j | jq '.[] | select(.title == "Omarchy Ask")'
journalctl --user --since '5 minutes ago' --no-pager \
  | rg 'Ask.qml|Conversation.qml|ReferenceError|TypeError|qml.*error'
```

## Release acceptance

- Static checks pass.
- No QML errors appear during open, permission, pin, second-open, or close.
- Ask remains the safe default on a clean settings directory.
- The exact open → pin → one shortcut sequence succeeds.
- The manifest version equals the intended tag without the leading `v`.
- The source tree and installed plugin contain every QML entry/dependency file.
