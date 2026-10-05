# Shared agent-window resolver migration

Status: source migration implemented and independently accepted; live desktop
acceptance pending. No release, installation, or deployment.

## Ownership and invariant

Ask and Yoohoo agreed to one shared read-only Python resolver with a versioned
JSON CLI. Neither adapter maintains an independent process/transport resolver
fallback. Normal harnesses, SSH/mosh connections, and tmux sessions require no
registration, special launcher, or harness modifications. Ask owns its Hub
stream, search, final compositor checks, notices, and attachment actions.

The accepted public boundary is `schema/v1.json` and `docs/contract-v1.md` in
the shared `agent-window-resolver` project. Host names and source/executable
locations are deployment inputs, not runtime constants.

## Shared contribution evidence

Yoohoo's owner reports passing the gated pure run on Testbed for these exact
reserved contribution hashes:

- Fixture: `55be60b85566a88aad09ef4162eb1acbe533005d4de36048becc35f5e8eb9e1d`
- Tests: `052f9e9acb1eb45002b9b5f76945ea7ef6bf9ae642fdc746155aa11b5aa41e51`
- Linux parser: `458bd46ceb250f0d9402577b88dccc128e5ea0014c1e35fbd2f65dfd0208975c`
- Matcher: `c81b6ccd0e4d4bcb3e8839d08e986928029b20e4c2aea6a658fc961995face9d`

The four functions cover eight graph cases, synthetic raw mosh UDP
parser-to-matcher matching, SSH local-socket/remote-environment fallback, and
changed-identity/wrong-endpoint negatives. Documentary fixture-shape functions
were excluded from the gate. These results do not establish live mosh,
existing-window, or full collector behavior.

The first Luna drafts contained malformed JSON, an unresolved process
reference, and later parser-binding errors. Those were test contribution
defects, not matcher findings. Sol high corrected the raw bindings; the Ask
owner read them and verified hashes before Yoohoo's independent safety gate.

## Ask verification so far

- Thirteen shared-client tests pass using controlled subprocesses: EOF framing,
  discovery, dependency failure, malformed/extra frames, contradictory exit
  status, output limits, child-only environment, tick precision, and response
  identity/relation/prior/attachment-target validation, and caller-limit
  validation/enforcement.
- Nine Ask action/helper tests pass, including the runtime activation path
  with injected dependencies: stale existing-window focus, exact revalidation,
  final PID/address/roster checks, snapshot failure, and verified attachment.
- Four existing search/settings tests pass.
- Fourteen harness/shortcut baseline tests pass. The combined run is 40/40,
  not an addition of overlapping focused runs.
- Node syntax, diff checks, and clean-copy Omarchy plugin validation pass.
- The 22 client/action tests also pass on Testbed from isolated source copy
  `/tmp/ask-shared-adapter.HF6UOp`, using only controlled subprocesses and
  injected actions. No shared Linux collector, real remote connection, or
  desktop focus was invoked by that run.

Private topology/socket/remote-probe matching code is removed from Ask; Hub
activation now calls the shared resolver. Final independent review and live
desktop/connection acceptance remain pending. Do not carry the original
private resolver's acceptance verdict forward to this replacement.

## Independent review findings (resolved)

The 40-test run above preceded additional review regressions. Independent Sol
review reproduced an owned descendant surviving direct-child termination,
found safe numeric ticks accepted in otherwise string-only wire responses,
and identified duplicate Hub identity rows sharing an activation ID. It also
found a generic notice on dependency failure during revalidation. All were
corrected and independently re-reviewed. The numeric-wire tick regression
failed before the fix and passes afterward; owned process-group cleanup now
passes both the review reproduction and a durable regression. Duplicate
normalized Hub identities are rejected atomically before publishing a frame.

Final combined local suite: **44/44 passed**, no skips. Final isolated-copy
Testbed suite: **26/26 passed** (14 client, 10 action, one snapshot, one process
cleanup). These replace the earlier overlapping counts, not add to them.
No real shared collector, desktop focus, or remote transport was invoked by
these controlled Ask tests. Independent review reports no remaining code
blocker; actual shared existing-window/live-mosh acceptance remains separate.
