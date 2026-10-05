# Non-blocking, whole-scope file search

Owner: Ask main. Initial implementation: Luna xhigh; lifecycle completion: Sol
high under Mike's permission to escalate coding when needed. Independent
review: a separate Sol high reviewer.
This is the implementation contract and acceptance checklist, not a claim of
completion. Runtime tests belong on Testbed; preserve the existing worktree.

## Problem and product contract

A fresh local screenshot was found during a whole-home `fd` traversal, but
the traversal also entered an rclone mount. It exceeded 15 seconds; buffered
results were discarded. Excluding the mount finished the same search in
66 ms. Adding Pictures to a preferred-folder list treats that one case, not
the architecture. Existing `Promise.all`, synchronous filesystem validation,
and native indexing in the protocol process are additional blocking paths.

The search scope stays the configured ASK_FILE_ROOT (home by default),
including mounted subtrees. Do not solve this by dropping network files,
hardcoding a mount name, requiring registration, adding a daemon, or adding
user setup. No new visible controls/error panels are needed.

1. Local results must reach the UI while any other source is still running,
   warming, stalled, or failing. Finding anything in an index or preferred
   folder must not prevent other in-scope sources from contributing.
2. Every valid result already received survives other-source failure or timeout.
   Timeouts bound resource use, not delivery latency or validity of findings.
3. Query replacement cancels superseded work; no old-query result, completion,
   or queued callback may affect the new query, even if request IDs are reused.
4. Results retain path identity, deterministic ranking, bounded output and
   memory, and truthful completion/count metadata. An unavailable source is
   not an exhaustive empty search. Keep singleton behavior and direct actions.

## Architecture

### Coordinator (`bridge/files.js`, small supporting modules as appropriate)

One JSON-lines coordinator owns query generations, cancellation, source state,
deduplication, ranking, and publication. Its event loop does not synchronously
stat/readdir/realpath user filesystem paths or call native FileFinder. Reading
bounded local configuration and `/proc/self/mountinfo` is separate from crawling
user/mounted data. Native initialization/search and potentially blocking path
validation run in owned subprocesses, never this coordinator's JS thread.

Use the existing Node/fd/FFF dependencies; no separately installed resolver,
search service, database, or new user configuration. Keep optional index work
reusable over the bridge lifetime rather than creating a home index per keypress.
An unresponsive optional worker cannot block fresh scans or protocol input.

### Source planning and isolation

Read Linux mount metadata, decode its escaped paths, and create non-overlapping
scan partitions: the base filesystem subtree and each mounted subtree inside
the configured root. If the configured root itself lies within a mount, it
still gets its own base scan. Every partition prunes descendant mount roots,
including same-device bind mounts; do not rely only on device IDs. No realpath
or traversal of a mount is required to discover it. Bound metadata input and
refresh the plan on new searches (a short bounded cache is acceptable).

Root symlinks must be resolved in an isolated bounded helper, not on the
coordinator thread; preserve configured-root presentation where practical while
using a consistent canonical scope for mount partitioning. On unresolved root
or mount metadata, any conservative live scan uses `--one-file-system` and
retains incomplete status. Mount topology is a per-query snapshot: refresh on
the next query, and if topology is detected to change during a query do not
claim the old snapshot exhaustively covers the new topology. Component-boundary
containment, escaped mountinfo paths and stacked mountpoint dedup are required.

Honor existing `.cache`/`node_modules` exclusions and default symlink policy;
do not create an extra mount job for a subtree intentionally excluded by that
policy. Escape literal mount paths when producing fd glob exclusions. Missing
or malformed discovery data must be represented as incomplete scope, not a
confident whole-home result. A conservative isolated fallback may still search.

Run local and mounted partitions independently. Give the base/local source
reserved execution capacity so queued or hung mounted sources cannot occupy
all slots. Bound concurrent external-source processes and pending jobs; retain
incompleteness for work not performed. A mounted result should still arrive
when it is available, even after local matches have been published.

Initial resource ceilings (internal constants, injectable lower values in tests):
two local scan slots, four mounted scan slots, at most two optional accelerator
workers, 256 discovered partitions/512 queued file+repo scan jobs, mountinfo
4 MiB, records 64 KiB, each child stdout 2 MiB and retained stderr 64 KiB.
Use at most two fd threads per scan. Live scan budget 15 seconds per started
source; TERM then KILL after 250 ms, bounded reap observation. Index startup
may run up to 30 seconds but emits no blocking dependency; query execution
has a 2-second budget. Retry failed optional workers with bounded backoff, not
per keystroke. Root resolution/locate validation budget at most 1.2 seconds.
Do not count deadline expiry as child exit; do not oversubscribe a slot whose
old process still has not exited. If a limit prevents coverage, mark incomplete.
Use owned process groups when a worker can spawn descendants; never signal an
unrelated process. Adjust constants only with documented rationale/review.

Optional FFF and plocate are accelerators, not gates or authoritative proof of
scope completeness. Run them concurrently with fresh traversal. FFF preserves
existing focused fuzzy search and literal filtering for ordinary searches.
Neither a stale positive index hit nor a warming index suppresses a fresh file.
Isolate plocate result validation from the coordinator; slow stat of one mounted
path must not delay local fd results. Bound worker lifetime/output and ensure
bridge shutdown owns/reaps its subprocesses.

