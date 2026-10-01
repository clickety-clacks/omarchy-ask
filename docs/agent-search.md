# Agent search (unreleased work)

Ask's Agentd Hub integration is optional. Configure the hub machine address
and port in the Ctrl+, settings popup. Host names are deployment settings,
not built-in product defaults. Removing the endpoint disables this source.
Search remains available without a hub.

## Results

Matching files, repositories, windows, applications, and agents each have a
count summary at the top. A bucket with exactly one complete match shows that
item directly in place of its summary, without repeating it below. This also
applies to bucket-restricted searches. Partial or capped results retain their
summary. Matching Go menu entries follow, then up to two
ranked examples from every matching bucket. When fewer than twenty individual
rows have been shown, Ask draws additional examples evenly from available
buckets until it reaches twenty or exhausts the matches. Summary rows do not
count toward twenty; directly shown singleton items do. Go entries plus the initial examples may exceed twenty;
the target is not a final truncation limit.

Selecting a summary opens that bucket's matching results. Type `&name` to
search only agents, or `&` alone to list all known agents. The prompt shows an
`&` badge; Backspace on an empty query exits agent mode. Agents match their
displayed name, not their activity or machine. An explicit Agentd name takes
precedence; an unnamed agent can use its tmux session or harness as a fallback
name. Agent rows include the machine and activity. Unknown activity is not
idle, and an unreachable source is not proof that its agents stopped.

## Hub lifecycle

The Ask manager owns one continuously running subscriber, independent of
whether any conversation is open. The subscriber consumes complete snapshots
from `/events` using Server-Sent Events, rather than polling `/snapshot`.
New valid snapshots replace the roster. On disconnect or helper failure,
last-known agents remain visibly unreachable until a new snapshot arrives.
Changing or disabling the endpoint clears the old endpoint's roster.

The hub is read-only. Ask does not install Agentd, deploy a hub, change its
source-host list, or modify harness hooks. Endpoint configuration is stored
with the other Ask preferences in `~/.config/omarchy/ask.json`; unrelated
settings fields must survive an Ask settings save.

## Opening an agent

Existing-window resolution must trace terminal, tmux, SSH, and mosh identity
to the selected agent, not rely on a title or machine-name guess. A verified
existing local window is focused on its workspace without changing its
connection. Otherwise a new terminal attaches to the agent's tmux pane,
preferring mosh with SSH fallback and never detaching existing clients.

A no-tmux notice identifies the agent's machine. Network or authentication
failure must not be reported as proof that the agent has no tmux session.

The original implementation passed independent review and controlled protocol,
isolated desktop, and real tmux transport checks. Evidence is recorded in
[the integration review](reviews/2026-09-13-agent-search-review.md) and
[the independent review](reviews/2026-09-13-agent-search-sol-review.md).
This work is not released or deployed by the installation command yet.
The production Hub deployment is separate; no live production-Hub acceptance
is claimed.

## Shared resolver (unreleased)

Ask now delegates window-to-agent discovery to the shared
`agent-window-resolver` implementation. Its versioned JSON CLI owns read-only
process, tmux, SSH, and mosh identity resolution. Ask retains Hub subscription,
search, notices, terminal attachment, and final compositor focus checks.
Ordinary harnesses and sessions require no registration or special launcher.

The source-only adapter migration has passed independent code review and
controlled adapter tests. It has not been installed or deployed.
Earlier review evidence above describes the original private resolver, not
acceptance of its replacement. Shared graph and synthetic raw parser tests
have passed separately; real shared existing-window and live mosh evidence
remain separate pending acceptance gates. A missing or incompatible shared resolver must be
reported explicitly, never silently replaced with a private duplicate.

The maintained Python library is included under `bridge/agent_window_resolver`.
Ask invokes it through a fixed internal Python helper. There is no separate
resolver installation, command discovery, version handshake, or deployment
configuration. The host's Python 3 runtime is required; the implementation uses
only its standard library. Hub address and port remain user settings.

Current v1 limitation: roaming mosh servers commonly expose a bound UDP socket
without a remote peer. The shared resolver cannot prove those connections
using its full-tuple rule and returns an unresolved result. Synthetic connected
UDP tests do not establish support for this real-world case. The canonical
library tracks it in `docs/mosh-bound-evidence-v2.md`; Ask does not invent a
peer address or maintain a second resolver to bypass it.
