# Bundled resolver integration — independent Sol review

Date: 2026-09-14

Verdict: **accepted for Ask's bundled-library integration and local
existing-window path**. No unresolved Ask-owned packaging, import-isolation,
protocol-validation, subprocess-lifecycle, or local activation-test finding
remains at the reviewed hashes. This does not establish remote SSH or live mosh
attachment behavior. No installation, deployment, migration, release, or
remote live probe was performed by this review.

## Reviewed boundary

Ask carries exactly seven canonical Python source files under
`bridge/agent_window_resolver`. I compared them byte-for-byte with
`/home/mike/Projects/agent-window-resolver/agent_window_resolver` on osanwe:

- `__init__.py` —
  `eb4317c4f98a441006f7dd11e458596c8df32a5487b1ccccba5743ad69ea285b`
- `__main__.py` —
  `6d8b7d7846a845059d7a3107143f11131f63c5511d669b44085b15ec5e3d2279`
- `cli.py` —
  `93939f06aa4c826f8018640a688fefc0314965b3a661283e9b81da8258f959ac`
- `collector.py` —
  `136c632910d05b44ef09de54119eef71a828c9551501e5a912df334d3e0a5f3a`
- `linux.py` —
  `106ccd9ec3b67c6b1646bea6b08b9e65ff2c6f900f5533061aafd02b647b8883`
- `model.py` —
  `9114a89402a270131a96d32d77a25425072b63dda74412c5cd2b91de50e67c9d`
- `resolver.py` —
  `c81b6ccd0e4d4bcb3e8839d08e986928029b20e4c2aea6a658fc961995face9d`

The Ask-owned review boundary was:

- `bridge/agent-window-resolver.js` —
  `4a71d4b535b3d2676989bcfd5fb3e42f1556ede5fc8e7976f2d8ae4ed8a09c69`
- `bridge/agentd-hub.js` —
  `3bd90e25f57ed67fc1e039a928b91ecf83ebb879a6164df9d0bd299d65041dba`
- `tests/agent-window-resolver.test.mjs` —
  `8535a23be7e9f52a8f756f8a6141df306159308837880778ad541413334b65fe`
- `tests/resolver-process-cleanup.test.mjs` —
  `8db9f5e95f3311f626602272186af71efa6bd021bc68344d3966d91046dd19e1`
- `tests/agentd-hub-bridge.test.mjs` —
  `2bf30c6b15efa5023d288e2f871030e1b494637864cf52d922c51dd932954b43`
- `tests/agentd-hub-snapshot.test.mjs` —
  `1b781825b40dd49ac94b1a71f5969b46605a2229ff43dba8e71f070cf85bc59b`
- `tests/bundled-resolver-window.test.mjs` —
  `3395538715baa33575711b9a594a83757479ec556ccef40276f6be57063161d4`
- `bridge/agent_window_resolver/README.md` —
  `3293e7a31a6471e41381ada73ed046d5b45db4242f7cc835e0dbeacda0ed24a9`
- `docs/agent-search.md` —
  `e19e5e002e085ea467f143a09b2742fd2080269c702a1d4f600b0eef70b9704e`

## Acceptance findings

- The client has one fixed invocation: `python3 -B -S -E -m
  agent_window_resolver`. It computes the bundled bridge directory from its own
  module URL and uses that directory as the child working directory. There is
  no executable discovery, version handshake, resolver path setting, or
  topology/configuration constant.
- The child receives a copy of the environment with every inherited `PYTHON*`
  entry removed. `-E` independently makes Python ignore Python environment
  configuration, `-S` excludes site initialization, and `-B` prevents bytecode
  writes. The canonical package uses package-relative imports and the Python
  standard library, so these restrictions are compatible with the reviewed
  bundle.
- A hostile caller working directory cannot shadow the bundled package. The
  launch also ignores hostile `PYTHONHOME`, `PYTHONPATH`, `PYTHONSTARTUP`, and
  `PYTHONUSERBASE` values. Controlled execution selected the canonical module
  and left no `__pycache__` directory or `.pyc` file in the QML-watched tree.
