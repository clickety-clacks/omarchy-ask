# Single-match buckets and fresh Pictures files

Confirmed on the desktop by read-only diagnostics: the reported screenshot exists
in Pictures and direct `fd` finds it. The installed file bridge emitted an
empty, supposedly complete result. Its whole-home `fd` invocation found the
exact screenshot in stdout but was killed at its 15-second timeout; the bridge
discarded that output. Pictures was absent from the priority roots.

Changes:

- Include Pictures, Music, and Videos in the existing priority-root search.
- Preserve complete path records collected before a failed/timed-out scan;
  discard a potentially truncated final record and mark results incomplete.
- Escape filename punctuation literally in fallback matching.
- Replace a complete single-match bucket with its direct item across all five
  bucket types and focused searches. Avoid repeating promoted items, count
  them toward the twenty-item fill, and preserve direct activation.

The test machine stage: `/tmp/ask-singleton-check.vDl0uL`.
Ten checks passed via `node --test tests/files-bridge.test.mjs
tests/file-fallback.test.mjs tests/search-settings.test.cjs`: actual native
file bridge with fresh Pictures files, fallback with real fd and simulated
index/timeout conditions, partial-record handling, literal punctuation,
QML singleton/order/activation/balancing and settings checks.

The screenshot regression fails against the pre-fix installed source with
an empty result and passes against the corrected source. No screenshot
content was transferred; fixtures create their own temporary files.
The desktop preview test's agent-row expectation was updated but that desktop
test was not executed in this change.

Deployment uses a complete identified snapshot via the normal Omarchy plugin
updater, lockfile dependency installation, and an actual shell restart.
Existing npm dependencies must be moved into the backup before update because
the updater rejects their generated `.bin` symlinks during validation.

Installed on the desktop as complete local build
`3d1880182427a86da4dee34b560f9180ce8b9a5d`, origin
`~/.local/state/ask-search-build.BA83iO`, previous installation and
settings backed up at `~/.local/state/ask-search-backup.vObeYu`.
Normal update, npm ci, and shell restart completed. Installed Git status is
clean; settings compare identical, shell ping is `ok`, Ask is enabled, and
Hyprland reports no configuration errors.

After installation, a read-only query through the installed file helper
returned `~/Pictures/screenshot-2026-09-15_18-08-34.png` with
`totalMatched: 1`, `capped: false`, and `complete: true`. This verifies the
reported real-file search, not a simulated replacement or an automated
desktop test on the desktop.
