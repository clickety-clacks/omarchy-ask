# Bundled agent-window resolver

The Python modules in this directory are a verbatim copy of the
`agent_window_resolver` package from
https://github.com/clickety-clacks/agent-window-resolver, the canonical home
it shares with Yoohoo. `VENDORED.json` beside this file records the upstream
URL, the exact commit copied, the date of the sync and the git blob id of
every copied file. `tests/vendored-resolver.test.mjs` fails if any copied
file differs from that record.

Do not edit these files here. Make corrections upstream, then re-vendor:

    scripts/sync-resolver.py REF            # branch, tag or commit upstream

The script copies the package from exactly that commit, also refreshes the
shared vectors and regression suite Ask carries under `tests/`, and rewrites
`VENDORED.json`. Review the diff and run the tests in `docs/testing.md`.

Ask's Node adapter invokes this package as
`python3 -B -S -E -m agent_window_resolver`, so no user Python environment
reaches it and users install nothing. The resolver is read-only: it observes
processes, tmux and transports; Ask owns window focus, transport choice and
terminal attachment. Every response names the library version that produced
it (`resolverVersion`); the adapter reports a copy that predates 0.2.0 as
too old.

Current upstream limitation: roaming mosh-server sockets may expose no remote
peer, and et sessions have no endpoint pair that links a window to its remote
tmux client. Both are matched from command-line hints, not exact proof.
