# Agent search implementation review

Status: implementation accepted after Luna xhigh implementation and Sol high
independent review. The chronological failures below were intermediate
findings; subsequent fixes and retests are recorded explicitly. No release
or installed lumen deployment was performed.

## Agreed behavior

- Matching bucket summaries precede individual results; counts are not counted
  toward the fill target.
- Matching Go entries precede bucket examples.
- Each matching bucket contributes up to two ranked examples initially.
- Additional examples favor the least represented available buckets, rotating
  ties until there are at least 20 individual rows or no more matches.
- Twenty is a minimum fill target, not a truncation limit.
- Agent names match independently of activity state; rows show machine and
  truthful status, including unknown and unreachable state.
- Hub address and port are optional persistent settings in Ctrl+,.
- One manager-owned subscription remains alive without an open conversation;
  complete SSE snapshots replace current state, with reconnect on disconnect.
- Existing windows are resolved through terminal/tmux/remote transport identity,
  then focused without reconnecting or changing their tmux connection.
- A missing local window opens a new attachment, preferring mosh with SSH
  fallback and never detaching an existing client.
- No-tmux notices identify the machine; transport failures must not be falsely
  described as proof that the agent has no tmux session.

## Review gates

- Pure ordering tests: zero/one/many buckets, exhausted buckets, uneven supply,
  many Go rows, stable ranking, counts, no duplicates, no final hidden row cap.
- SSE tests: chunk boundaries, CRLF, complete replacement, quiet stream,
  disconnect/reconnect, invalid data, endpoint change, disable, shutdown.
- Identity tests: duplicate names, same PID on two hosts, reused PID, stale
  window, multiple tmux panes/windows, custom socket, ssh/mosh wrappers.
- Activation tests: existing focus does not spawn or attach; mosh unavailable
  or startup failure falls back; successful session closure does not reconnect;
  malicious metadata cannot become shell syntax or command options.
- Settings tests: persistence across reopen/restart; unknown fields survive;
  Escape/Return behavior and keyboard routing remain correct.
- QML integration: buckets can be opened, keyboard and click activation agree,
  pushed roster changes update results without submitting a model prompt.
- Keep installed lumen image work intact; distinguish source tests, desktop
  integration tests, and actual live hub verification in final reporting.

## Baseline evidence

Before implementation, 14 harness-error, harness-policy, shortcut-policy and
shortcut-platform Node tests passed. Existing MenuSearch capped ordinary results
at eight and did not implement the agreed bucket ordering. Existing Ask settings
writer replaced rather than preserved unknown fields.

## Intermediate runtime diagnostics (not final acceptance)

The parent loaded the actual working-tree `MenuSearch.qml` in Quickshell with
the offscreen Qt platform and a temporary HOME. Fixture:
`/tmp/ask-agent-qml.ASG9qR/shell.qml`. No installed plugin was replaced and no
model prompt was submitted.

- Fifteen file candidates and fifteen window candidates produced two summaries
  and twenty individual rows, evenly split ten per bucket. Passed.
- Twenty-five Go matches plus the two bucket seeds produced thirty-one rows:
  two summaries, twenty-five Go entries, two files and two windows. Passed;
  this proves the fill target is not a final truncation cap for this case.
- Activating the Windows summary emitted no browse request and returned
  `lastRunKeepsOpen=false`. Failed; reported to implementer and reviewer.
- Current bridge/window JavaScript syntax, clean-copy plugin validation and
  whitespace checks passed. These are not desktop or live-Hub acceptance.

The user-referenced local `ask` tmux pane `%1` was verified to be this root
conversation, not an independent agent. The existing window implementation is
therefore the prior code in this repository, not an outstanding external
handoff.

The parent also ran the actual Node hub bridge against an ephemeral loopback
HTTP/SSE fixture (`/tmp/ask-agent-qml.ASG9qR/hub-diagnostic.mjs`). Seven scoped
checks passed: initial snapshot, complete replacement with an empty roster,
retention of `not_reached` agents with their source-state flag, atomic rejection
of a malformed frame, reconnect after stream end, a 31-second quiet connection,
and requests exclusively to `/events` (two connections, no snapshot polling).
The fixture terminated its child and closed its listener. This is controlled
protocol evidence, not production-Hub or window-activation acceptance.

