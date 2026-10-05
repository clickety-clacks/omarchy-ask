# Streaming file search — final independent Sol review

Reviewer: Sol high  
Date: 2026-09-15  
Contract: `docs/architecture-file-search.md`  
Status: **static acceptance: pass; no remaining product blocker found**  
Scope: static review only. This reviewer did not run tests or deploy. Ask main
owns runtime acceptance and installation.

## Reviewed production identity

- `bridge/file-search.js` —
  `ae58003b9d3246a2d552c239354932a2d1535de2478121b43221371a816ee845`
- `bridge/file-index-worker.js` —
  `7ee76c193fa7a928ac6d0d68355952ebfc19bb2849fb30f0f456be0538233192`
- `bridge/files.js` —
  `ee76f2fd411b9461b383a58c4d8e741003979d5fc14c1a07fd2499bc91478071`
- `Conversation.qml` —
  `fb276f2affce2e97f6a8c1fa569b66ac9a6a2b96781f51a2b293dde6958ccb92`
- `MenuSearch.qml` —
  `e720b14f67bbdddf3f9e87989b8542a08ceaadee1390a767dd536ec16ece3fb2`

## Requirement-by-requirement verdict

### R1 — Local results do not wait for stalled or warming sources: pass

- The coordinator publishes an initial snapshot immediately and starts the
  asynchronous request afterward (`bridge/file-search.js:746-766`).
- Global scheduling reserves independent local and mounted lanes: two local,
  four mounted, six total. A canceled but unexited mounted process continues to
  consume only its mounted lane; it cannot create a whole-generation reap
  barrier in front of a new local scan (`bridge/file-search.js:714-720`,
  `821-845`, `895-913`).
- Live `fd` traversal is independent of optional FFF/plocate workers. FFF can
  spend up to 30 seconds becoming ready without delaying live publication; its
  query budget is two seconds. Plocate has a coordinator-side 1.2-second bound,
  including a worker event loop blocked in synchronous validation
  (`bridge/file-search.js:485-694`, `732-744`).
- Repository scans are partition jobs rather than a serial post-pass and use
  base-relative depth accounting (`bridge/file-search.js:797-805`).

### R2 — Retain valid partial results and report terminal truth: pass

- `StreamSource` parses NUL-delimited records incrementally across chunks,
  preserves complete records, discards an overlong record through its next NUL,
  rejects a trailing fragment, and separately enforces record, stdout, stderr,
  and 15-second time limits (`bridge/file-search.js:189-307`).
- Timeout, output failure, nonzero exit, missing stdio, and cancellation are not
  mislabeled as result caps. Complete records accepted before those outcomes
  remain in the aggregate (`bridge/file-search.js:205-307`, `914-934`).
- Snapshot completeness combines mount-plan truth, source failures, source
  exhaustion, and focused fuzzy availability. `capped` is asserted only by
  observed omitted evidence or a displayed-result cut, not by timeout/failure
  (`bridge/file-search.js:982-1002`).
- Both file and repository results are full replacement snapshots; one source
  finishing cannot erase another source's partial findings.

### R3 — Replacement is leak-free and process use remains bounded: pass

- Every request receives an internal monotonically increasing generation and
  all source, helper, accelerator, timer, and publication callbacks validate
  request/token identity before mutation (`bridge/file-search.js:746-766`,
  `861-880`, `936-980`). Reused public IDs therefore do not admit stale work.
- Traversal children are detached owned process groups, receive TERM then KILL
  after 250 ms, and release a global lane only on terminal close
  (`bridge/file-search.js:156-162`, `189-307`, `895-913`).
- Root and mount-metadata helpers distinguish the bounded query-facing result
  from actual child reaping. Their four-slot capacity is held until `close`,
  query replacement cancels the generation's helpers, and shutdown keeps their
  reap promises (`bridge/file-search.js:395-469`, `707-713`, `1007-1041`).
