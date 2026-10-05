# Agent search — independent Sol review

Reviewer: Sol, high reasoning

Status: **accepted in the reviewed implementation scope**. Search, settings,
Hub streaming, failure recovery, existing-window resolution, and new tmux
attachment satisfy the feature contract with the evidence below. This is not a
claim that the pending production Agentd Hub has been deployed or accepted.

## Scope and baseline

- Review target: agent search, manager-owned Agentd Hub subscription, persistent
  Hub endpoint settings, and existing-agent/new-attachment activation.
- Baseline commit: `a6351b0e5fb0816dbaccc1180c318bd955196023` on `main`.
- The worktree already contained unrelated shortcut-inheritance work. This
  review changed only this review artifact and did not attribute or discard
  other agents' or the user's changes.
- Baseline checklist: `2026-09-13-agent-search-review.md`.
- Before this implementation, ordinary search was capped at eight rows and the
  settings writer rebuilt a fixed object, losing unknown settings. Both defects
  are resolved in the reviewed implementation.

## Review gates

- [x] Current search, settings, Hub client, manager, resolver, and activation
  diff reviewed.
- [x] Hub `/events` contract checked against published Agentd Hub v0.1.0 source.
- [x] One manager-owned continuous SSE subscription, full replacement,
  reconnect without polling, quiet-stream behavior, endpoint changes, and
  helper-crash recovery have controlled runtime evidence.
- [x] Unknown, degraded, and unreachable states remain distinct and visible;
  endpoint configuration is optional, persistent, and not hardcoded.
- [x] Search summary ordering, counts, Go precedence, two-example seeds,
  least-represented rotating fill to 20, exhaustion, stable ranking, no
  duplicates, and the absence of a final 20-row truncation are tested.
- [x] Agent displayed-name matching is independent of activity; machine and
  truthful status are visible. Unnamed agents use tmux-session/harness fallback.
- [x] Existing local and ordinary session-only mosh windows have read-only
  positive identity-resolution evidence. PID reuse, inactive pane, ambiguity,
  wrong remote pane, wrong SSH endpoint tuple, historical launch arguments,
  roster movement/removal, and Hypr address reuse fail closed.
- [x] Final focus re-resolves the current roster target and then the mapped
  Hypr window by stable ID and PID immediately before dispatch, after slow
  remote probes.
- [x] New local/remote attachment revalidates exact Agentd PID/start ticks,
  ancestry under the advertised pane, current tmux target, source reporting,
  and `presence=present` immediately before launching.
- [x] New remote attachment actually uses mosh in a PTY, falls back to
  PTY-allocated SSH after a nonzero mosh exit, and does not fall back after a
  normal mosh session exit.
- [x] Terminal spawn observes both `spawn` and asynchronous `error` events;
  success is not emitted until the terminal child has started.
- [x] Tmux attachment uses one exact pane-qualified attach and never uses
  `attach -d` or `detach-client`.
- [x] Metadata used in argv/shell fragments is validated and shell-quoted;
  structured agent IDs avoid delimiter collisions; search labels render as
  plain text. Remote environment inspection is allowlisted to normalized SSH
  endpoint metadata and does not persist or emit the environment.
- [x] Settings preserve unknown top-level and nested fields across save/reload;
  Return explicitly commits and Escape restores the opening endpoint values.
- [x] Ctrl+, aggregate routing, focused bucket Return/Backspace semantics, and
  delegate-click routing have source and controlled UI coverage.
- [x] Relevant current search/bridge tests independently rerun.
- [x] Isolated Wayland keyboard, settings, bucket-routing, and visual evidence
  was reviewed; it used a fake bridge and sent no real model prompt.
- [x] Production-Hub and deployment gaps are explicitly recorded.

## Open findings

None in the reviewed implementation scope.

## Resolved findings

The following issues were reported during review and corrected before this
verdict:

- Local Agentd-to-pane and tmux-client-to-Hypr process ancestry was reversed.
- Hub source health and scan state were discarded from projected agent rows.
- A 30-second inactivity timeout disconnected valid quiet SSE streams.
- Transport failures were falsely labeled as proof of missing tmux.
- Invalid frames were partially accepted and could leave an untrusted,
  potentially silent stream open rather than reconnecting atomically with the
  last-good state retained.
- Cumulative SSE `data:` content was unbounded.
- The manager cleared last-known agents or stayed dead after helper failure;
  it now marks rows unreachable, restarts with bounded backoff, and resets the
  delay only after a valid snapshot.
- Blank endpoint handling, scheme-plus-explicit-port behavior, nested settings
  merge, focused aggregate no-ops, Apps routing, literal label rendering, and
  QML/bridge agent-ID encoding were corrected.
- Agent search initially considered activity and machine metadata rather than
  only the displayed name, and status labels could misstate unknown activity.
- Ordinary remote terminal descendants were not correlated through the live
  SSH/mosh transport to the current remote tmux client and exact agent pane.
  The resolver now requires that live evidence. Historical terminal launch
  arguments are hints only and cannot authorize focus after a pane switch.
- Remote probe output exceeded its original buffer on a real host. The bounded
  allowance now accommodates the observed topology while retaining a cap.
- New attachment originally checked only that a tmux target existed. It now
  verifies PID/start ticks and pane ancestry locally or over the read-only SSH
  preflight, then rejects roster/location changes before launch.
