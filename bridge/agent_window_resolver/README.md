# Bundled agent-window resolver

These Python source files are maintained with Yoohoo in the canonical
`agent-window-resolver` project and copied into Ask as part of its source.
Do not independently change their matching rules here; coordinate corrections
in the canonical library and synchronize both products with their tests.

Ask's Node adapter invokes this package internally using Python 3. Users do
not install a resolver executable, register harnesses, configure a library
endpoint, or arrange a special terminal launcher.

The resolver is read-only. Ask owns window focus and terminal attachment.
Canonical protocol and normalization fixtures belong to the library; Ask's
adapter tests cover JSON framing, identities, process cleanup and actions.
`tests/bundled-resolver-local.test.mjs` exercises the bundled Python collector
against the test process without focusing a window or contacting a remote host.

Current upstream limitation: roaming mosh-server sockets may expose no remote
peer. V1 requires full reversed endpoint evidence, so synthetic connected-UDP
tests must not be reported as proof for ordinary bound-server mosh sessions.
