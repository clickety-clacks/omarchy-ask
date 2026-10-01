# Shared resolver Ask adapter — independent Sol review

Date: 2026-09-13

Verdict: **accepted for source-only integration**. No unresolved review finding
remains in the reviewed adapter boundary. This verdict does not approve an
installation, deployment, release, or live connection workflow.

## Reviewed boundary

The review covered Ask's shared resolver client, Hub activation adapter,
focused tests, and operator documentation at these final hashes:

- `bridge/agent-window-resolver.js` —
  `98f03cd7e83e140f04e5b6948317eb3f9c66dcada713c57dd5ab821b2c2957fe`
- `bridge/agentd-hub.js` —
  `7ccfece101f4b793a5fe363f675ec00055c735954b39a616d2ba060e8e71612d`
- `tests/agent-window-resolver.test.mjs` —
  `a138fc79100196a4bd402ab82630f89be29b213fb5d1266c48abc22e19361d8d`
- `tests/agentd-hub-bridge.test.mjs` —
  `2bf30c6b15efa5023d288e2f871030e1b494637864cf52d922c51dd932954b43`
- `tests/resolver-process-cleanup.test.mjs` —
  `de1e07b778bfccfce9a31b03efb1b1ac0ac1efb7f692894101184e4dbcfff56a`
- `tests/agentd-hub-snapshot.test.mjs` —
  `1b781825b40dd49ac94b1a71f5969b46605a2229ff43dba8e71f070cf85bc59b`
- `docs/agent-search.md` —
  `ece5bfdfff522ee3f7744bea3a268f7bf6c357a5194801f323844b2ac183cfba`

I compared the adapter against the frozen v1 schema and contract from the
shared `agent-window-resolver` source on Plumbus. I did not execute its Linux
collector or perform a live topology probe.

## Acceptance findings

- Ask invokes one version-gated shared JSON CLI and has no private agent-window
  resolver or silent fallback. Executable location, working directory, module
  path, and expected version are deployment inputs; there is no machine,
  checkout, socket, or Hub topology constant and no registration requirement.
- The client enforces one EOF-framed request and one newline-terminated response,
  request and output byte ceilings, an adapter deadline, exact schemas, status
  cardinality, proof completeness and relation, full target identity, exact
  window identity, revalidation non-substitution, and verified tmux location.
  Missing, incompatible, malformed, oversized, timed-out, and contradictory
  dependencies fail explicitly.
- Upstream safe integer ticks are normalized to canonical strings before a
  request. Wire response identities and windows require strings, so a
  nonconforming numeric tick cannot be accepted even when it is numerically
  safe in JavaScript.
- Resolver subprocesses run in an adapter-owned process group. Deadline,
  output-limit, and non-`EPIPE` stdin failures kill that group; normal close
  also removes abnormal owned descendants. Cleanup never targets a user-owned
  process group.
- Existing-window activation performs `resolve`, a fresh `revalidate`, a new
  Hyprland snapshot, exact stable-ID/address/PID uniqueness, a fresh process
  start-tick read, and an exact roster target recheck immediately before focus.
  Ambiguity, missing evidence, compositor failure, PID reuse, roster movement,
  or shared dependency failure cancels focus and does not open a replacement.
- New attachment proceeds only from a completed zero-candidate `unresolved`
  result, a reporting/present current roster source, and a successful
  `verify-target`. It rechecks the same roster target after executable discovery
  and attaches with the resolver-proved tmux socket. It never selects or
  detaches an existing client as a prelude.
- Complete Hub snapshots replace the roster. Invalid frames disconnect and
  retain last-known rows as unreachable; endpoint changes clear the old roster.
  Duplicate normalized `[machine, instanceId, pid, startTimeTicks]` activation
  identities invalidate a frame, keeping the bridge identity identical to the
  QML row identity and preventing a later duplicate row from activating the
  first one.
- Missing or incompatible resolver notices remain explicit, including failure
  between initial resolution and revalidation. Network and probe failures are
  not translated into a false `no_tmux` claim.

The remaining process inspection in `bridge/windows.js` enriches general
window-search labels. It does not match an Agentd target or authorize agent
activation, so it is not a second agent-window resolver.

## Findings found and resolved during review

1. Output-limit and deadline handling originally killed only the direct
   resolver PID, allowing an owned descendant to survive. A controlled
   reproduction confirmed the orphan. The adapter now owns and kills a
   dedicated process group; the same reproduction and a durable regression
   confirm cleanup.
2. Response validation originally accepted safe numeric `startTimeTicks`, in
   conflict with the canonical wire schema. Response identity and window
   validators now require decimal strings, with a negative regression.
3. Hub snapshots originally allowed duplicate UI activation identities. They
   are now rejected after tick normalization, with an SSE regression.
4. A resolver dependency failure during revalidation originally selected the
   generic connection notice. It now retains the explicit missing or
   incompatible dependency reason, with an activation regression.

## Verification

I ran the focused local pure suite:

```text
node --test tests/agent-window-resolver.test.mjs \
  tests/agentd-hub-bridge.test.mjs \
  tests/resolver-process-cleanup.test.mjs \
  tests/agentd-hub-snapshot.test.mjs \
  tests/search-settings.test.cjs
```

Result: **30 passed, 0 failed**. This includes controlled resolver framing and
version discovery, strict response negatives, lower caller limits, dependency
errors, attachment policy, focus freshness, duplicate SSE identity rejection,
and owned-descendant cleanup. The cleanup test and my independent reproduction
use synthetic local child processes; they do not execute the shared Linux
collector.

The owner additionally reported **44/44** combined local checks and **26/26**
controlled isolated-copy checks on Plumbus at the reviewed state. Those runs
are supporting owner evidence, not independently repeated live checks in this
review.

## Explicitly pending

This source acceptance does not establish:

- resolution and focus of a real existing Ghostty/Hyprland window through the
  shared installed collector;
- attachment correlation for a live `mosh-client` session;
- production Agentd Hub availability;
- installation, packaging, migration of a running system, deployment, or
  release behavior.

The real shared existing-window and live mosh gates remain pending with the
resolver owner. Until those pass and deployment is separately authorized, the
product must continue to be described as unreleased and not deployed.
