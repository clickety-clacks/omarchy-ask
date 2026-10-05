# Newest-modified file ordering

Files now sort by descending modification time in both mixed results and
focused `@` search. Equal timestamps fall back to relevance and stable path
order; unknown timestamps sort last. Other bucket ordering is unchanged.

The live scan enriches paths with timestamps in one bounded streaming worker
per partition, not on the coordinator thread. Its fd child belongs to the
coordinator-owned process group. A slow metadata read therefore affects only
that partition. Index workers reuse their existing candidate stat to supply
timestamps. Bounded retention compares timestamps before pruning, so late
newer files can displace earlier old files.

Testbed stage: `/tmp/ask-mtime-validation.epbZv7GM`, fresh locked npm install.
Full suite: 119 passed, zero failed, five existing opt-in skips (124 total).
New tests exercise actual fd plus the metadata worker with controlled file
mtimes, both main/focused queries, and evidence/display limits. Additional
checks cover index union, unknown metadata, ties, and late replacement.
Existing real-bridge EOF test confirms owned scan shutdown with a TERM-ignoring
child. Tests ran only on Testbed. No QML or shared agent resolver changes.

The five skips are desktop/ABI opt-ins, not new sorting tests. No claim of
live desktop interaction is made for this ordering-only change.

Installed on lumen via complete `omarchy plugin update`, fresh `npm ci`, and
`omarchy restart shell`: build `e4ad16a3ca461b920552919236daed0b4f9e6bf5`.
All tracked installed files match `~/.local/state/ask-mtime-build.1bOAxE`;
installed git state is clean. Backup: `~/.local/state/ask-mtime-backup.PneODI`.
Both Ask and shell settings were retained byte-for-byte. New shell PID 2220641
responds `ok`, Ask is enabled, and Hyprland reports no configuration errors.
This delivery paragraph was added after the immutable build was made.