- Existing EOF framing, request/output ceilings, deadlines, exact response and
  proof validation, strict wire tick strings, one-child behavior, and explicit
  dependency errors remain intact. Deadline, output-limit, non-`EPIPE` input
  failure, and normal close cleanup retain the adapter-owned process-group
  boundary; cleanup does not target user-owned processes.
- Hub activation still revalidates the resolver result, current roster target,
  process ticks, and current compositor window before focusing. Duplicate
  normalized activation identities invalidate a complete snapshot.
- The explicit desktop integration test creates one isolated Ghostty, identifies
  its exact `/usr/bin/sleep 25` descendant through a bounded per-thread proc
  walk, brackets PID identity with start ticks, and uses the compositor's real
  stable ID. It then proves resolve/revalidate and the production local
  activation path through a fresh compositor snapshot, proc checks, and focus.
  Only stable roster lookup/connectivity and result capture are synthetic; an
  unexpected new attachment fails the test.
- Cleanup signals only the directly owned Ghostty child, reaps it, identity-polls
  the finite payload to disappearance, and polls compositor unmap. The test
  explicitly says that it focuses its owned window. Its 50-second activation
  subprocess bound is above the two resolver operations' normal bounded path,
  while the 90-second outer bound leaves room for cleanup.
- The bundled provenance document makes the canonical source relationship and
  no-private-fork rule explicit. Operator documentation accurately says that
  the source is present but not installed or deployed.

The remaining process inspection in `bridge/windows.js` enriches general
window-search labels. It does not match an Agentd identity or authorize agent
activation, so it is not a duplicate resolver.

## Findings found and resolved during review

1. The first bundled launcher inherited the caller's working directory. Python
   places that directory ahead of `PYTHONPATH` for `-m`, and a controlled shadow
   package emitted a forged schema-valid response that the adapter accepted.
   The launcher now fixes the child working directory to the trusted bundled
   bridge root; the hostile-directory regression confirms that the canonical
   package wins.
2. The first launcher inherited Python runtime variables. A controlled invalid
   `PYTHONHOME` prevented Python startup, and a normal bundle invocation wrote
   bytecode into the watched source tree. The launcher now strips all `PYTHON*`
   variables and uses `-B -S -E`; the hostile-environment regression confirms
   successful canonical startup with no bytecode residue.

## Verification

I ran JavaScript syntax checks for both bridge modules and the frozen controlled
suite:

```text
node --test tests/agent-window-resolver.test.mjs \
  tests/resolver-process-cleanup.test.mjs \
  tests/agentd-hub-bridge.test.mjs \
  tests/agentd-hub-snapshot.test.mjs
```

Result: **27 passed, 0 failed**. This includes exact bundle hashes, exact fixed
arguments and working directory, environment sanitization, hostile package and
Python-configuration isolation, absence of bytecode residue, protocol and
proof negatives, activation freshness, duplicate snapshot identity rejection,
and owned-descendant cleanup.

The integration owner additionally reported **53/53** canonical pure Python
tests against the bundled package and **40/40** combined Ask checks on Plumbus.
The opt-in real desktop test passed there: an exact terminal descendant resolved
and revalidated, production local activation focused the same stable window,
and the owned child and window were absent after cleanup. Those Plumbus runs are
supporting owner evidence; I reviewed the test and performed its local syntax
check but did not repeat the live desktop execution.

## Explicitly pending

This bundled-library and local-path acceptance does not establish:

- attachment correlation for a live ordinary `mosh-client` session;
- remote SSH attachment behavior;
- production Agentd Hub availability;
- installation, deployment, migration, release, or installed-product behavior.

Ask must continue to take canonical resolver updates as byte-identical source,
not fork or weaken process/evidence handling. Remote feature and release claims
remain deferred to their separately owned live gates and deployment authority.