- Each optional-worker spawn owns a fresh lifecycle promise. Readiness,
  replacement, spawn/stdio failures, exponential retry backoff, stdout limits,
  TERM/KILL, and shutdown are all explicit (`bridge/file-search.js:485-694`).
- The isolated plocate worker permits one active child and one latest pending
  query, keeps the child in the worker's process group, and owns termination
  and reaping (`bridge/file-index-worker.js:90-206`). FFF native calls and
  plocate `stat` validation cannot block the bridge process.

### R4 — Scope, ordering, metadata, and activation remain correct: pass

- The configured root is canonicalized by a 1.2-second isolated
  `realpath -z -e` helper. Parsing requires exactly one final NUL, preserving
  legitimate whitespace and newline bytes. Failed canonicalization falls back
  conservatively to one-filesystem traversal and incomplete metadata
  (`bridge/file-search.js:478-483`, `769-793`).
- Mountinfo parsing is bounded to 4 MiB, decodes kernel escapes, uses path-
  component containment, deduplicates stacked mountpoints, schedules at most
  255 mounted partitions, and prunes *all* discovered child mountpoints even
  beyond that scheduling cap (`bridge/file-search.js:29-149`, `471-475`).
- Live file traversal uses an absolute expression anchored after the canonical
  scope and searches the longest literal term only as a candidate superset.
  Every live record is then checked for all query terms in any order against
  its scope-relative path, preventing root-name false positives without losing
  reversed-term matches (`bridge/file-search.js:84-99`, `164-187`,
  `347-356`, `861-880`). FFF/plocate filtering and ranking use the same
  canonical scope.
- Repository discovery accepts `.git` files and directories, filters candidate
  repository paths against the query, excludes cache/vendor trees, and applies
  the configured depth relative to the common root (`bridge/file-search.js:
  164-187`, `797-805`, `861-880`). Settings input is capped at 64 KiB; invalid
  depth defaults to six and explicit nonpositive depth is unlimited
  (`bridge/file-search.js:364-385`).
- Aggregation deduplicates by canonical absolute path, keeps bounded evidence,
  replaces worse candidates deterministically, and sorts by the specified
  filename-literal, path-literal, fuzzy, and lexical tuple
  (`bridge/file-search.js:309-356`, `882-893`, `982-1002`). Counts are observed
  distinct lower bounds and cap/completeness fields remain honest.
- The menu treats exactly one known, uncapped file as a direct singleton even
  while another partition is incomplete (`MenuSearch.qml:444-450`).
  `Conversation.qml` tracks selection by stable identity, remaps after each
  replacement snapshot, clears a removed target, uses a monotonic same-query
  removal latch, and initializes focused browsing at index `-1` so a stale row
  from the prior query cannot become the new target (`Conversation.qml:86-185`,
  `975-989`). Activation and preview read the remapped selected row rather than
  retaining a stale numeric index.

## Runtime evidence owned by Ask main

Ask main reports a fresh npm-install stage at
`/tmp/ask-streaming-final.6pJUGT` against the exact production hashes above:

- broad suite: **117 passed, 0 failed, 5 intentional skips (122 total)** in
  13.6 seconds on the test machine;
- the buffered negative control passed;
- canonical-root-prefix and no-index reversed multi-term regressions passed;
- two separate real Conversation UI gates passed against
  `Conversation.qml` `fb276f2a…`, including the repeated-empty removal latch,
  singleton transitions, previews, and real agent/window target remapping; and
- fixture cleanup reported no remaining clients or fixture processes.

This evidence is recorded here for traceability, but it was not executed by
this reviewer.

## Final disposition

No static architecture or product blocker remains on the identified hashes.
The implementation satisfies the contract's four top-level requirements,
including mount-partition isolation, blocking native/stat isolation, canonical
scope, generation/process bounds, truthful counts/completeness, deterministic
bounded ranking, and stable UI target selection.

Ask main may proceed from the static-review gate to its normal installation,
restart, and installed-identity verification. This review does not itself claim
that deployment has occurred.