- Mosh was probed without a controlling terminal and therefore always fell
  through to SSH. Mosh now runs in the actual terminal after SSH identity
  preflight, with a tested nonzero-exit fallback. SSH attachment now requests
  a PTY with `-tt`.
- Asynchronous terminal spawn errors were unobserved and could crash the bridge.
  Launch is now acknowledged through the child's `spawn`/`error` events.
- Existing-window focus retained a Hypr address across slow remote probes. It
  now repeats exact live correlation, rejects roster removal or tmux movement,
  then obtains a fresh mapped address for the same stable ID and PID.
- Remote existing-window matching was initially disabled for retained
  unreachable/unknown rows. Exact live transport/tmux/PID evidence may now
  focus that already-open local window; source health still strictly gates any
  new connection.
- Exact new tmux attachment was reduced to one pane-qualified attach. Normal
  tmux attachment can change the shared session's active view, but no separate
  preselection occurs before terminal startup and no existing client is
  detached.

## Evidence

- Local Agentd v0.3.2 was queried read-only; scans were complete. The actual
  Desktop Agentd identity `pid=717058,startTimeTicks=84458215` at `ask:1/%1`
  resolved through production `localTopology/findMatch` to the mapped Ghostty
  window `pid=696768`. No focus or pane-content access occurred.
- A real remote host Agentd identity in `drift:0/%110` resolved read-only through an
  ordinary desktop Ghostty to a session-only mosh launch and the correct terminal
  PID in about 3.0 seconds. No focus, attach, or transport mutation occurred.
- A current remote host attachment preflight returned a bounded topology snapshot
  and proved exact PID/start ticks and pane ancestry for the advertised target.
  Pure negative cases reject stale ticks, inactive panes, ambiguity, wrong
  remote panes, wrong endpoint tuples, historical argv pointing at another
  pane, moved roster targets, reused windows, and removed windows.
- Published Agentd Hub tag `v0.1.0` was inspected at tag object
  `55c3c6224a31413914453fc5ecde8d484afe952a` (peeled commit
  `1f08782d6cbf86d158b25610784aa295198ed142`). `/events` sends complete
  `agentd-hub.snapshot.v1` frames immediately and on change, with no heartbeat.
  `sources[].health` distinguishes `reporting`, `not_reached`, and `no_agentd`;
  `not_reached` retains last-known agents.
- The actual Node bridge passed an eight-case loopback SSE diagnostic: initial
  snapshot, empty replacement, retained unreachable source, atomic invalid-frame
  rejection, invalid-frame reconnect after silence, ordinary reconnect,
  31-second quiet health, and `/events`-only access with zero snapshot polling.
- Actual QML wire evidence passed four checks from `AgentdHub` through Node SSE
  into `MenuSearch`: appearance, unreachable update, and complete removal.
  Helper SIGKILL recovery restarted the child while keeping the last-known
  roster visible as unreachable until a fresh valid frame.
- Actual Ask-manager persistence on isolated test machine Wayland saved and reloaded
  address/port with zero conversations while preserving unrelated top-level and
  nested settings. It used a temporary HOME/source copy and no installed edits,
  visible user window, or model prompt.
- Search runtime evidence covers all five summary buckets, aggregate routing,
  balanced and uneven fills, short and greater-than-20 Go cases, truthful capped
  and incomplete counts, structured identity, and focused Apps/Agents behavior.
- Isolated nested-Wayland UI verification exercised Ctrl+, Return commit,
  Escape cancellation, all five aggregate routes, keyboard selection, focused
  Backspace exit, and conversation reopening. A screenshot showed coherent,
  unclipped endpoint fields and five summaries. Delegate source routes a mouse
  click through the same `menuIndex` plus `menuActivate` path; physical pointer
  injection was not separately repeated. See `2026-09-13-agent-search-ui.md`.
- A disposable real PTY attachment used mosh end to end on the test machine and reached
  the exact target pane; normal session exit returned zero and did not invoke
  SSH. A second disposable PTY run forced mosh to exit 23 and verified real SSH
  fallback with `-tt` to the exact pane. Owned clients, servers, and tmux
  fixtures exited or expired; no user session was touched.
- Independent final focused rerun: twelve bridge/resolver/activation tests plus
  four search/settings tests passed (16/16). The bridge passed `node --check`,
  and `git diff --check` also passed. Parent regression evidence reports 24
  earlier harness/shortcut tests passing.

## Residual environment and delivery gaps

- Deployment documents still state that the production Agentd Hub on the remote host is
  pending the explicit-host release decision. No live production-Hub acceptance,
  deployment, daemon mutation, release, or installed-plugin change is claimed.
- Published Agentd v0.3.2 `TmuxLocation` has no socket field, so custom-socket
  handling in Ask is defensive/additive but cannot be demonstrated from the
  deployed Agentd schema.
- Ordinary live SSH-window association has exact endpoint-tuple coverage and
  was checked against the remote host's real metadata constraints, but no suitable
  pre-existing SSH terminal was available for a full read-only end-to-end
  resolver match. The equivalent existing-window path was demonstrated through
  a real session-only mosh terminal.
- Review deliberately did not focus a user's live agent window. Exact resolver
  output was demonstrated read-only, and final stable-ID/PID/address dispatch
  protection is covered by source review and negative tests. The exact running
  Hyprland source was also checked: the Lua `focus` dispatcher uses the normal
  focus action, which changes to the target window's workspace before focusing.
