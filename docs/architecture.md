# Architecture and invariants

This document records the design constraints that are easy to lose when
changing the visible QML. They are part of the product contract, not incidental
implementation details.

## Components

`Ask.qml` is the Omarchy plugin entry point and conversation manager. It owns
no ACP process. It tracks one optional unpinned overlay plus any number of
independent pinned conversations.

`Conversation.qml` owns one conversation's UI, message model, permission queue,
overlay window, optional normal window, and bridge process. Pinning reparents
the live card and permission layer into a `FloatingWindow`; it must not copy
messages, restart the bridge, or create a replacement ACP session.

`bridge/bridge.js` adapts newline-delimited JSON between QML and ACP. It starts
one `claude-agent-acp` or `codex-acp` child, initializes one ACP session, and
keeps that session until the conversation closes.

```text
Omarchy Shell
  └─ Ask.qml manager
       ├─ Conversation.qml ─ bridge.js ─ ACP agent/session
       ├─ pinned Conversation.qml ─ bridge.js ─ ACP agent/session
       └─ pinned Conversation.qml ─ bridge.js ─ ACP agent/session
```

## Lifecycle invariants

1. One conversation owns exactly one bridge process and one ACP session.
2. Pinning changes window ownership only. The bridge PID, message model,
   permission queue, and ACP session remain the same.
3. Pinning clears the manager's `activeOverlay` reference but retains the
   conversation object.
4. `Ask.qml.opened` describes only the active unpinned overlay. Omarchy Shell
   consults this property before deciding whether its toggle should summon or
   hide the plugin. Do not redefine it to include pinned windows: doing so
   recreates the post-pin double-hotkey bug.
5. Summoning Ask while pinned conversations exist creates a new conversation.
6. Closing an overlay or normal window shuts down and destroys only its owning
   conversation. `closeAll()` exists as an explicit maintenance/test hook; the
   ordinary shell `close()` never closes pinned conversations.
7. Closing cancels unresolved permissions, asks ACP to close the session, sends
   SIGTERM to the agent, and uses SIGKILL only as a short shutdown fallback.

## Permission invariants

The durable mode is `permission` or `yolo`, stored in
`~/.config/omarchy/ask.json`. Missing, malformed, or unknown values resolve to
`permission`.

- Ask mode queues every ACP permission request and requires an explicit button
  or `Y` / `N` response.
- YOLO selects an option of kind `allow_once`, falling back only to another
  ACP option whose kind starts with `allow`.
- If no allow option exists, YOLO cancels the request. It must never invent an
  option ID or bypass ACP.
- Switching to YOLO resolves already queued permissions through the same ACP
  option-selection rule.
- Tool input, query parameters, credentials, and permission payloads are not
  written to the settings file.

## Message and scrolling invariants

ACP text is streamed as chunks. `bridge.js` forwards each chunk's `messageId`.
`Conversation.qml` appends chunks with the same ID to the current assistant
message and starts a separate visual paragraph when the ID changes. Do not use
tool activity or timing gaps to infer message boundaries.

Before appending a chunk, the conversation records whether the viewport is at
the tail. It schedules `scrollToEnd()` only when that was true. This preserves
automatic streaming for readers at the bottom without pulling someone away
from text they deliberately scrolled up to read.

Submitting applies the same tail test. A reader at the tail has the new prompt
anchored to the top of the viewport; a reader who scrolled up keeps their
position and is never moved. Anchoring works by adding `tailSpace` past the
transcript so the newest prompt can reach the top, then shrinking that room as
the reply grows. The maximum scroll offset therefore stays at `anchorY`, which
holds the prompt still while the reply fills the space beneath it, and ordinary
tail-following resumes once the reply outgrows the viewport. Anchoring is
skipped when the transcript still fits inside the card, because nothing
scrolls. Do not reset the anchor when a reply finishes: collapsing the room
would jump the transcript.

The input's `>` is visual chrome and is never included in the submitted text.

## Durable state and privacy

Omarchy Ask intentionally stores no transcript. QML holds rendered messages in
memory; closing the owning conversation clears them. The app-owned durable
state is the permission mode and the conversation font scale, both in
`ask.json`. That file has two writers — `bridge.js` for the mode, `Ask.qml` for
the scale — so each must merge into the existing contents rather than replace
them.

The font scale is owned by the `Ask.qml` manager, not by a conversation, so
every overlay and pinned window shares one value and one writer persists it. Agent CLIs remain responsible for any data they
store independently.

Bridge stdout is reserved for machine-readable UI events. Agent stderr is
converted to diagnostic events but is not rendered or persisted by the UI.
Avoid logging raw ACP request bodies because they may contain sensitive tool
arguments.

## Compatibility boundary

The plugin targets Omarchy Quattro 4.0.0 and newer. It relies on the Quattro
shell-plugin manifest and lifecycle contract, `PanelWindow`, `FloatingWindow`,
and components from `qs.Commons` and `qs.Ui`. Omarchy 3 is unsupported.

The verified baseline is Omarchy `4.0.0-1`. Changes to public Omarchy shell
components, Quickshell window semantics, or ACP permission option kinds require
the regression checklist in `docs/testing.md`.
