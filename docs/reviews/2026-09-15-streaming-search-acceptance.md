# Whole-scope streaming search acceptance

Owner: Ask main. Status: **accepted and installed on the desktop**.

Contract: [architecture-file-search.md](../architecture-file-search.md).
Independent static review: [Sol review](2026-09-15-streaming-search-sol-review.md).
Runtime regression tests run on the test machine only. The resolver library is unchanged.

## Original failure

Read-only diagnosis found the requested screenshot in fd stdout, but the
whole-home traversal reached an rclone-mounted subtree and exceeded its
15-second deadline. Excluding that subtree made the same search finish in
66 ms. The initial installed mitigation retained completed records and added
Pictures priority; it did not solve source isolation. This work replaces the
buffered, source-gated architecture without excluding mounted scope.

## Parent-owned checks

`tests/search-streaming-acceptance.test.mjs` exercises the production
coordinator and stream reader, not a replacement search algorithm:

- Actual fd in an arbitrary local directory publishes within one second while
  injected mounted-source children remain alive; later mounted file and repo
  matches join that snapshot. The mounted-source fixture is synthetic, not a
  claim of testing a real failing network mount.
- Actual fd exclusions are checked with a glob-sensitive mounted path.
  Nested/same-device mounts, component boundaries, escapes, stacked mount
  deduplication, excluded directories, incomplete metadata and scheduling caps
  are covered. Omitted mounted jobs remain pruned from local traversal.
- A real symlink root ending in a newline preserves its canonical path, and
  new queries refresh the injected mount topology. Repository depth remains
  relative to the original root; `.git` files and directories are supported.
- Actual children exercise split NUL records, newline filenames, trailing
  fragments, nonzero exits, output limits, missing executables, timeouts and
  TERM-to-KILL cleanup. Complete records survive failed sources.
- Reused public query IDs cannot admit superseded results. Simulated
  unexited children retain their global scan/helper slots while fresh local
  work continues; these tests do not create real unkillable kernel processes.
- Late better matches replace earlier retained matches; reversed delivery
  orders agree. Stale nonempty index results do not suppress fresh traversal,
  and ordinary queries reject unrelated index hits. Index/live duplicates
  count once, and limits do not invent exact totals.
- A real cold native FFF worker answers a focused fuzzy query. Separate
  TERM-ignoring worker fixtures check local responsiveness and owned shutdown.
- The preserved pre-change fallback is a negative control: it already has a
  path in stdout at 600 ms but does not deliver it until its timeout.
- Protocol EOF is required to shut down the real bridge and its owned scans;
  backup fixture cleanup is not counted as product cleanup success.

`tests/streaming-selection.test.cjs` uses actual Conversation/MenuSearch and
the real text-preview helper, with controlled protocol snapshots and isolated
fake ACP. It checks singleton/aggregate transitions, file preview identity,
production agent/window result rebuilding, actual agent activation dispatch,
focused browser reordering/removal, and no selection resurrection on a later
snapshot. It does not send model prompts or activate the user's agents.

## Final evidence and delivery

Final runtime stage: `/tmp/ask-streaming-final.6pJUGT` on the test machine, with fresh
`npm ci --no-audit --no-fund` from the lockfile (136 packages). The parent ran:

```sh
ASK_BUFFERED_BASELINE=/tmp/ask-streaming-acceptance.fG3Vem/baseline/files.js \
  ASK_RUNTIME_HOST=test-machine node --test tests/*.test.mjs tests/*.test.cjs bridge/image-paste.test.js
```

Result: **117 passed, 0 failed, 5 opt-in skips**, 122 total, on the final
`ae58003b` coordinator. The old-buffered negative control was enabled and passed.
The skipped tests were two preview fixtures, two unrelated resolver desktop
fixtures, and the native shortcut ABI opt-in. Both preview fixtures were also
run separately on the reserved actual Wayland desktop, sequentially, and
**2/2 passed** against the unchanged final `fb276f2a` Conversation. This includes
the repeated-complete-empty selection-latch regression. After cleanup,
Hyprland returned `clients=[]` and the fixture preview/index processes were
absent. Desktop ownership was released to Yoohoo.

The final review also produced real fixes, not only test-count evidence:
scope-root names no longer make every file match; live matching accepts literal
query terms in any order; short unsupported queries terminate; removed
selection does not resurrect; and helper timeouts cannot release live child
slots. A preview fixture initially allowed unrelated live search replies to
overwrite injected rows; its source IO was isolated without replacing the real
preview helper or weakening its visible-content/geometry checks.

Frozen production SHA256:

| File | SHA256 |
| --- | --- |
| `bridge/files.js` | `ee76f2fd411b9461b383a58c4d8e741003979d5fc14c1a07fd2499bc91478071` |
| `bridge/file-search.js` | `ae58003b9d3246a2d552c239354932a2d1535de2478121b43221371a816ee845` |
| `bridge/file-index-worker.js` | `7ee76c193fa7a928ac6d0d68355952ebfc19bb2849fb30f0f456be0538233192` |
| `Conversation.qml` | `fb276f2affce2e97f6a8c1fa569b66ac9a6a2b96781f51a2b293dde6958ccb92` |
| `MenuSearch.qml` | `e720b14f67bbdddf3f9e87989b8542a08ceaadee1390a767dd536ec16ece3fb2` |

Independent Sol high final review passed on the five exact hashes above: all
four product requirements accepted, no remaining concrete production blocker.

Delivery uses a complete source snapshot at
`~/.local/state/ask-streaming-build.GFO81W`, based on the previously
installed commit, through `omarchy plugin update clickety-clacks.ask --yes`,
then `npm ci` and `omarchy restart shell`. Pre-update plugin and settings are
backed up at `~/.local/state/ask-streaming-backup.3GySnn`.
Installed commit: `68a6d08cd1537036270ecadfe230a6eb17622758`. Normal full plugin
update and fresh npm dependency installation succeeded, followed by an actual
shell restart at 8:01 PM PT on September 15. Every installer-managed tracked
file matches the immutable build snapshot; the installed git worktree is
clean. Both `ask.json` and `shell.json` are byte-identical to their backups.
The new shell (PID 2154309) reports `ok`, Ask is enabled, Hyprland reports no
configuration errors, and the new process's startup log has no Ask/QML errors.
No runtime regressions were executed on the desktop. A post-install receipt is at
`~/.local/state/ask-streaming-install-68a6d08.json`; this delivery note
was added to the development checkout after the immutable build was created.
