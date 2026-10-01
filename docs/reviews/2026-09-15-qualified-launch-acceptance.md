# Qualified launch/repeat acceptance on Plumbus

The corrected maintained resolver passes the launch-and-repeat regression.
No osanwe tests, installation, or restart occurred during this validation.

## Product behavior observed

Both final live runs on Plumbus completed with exit 0:

| Transport | Initial terminal launches | tmux attachments | Repeated selections | New launches on repeats | Cleanup |
| --- | --- | --- | --- | --- | --- |
| Private loopback SSH | 1 | 1 | 2 existing-window/workspace focuses | 0 | Verified |
| Native loopback mosh (`--local`) | 1 | 1 | 2 existing-window/workspace focuses | 0 | Verified |

Production Ask activation supplied the actual terminal/attachment command;
the parent fixture launched it with isolation options, then production
activation ran again using real LinuxCollector observations and real focus
dispatch. Terminal PID/start/stable-ID/address, tmux client identity/count,
and (for mosh) server PID/start/UDP port/inode stayed unchanged across repeats.
The actual window title stayed generic, and both match passes explicitly
supported the transport host/session hint. No pre-created bare-session window
was substituted for Ask's launch output. Native mosh produced its actual
client display argv, not a hand-written display fixture.

Final read-only inventory: Hypr clients `[]`, no Ghostty/mosh-client/mosh-server
test processes and no private SSH/tmux servers. Earlier failed-run roots were
retained as diagnostics after their owned processes were separately recovered;
details and tracebacks are in `2026-09-15-launch-roundtrip-pending.md`.

## Negative control and replay

Eight replay cases passed: SSH/mosh × name/path sockets × distinct/equal
display/session names. Comparable window/pane/socket conflicts cannot regain
support through transport or generic raw-argv name hints; independent current
title evidence stays eligible.

Plain random session names and unrelated random agent display names prevent
alias/name fallback from masking the defect. With the pre-fix collector
`42db2f45` and resolver `24174377`, both SSH/path/distinct and
mosh/path/distinct fail on an attempted second terminal launch. With the
corrected maintained source, the same cases pass. This supersedes the initial
four-case replay, whose parenthesized/equal names masked the positive case.
The 33 existing Node adapter/client checks also passed on Plumbus.

## Reviewed and executed source

- Canonical/bundled collector: `06f510e61e598b4378effeb7198b22d5d310e428dbf42396849e5b0c0cb860cc`
- Canonical/bundled resolver: `0be324ff3bf9052182c7114b5976a0e6e3ab4696942b6f123da934b1268b65bb`
- Live fixture: `35a728273d9bf45e5c67818d4b3f612db9972963ef7afeff434f929814200c9a`
- Replay: `1cfc3241fa46006a40df0ba00678c43171bc35f9f56330e42837d7e42f25ddd5`
- Replay helper: `6575ce2f84dd5fd386bdd79f6f064c28cc59c8d644371df8b96df44431b72aac`

Independent Sol high static review covered the live fixture and its cleanup
corrections before the corresponding runs. All tests ran in the isolated
Plumbus stage `/tmp/ask-qualified-roundtrip.hO7xDw`. Negative controls ran in
`/tmp/ask-qualified-baseline.ahzHt7`. Production modules remained frozen during
fixture corrections. Other five bundled modules match canonical unchanged.

## Scope limits and reproduction

The roster is synthetic and attachment preflight uses the private fixture's
observed PID/start/session/window/pane. This is not a popup mouse-click test,
real harness-account validation, or the original osanwe agent selection.
Mosh is native but uses loopback-only `--local` bootstrap: it does not test
remote SSH bootstrap or network roaming. The SSH case separately uses real
private loopback SSH. No real user's session or default tmux socket is touched.

On an authorized empty Plumbus desktop, provide its current verified Hyprland
and Wayland environment, then run from the staged repository:

```sh
node --test tests/agent-launch-roundtrip.test.mjs
ASK_LAUNCH_REPEAT_LIVE=1 YOOHOO_LIVE_TEST_HOST=1 \
ASK_CONNECTION_SUPPORT=/path/to/reviewed/yoohoo/tests/integration \
ASK_LIVE_TRANSPORT=mosh python3 -B tests/agent-launch-roundtrip-live.py
ASK_LAUNCH_REPEAT_LIVE=1 YOOHOO_LIVE_TEST_HOST=1 \
ASK_CONNECTION_SUPPORT=/path/to/reviewed/yoohoo/tests/integration \
ASK_LIVE_TRANSPORT=ssh python3 -B tests/agent-launch-roundtrip-live.py
```

Future deployment must install one complete identified Ask build through its
installation workflow and restart the shell, not patch individual installed
modules or installation-record hashes. The qualified-target correction is
was source-only at completion of the runtime gates.

## Subsequent complete installation on osanwe

Installed complete local build `b0ec28731d0e109ed825e31d59f0806b7f38a160`
through `omarchy plugin update clickety-clacks.ask --yes`, followed by
`npm ci --prefix <installed-plugin>/bridge --no-audit --no-fund` and
`omarchy restart shell`. This is an unreleased local build, not a release cut.
Build origin: `/home/mike/.local/state/ask-qualified-build.lqegQ4`.
Previous complete installation and settings backup:
`/home/mike/.local/state/ask-qualified-backup.q9Ul6e`.

The initial standard update rolled back because plugin validation rejected
existing npm `.bin` symlinks. Moved that dependency directory into the backup,
reran the same standard updater successfully, then rebuilt dependencies from
the lockfile. No selective installed source/helper edits were used.

Post-install read-only checks confirmed clean installed Git status at the
build commit, all seven resolver modules identical to canonical, unchanged
`ask.json` and `shell.json`, shell ping `ok`, Ask enabled, the Hub bridge running
from the installed plugin, and no Hyprland configuration errors. No automated
agent activation tests ran on osanwe; actual user selection there remains the
user-facing confirmation. Plumbus desktop was released after verified cleanup.