Later runtime checks confirmed the Windows summary emits `browseRequested`
with `windows` and retains the search popup. The balanced-fill and beyond-20
Go checks remained passing.

An actual QML wire integration (`hub-wire.qml` and `hub-wire.mjs` in the same
temporary fixture directory) connected `AgentdHub.qml` through its real Node
helper to an ephemeral SSE server and bound the roster into `MenuSearch.qml`.
Four checks passed: receiving the roster, rendering the pushed name/machine,
updating a retained row to unreachable, and clearing results after a complete
empty snapshot. It used no model prompts, activation, or installed settings.

Eighteen harness/shortcut/bridge checks passed in the combined Node run.
The later search-settings plus bridge run passed eight named tests. These
counts overlap and must not be added together as unique cases.

Exact tmux attachment was checked with a separate disposable server/socket
and two sleeping panes: an actual PTY client attaching to `=proof:0.%1`
reported active pane `%1`. The owned test server was then terminated; user
tmux sessions were untouched. This proves the target syntax, not remote
transport or existing-window identification.

The parent helper-crash wire test (`hub-crash.mjs`) killed only the exact
bridge child of its owned offscreen QML fixture. The helper restarted and
received a fresh roster, but the test failed because `connecting` temporarily
cleared the retained roster: after initial populated results, row counts were
`1,1,1,1,0,0,1`. Reported to both implementation and review. Same-endpoint
restart must preserve last-known rows as unreachable; disable or endpoint
change may clear them. Fixture processes/listener were cleaned up.

Search/settings subsequently received a no-code-blocking-findings verdict
from Sol after independent review/tests. Parent real-Wayland manager testing
on Testbed (`/tmp/ask-hub-ui.YY1ZCQ/manager.qml`) saved a test endpoint, restarted
the actual `Ask.qml` manager, and observed the same host/port with zero
conversations. Both an unknown top-level image-test object and an unknown
nested `agentdHub.extra` field survived. Native module loading was disabled
explicitly in the test-only Node shim; no visible window or model was opened.
The shim was corrected to use Testbed's discovered mise Node executable rather
than assuming `/usr/bin/node`, and the manager restart was rerun successfully.
This tests persistence, not keyboard/visual settings interaction.

Subsequent parent retests resolved the helper-crash failure: all result updates
after the first populated roster retained one row during restart, and the
helper reconnected. The expanded black-box bridge suite also passed recovery
from a malformed complete snapshot followed by silence. It now has eight
scoped checks (superseding, not adding to, the earlier seven), with exactly
three `/events` requests for the initial/malformed/disconnect sequence and no
polling or reconnect during a subsequent 31-second quiet period.

Real PTY launch evidence: actual `transportLaunchScript()` attached to an
isolated Testbed tmux server (`ask-hub-transport-proof-20260913`) and exact
`proof:0.%0` pane. The client process was a child of `mosh-server`, proving
mosh was actually used. The sleeping pane expired, launcher returned zero,
and all owned server/client processes were gone; no SSH fallback followed
normal exit. No existing user session was attached or changed.

A forced mosh-startup-failure test (test-only executable exits 23, real SSH
fallback to a second disposable server) failed with `open terminal failed:
not a terminal`. The generated SSH attachment lacked PTY allocation. This
was reported to Luna and Sol; pure fake-executable branch tests had not
covered the remote terminal requirement.

After the SSH attachment added `-tt`, the real fallback retest passed with
`TERM=xterm-256color`: a forced mosh startup exit 23 led to a real SSH client
on the exact disposable `proof:0.%0` target, then a clean exit zero. The first
retest's default test PTY TERM was unsuitable for tmux and was corrected in
the fixture, not the product. The disposable sleeping session autoexpired.

## Final acceptance

Luna xhigh implementation and Sol high independent review are complete, with
no open code findings. The final combined automated suite passed 30/30 tests;
syntax checks, diff checks, and clean-copy plugin validation also passed.
Additional evidence covers actual Hub-to-QML updates and recovery, isolated
settings/search UI interaction, existing-window identity resolution, and real
mosh and SSH-fallback attachments. See the independent and UI review artifacts
for scope and environmental limitations.

Owned test windows, nested compositor, helpers, and disposable tmux sessions
were cleaned up. The installed lumen plugin and user sessions were untouched.
This work remains unreleased; production Hub deployment is separate and pending.
