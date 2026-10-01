# Best-effort shared resolver integration

Source-only work; no osanwe tests or deployment.

Ask consumes shared `match` candidates without requiring transport proof.
Highest-score candidates use active window, then Hyprland focus-history order,
then stable identity as tie-breaks. It rematches against fresh windows and binds
the selected window before final compositor/process/roster checks and focus.
Loss or substitution during rematching never triggers attachment.

An unresolved match permits the verify-target/attach path only with explicit
`candidate_count` and without `local_collection_incomplete`. Incomplete scans
are not treated as proof that no window exists.

The concrete acceptance case is two existing windows for one agent: selecting
the agent focuses an existing window and leaves window count unchanged. Unit
checks do not establish that behavior. The actual osanwe `0_1_9` case remains
unverified and needs separate authorization.

At initial frozen-source integration, review found `match` still called the
remote SSH target probe. Yoohoo acknowledged this mismatch and is correcting
the canonical collector. Ask's real synthetic-remote two-window test is held
until that correction is handed off; no private matcher or mock-resolver
substitute is being used to claim acceptance.

## Corrected handoff and Plumbus result

Synced frozen canonical collector `c080b305`, resolver `90b210c7`, and corrected
Linux collector `c83fd9f9`; all seven hash assertions match. Remote `match` no
longer probes its target. Ask's real two-owned-Ghostty-window test passed with
remote tmux metadata and two equal-ranked title/name candidates. Production
activation chose the active candidate, preserved the complete two-window
identity set, and attempted no new attachment. SSH/mosh guard scripts were not
invoked. Both captured child identities and windows disappeared during cleanup;
a separate compositor query confirmed an empty desktop afterward.

This test uses synthetic remote identity/metadata and actual local desktop
windows, shared collector, Ask selection, and focus. It does not establish the
actual osanwe `0_1_9` click or a live mosh connection. No osanwe deployment or
tests occurred. Controlled adapter checks also passed on Plumbus. The first
core-suite copy omitted `fixtures/mosh-window-hints.json`; that staging omission
was corrected before rerunning the complete core suite.
