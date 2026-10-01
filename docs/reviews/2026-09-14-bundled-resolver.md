# Bundled resolver integration

Ask now includes the canonical seven-file Python library in
`bridge/agent_window_resolver`. All files match the recovered canonical source
byte-for-byte, including collector `09eb1477`, Linux collector `3665b8ae`,
and matcher `7f66f98b` (desktop-scan handoff; supersedes earlier cores below).
The internal Node adapter invokes the bundled module with Python 3. External
resolver installation, command configuration and version discovery were
removed. Earlier external-dependency documentation is historical only.

Plumbus verification used an isolated copy at
`/tmp/ask-bundled-library.x7JPAb`, not an installed plugin:

- 27 controlled Node adapter tests passed, including trusted working directory,
  hostile Python environment isolation, and disabled bytecode output.
- 50 canonical pure Python tests passed against Ask's bundled package.
- A real local-process resolve/revalidate test failed at the initial resolve:
  the target ancestry walk encountered an unreadable `/proc/<pid>/fd` entry
  and returned `target_process_unreadable`. It did not focus or attach anything.
  This failure has been sent to the canonical library owner for correction;
  Ask has not forked the implementation or weakened matching checks.

The canonical owner's reviewed direct-local ancestry correction (`4e3220b4`)
has now been copied into Ask. A subsequent real-process run on Plumbus using
that correction still failed: `local_process_unreadable` for a disappearing
`/proc/<pid>/fd/3`, returning `unresolved` rather than `matched`. This is a
remaining collector issue, not a passing integration test. Ask's independent
packaging review accepted its adapter boundary; full integration remains open.

After synchronizing that correction into Ask's Plumbus test copy, the combined
run passed 27 controlled tests and failed the one real-process test with the
same disappearing descriptor error. Locally, the expanded adapter, search,
settings, system-harness and shortcut regression suite passed 45/45. These
controlled passes do not override the failing runtime test.

The first pure-suite invocation used a differently named test directory and
failed a `tests.test_linux` import. Restoring the canonical `tests` package
layout resolved this fixture-layout issue; the subsequent 50-test run passed.

The canonical library also documents its live roaming-mosh bound-socket
limitation in `docs/mosh-bound-evidence-v2.md`. Synthetic full UDP tuples do not
prove that case works. Integration acceptance remains open pending the real
existing-window and live mosh gates; no osanwe installation was performed.

## Corrected core handoff

The canonical owner handed off Linux collector `106ccd9e` after 53 core tests
and the real Ask-process test passed on Plumbus. Ask copied that source without
independent changes and updated its hash-parity regression. In Ask's own isolated
Plumbus copy, the combined suite now passes **40/40**, including actual bundled
Python resolve, revalidate, wrong-start-time rejection, controlled actions,
search/settings, and shortcut policy. The earlier local collector failures above
are resolved. This does not constitute a real compositor-window or live mosh
acceptance result.

## Actual local window

The opt-in `tests/bundled-resolver-window.test.mjs` passed 1/1 on Plumbus
against the bundled `106ccd9e` collector. It created one independent Ghostty,
obtained its real Hyprland address/PID, resolved and revalidated that terminal
process, checked fresh compositor identity and process ticks, and closed its
owned terminal. A subsequent clients query returned the original empty list.
This proves direct local window identity only: the target was the terminal
itself, not a harness descendant or an SSH/mosh/tmux session. Those transport
gates remain open.

The strengthened test subsequently passed on Plumbus with an exact sleep
descendant as target and the actual Hyprland stableId. It also invoked Ask's
production `activate` with only a synthetic roster and captured notices/output:
real bundled resolution, fresh compositor/proc checks, and focus returned
`existing: true`; the active window's stableId matched. No attachment was
allowed. Captured child identity disappeared and the desktop returned to an
empty client list. This is local activation evidence, not remote transport or
cross-workspace focus coverage.

## Library-integration acceptance

The library-bundling goal is verified: canonical seven-file parity, no external
resolver install/discovery/configuration, 53 canonical core tests against Ask's
bundle on Plumbus, 40 combined Ask tests there, and the reviewed real local
descendant/activation test all pass. The final activation rerun passed after
raising its wrapper/outer timeouts to preserve bounded resolver cleanup.
Independent Sol review accepts this evidence for library integration. Clean-copy
`omarchy plugin validate` and `git diff --check` pass.

This is not full remote-feature or release acceptance. Yoohoo confirmed ownership
of the unimplemented roaming-mosh gap and explicitly deferred it from bundling.
Real remote-window/SSH/mosh and cross-workspace coverage remain unclaimed.
No osanwe installation, release, or separate library installation occurred.

## Final handoff supersedes earlier core

After Yoohoo's explicit final acceptance, Ask synchronized all seven canonical
modules, including the exact-pane boundary correction in collector/Linux/matcher.
Ask's own isolated Plumbus rerun passed **55 core tests**, **40 Ask tests**, and
the real descendant/window/production-activation test **1/1**. The first window
run hit a cleanup-fixture error because an exited process returned ESRCH rather
than ENOENT; accepting both process-disappearance errors fixed that assertion,
and the rerun passed. Post-run Hyprland clients were empty. No product matching
check was weakened. The earlier core acceptance is superseded by these hashes
and results; roaming-mosh and Ghostty-over-SSH remain outside this evidence.

## Desktop-scan correction handoff

Synchronized all seven canonical modules after Yoohoo's accepted desktop-scan
fix. Hash regression now pins collector `09eb1477`, Linux `3665b8ae`, and matcher
`7f66f98b`. Tests ran on Plumbus only: 68 canonical core tests, 40 Ask tests,
and the actual owned-window descendant/activation test (1/1) passed. No local
tests or installed-plugin changes were made for this handoff. The correction
limits socket collection to shared matcher-eligible transports while retaining
identity/argument/children checks, handles only proven non-root zombie leaves,
and raises the bounded descriptor-link length. It does not add roaming-mosh
support or establish Ghostty-over-SSH coverage.