Repository discovery has the same independence and retained-results rules:
stream `.git` directories/files from partitions, honor repoSearchDepth relative
to the original base (not restarted at each mount), and publish repo updates
without making files wait. Background cached repository knowledge is allowed;
retries must not erase findings merely because another partition failed.

### Real streaming, not staged buffered delivery

Consume subprocess stdout as it arrives (`spawn`, not completion-buffered
`execFile` for traversals). Use NUL-delimited fd records so names containing
newlines remain whole paths. Handle chunk boundaries, bounded record sizes,
bounded stdout/stderr, and incomplete final records. Preserve validated complete
records on nonzero exit/timeout; never accept a truncated path. A short flush
coalescing interval (at most 50 ms) is fine; no synthetic 1/5/10/etc. delays after
an entire source completes. Child cleanup/timeout escalation is identity-owned,
bounded, and does not block publishing already collected results.

Each source reports rows incrementally and terminal state independently:
running, exhausted, capped, failed/timed-out, or canceled. A query owns its own
opaque generation in addition to the public id. Abort queued jobs and active
query-specific children on replacement; reusable workers correlate replies to
the generation. Reject late callbacks before updating aggregates or publishing.

### Aggregation / existing UI wire contract

Continue emitting full snapshots with the existing id/query/basePath/rows,
totalMatched/capped/complete and repoOnly/repos/repo* fields. Snapshots union
findings by absolute lexical path within scope; do not synchronously realpath
or stat every candidate in the coordinator. Files sort by modification time,
newest first, in both mixed and focused search. A per-partition streaming worker
adds timestamps before bounded candidate retention; optional index workers
include timestamps from their existing validation. Unknown times sort last.
Equal times use relevance then stable path order. Repositories retain their
relevance ordering. Rank deterministically,
keeping at most the display limit plus bounded evidence that more exist.
Do not repeatedly reset to one row when another source contributes.
Keep the best bounded candidates as later records arrive rather than freezing
the first arrivals. Same observed candidate set must yield the same ranking
regardless of source delivery order. Report only observed distinct counts (or
a saturated lower bound), never extrapolated exact totals. `capped` requires
positive evidence of at least one omitted distinct match, not merely 100 rows.

A bucket with one currently known match should show that item directly even
while other sources are pending/incomplete. This does not claim exhaustiveness:
the protocol retains `complete: false`; if a second match arrives the bucket
summary appears. Keep summaries when a larger known count or cap exists. A slow
mount must not indirectly defeat Mike's direct-singleton requirement forever.

`complete` means all relevant coverage scans exhausted successfully (or the
result limit was explicitly reached and `capped` is truthful); optional stale
index success cannot establish completeness. A timed-out source with partial
results stays incomplete. Retain running/incomplete status in the search
metadata, but omit its ellipsis from count labels; a `+` still marks a capped
count. Preserve the user's twenty-result bucket balancing.
Explicit focused fuzzy searches must not claim exhaustive fuzzy coverage if
the fuzzy index is unavailable or truncated after filtering.

Streaming can reorder rows. Preserve a highlighted item's stable identity
across same-query updates so Return/preview cannot silently switch targets.
Clear/reset selection appropriately on a new query or removal of that item.
Do not change selection just because a bucket summary became a singleton or
vice versa. Implement only the narrow UI changes needed for that invariant.

## Required acceptance evidence

Tests must exercise production modules/protocol and include adversarial source
ordering, not a private replacement algorithm. Inject IO/process boundaries
for deterministic cases; also run real fd/native bridge integration on Testbed.

- A stalled mount contributes no EOF, while a local file arrives and is emitted
  within 1 second in the isolated fixture, before the mount deadline/termination.
  Include a fresh file under an arbitrary directory, not only Pictures.
- A later mounted match joins earlier local results; it is not skipped after
  an index/local hit. A stalled stat/index worker similarly cannot delay local
  results or query cancellation.
- Timeout/nonzero exit preserves complete records; chunk-split NUL records,
  newline filenames, trailing fragments, output overflow, and missing fd are
  handled without fabricated paths or false completeness.
- Duplicate index/live paths dedupe; stale nonempty index plus a fresh file
  still returns both real matches. Ranking is deterministic across delivery
  orders and output remains bounded.
- Replacing queries (including reused public IDs) suppresses old rows and old
  completion, cancels queued jobs/children, and cannot leak worker processes.
- Mount planning covers nested/escaped/same-device mounts, root-on-mount,
  excluded paths, unavailable metadata, mount changes and configured root
  containment. Verify actual fd exclusion behavior, not just generated strings.
- Repository findings stream independently; slow mounted repo scan cannot
  delay files or erase other repos; depth is base-relative across partitions.
- QML receives multiple same-query snapshots, keeps selected file/agent/window
  identity and preview/action aligned, handles singleton transitions, and
  preserves aggregate order/balancing. Existing search/settings/preview tests
  remain passing (desktop tests on Testbed only).
- Real production bridge with native index and fresh local files passes; retain
  a negative control showing old buffered behavior fails the latency gate.
- Sol high reviews the actual patch against each numbered product requirement
  and the above gates; main resolves findings and verifies runtime evidence.
- Deliver the complete identified build through normal Omarchy installation,
  preserve settings, restart the actual shell, and verify installed identity.
  No piecemeal installed-file patches. Runtime regression tests remain Testbed
  only; lumen post-install inspection is limited to read-only health/diagnosis.

Do not count passing tests alone as completion if a required source remains
serialized, mounted scope is silently omitted, or the installed build is stale.
