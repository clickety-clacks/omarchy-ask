# Launch-to-match regression preparation

Final status: the corrected replay and both final live transport gates have
now passed on Testbed, including owned cleanup. See
[final acceptance](2026-09-15-qualified-launch-acceptance.md). The chronological
pending/failure notes below are retained as the audit trail, not current status.

Status: source-only draft, not executed or accepted. Requires Yoohoo's
reviewed qualified-target correction and test-machine authorization.

## Testbed replay checkpoint

The updated replay `1cfc3241fa46006a40df0ba00678c43171bc35f9f56330e42837d7e42f25ddd5`
passed all eight cases in `/tmp/ask-qualified-roundtrip.hO7xDw` on Testbed.
The helper remains `6575ce2f84dd5fd386bdd79f6f064c28cc59c8d644371df8b96df44431b72aac`.
This supersedes the initial unrun status for the pure replay only.

Yoohoo's negative control identified that the original parenthesized session
and equal display name masked the duplicate-launch bug through alias/name
fallback. The replay now includes plain random session names with distinct
random agent display names, while retaining equal-name conflict cases.
Independent pre-fix checks in `/tmp/ask-qualified-baseline.ahzHt7` on Testbed
use collector `42db2f45` and resolver `24174377`; both SSH/path/distinct and
mosh/path/distinct fail on an attempted second terminal launch, before the
conflict assertions. The corrected package passes those same cases.

Live SSH source `tests/agent-launch-roundtrip-live.py` is under static safety
review, not executed yet. It likewise avoids matching display/session names.
Live mosh launch/repeat remains outstanding. No lumen tests or deployment.

## First live SSH attempt: cleanup failure, not accepted

The reviewed live fixture `38fbeafc4ce366af16bac6e2e588584db4a2939046fe03288b44c26fd88f5f55`
ran on Testbed. It raised during terminal cleanup, with no preceding behavior
exception chain in the captured output. It emitted no behavior checkpoint, so
do not promote that absence to accepted behavior evidence. Final traceback:

```text
Traceback (most recent call last):
  File "~/Projects/yoohoo-hub-work/tests/integration/private_sshd_fixture.py", line 276, in _process_identity
    actual = Path(os.readlink(proc / "exe")).resolve(strict=True)
                  ~~~~~~~~~~~^^^^^^^^^^^^
FileNotFoundError: [Errno 2] No such file or directory: '/proc/14703/exe'

The above exception was the direct cause of the following exception:

Traceback (most recent call last):
  File "/tmp/ask-qualified-roundtrip.hO7xDw/tests/agent-launch-roundtrip-live.py", line 203, in <module>
    main()
    ~~~~^^
  File "/tmp/ask-qualified-roundtrip.hO7xDw/tests/agent-launch-roundtrip-live.py", line 188, in main
    private._terminate_identities(private._descendants(identity) + [identity], 3)
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "~/Projects/yoohoo-hub-work/tests/integration/private_sshd_fixture.py", line 359, in _terminate_identities
    live = [item for item in live if not _process_is_gone(item)]
                                         ~~~~~~~~~~~~~~~~^^^^^^
  File "~/Projects/yoohoo-hub-work/tests/integration/private_sshd_fixture.py", line 318, in _process_is_gone
    raise error
  File "~/Projects/yoohoo-hub-work/tests/integration/private_sshd_fixture.py", line 293, in _process_is_gone
    _assert_process(identity)
    ~~~~~~~~~~~~~~~^^^^^^^^^^
  File "~/Projects/yoohoo-hub-work/tests/integration/private_sshd_fixture.py", line 286, in _assert_process
    current = _process_identity(identity.pid, identity.executable)
  File "~/Projects/yoohoo-hub-work/tests/integration/private_sshd_fixture.py", line 278, in _process_identity
    raise PrivateSshdSafetyError(f"cannot resolve executable for {pid}") from error
_yoohoo_private_sshd_fixture.PrivateSshdSafetyError: cannot resolve executable for 14703
```

Owned recovery: confirmed private tmux server PID 14596 from its exact socket
and executable, then issued `kill-server` against that socket only; confirmed
private SSH listener PID 14623 from its private pidfile and executable before
TERM. Read-only inventory confirmed all three PIDs gone and Hypr clients `[]`.
Preserved evidence roots on Testbed (including generated private fixture keys,
not user credentials): `/tmp/ask-live-launch-uj8yiygg`,
`/tmp/yoohoo-live-_makudyu`, and
`/run/user/1000/yoohoo-private-sshd-74ce9r3a`.

Fixture `948762b3cc561cdf2543012d74695406a18cd3699c1aa503339a3740602c51a9`
adds a pre-cleanup behavior checkpoint and bounded retries of the same strict
identity-checked cleanup. No production changes. Awaiting closing static
review before retry; persistent uncertain identity still preserves state.

## Accepted live SSH retry

After independent Sol closing approval, fixture `948762b3` passed on Testbed
with exit 0. Explicit behavior and final cleanup records reported:

```json
{"transport":"ssh","terminalLaunches":1,"attachmentCount":1,"repeats":[{"existing":true,"newLaunches":0,"focused":true},{"existing":true,"newLaunches":0,"focused":true}],"cleanupVerified":true}
```

This exercised production activation/launch arguments, an actual owned
Ghostty/private SSH/tmux connection, real LinuxCollector matches and actual
focus/workspace dispatch. Session and agent names were distinct/random;
actual title remained `terminal`; both matching passes explicitly supported
the transport host/session hint. Window PID/start/stable-ID/address and tmux
client identity/count remained unchanged. Fresh read-only inventory confirmed
Hypr clients `[]` and no owned processes from the retry. The earlier recovered
roots remain as failure diagnostics only.

Limits: synthetic roster and fixture-observed attach preflight; not an Ask
popup click or a real user account/harness. The parent executes Ask's emitted
terminal command with desktop isolation options and a private SSH config.

Native mosh mode, fixture `859d978b5d6b5a0c6ef0d1ddb7047c04025e91637cbc70ff8d9528456b5f2806`,
is now under static review before execution. It uses real native mosh in
loopback-only `--local` mode with Ask's exact attach command and actual client
display argv. The owned mosh server is bound by private-tmux-client ancestry,
PID/start identity, and exact loopback UDP port/inode using the maintained
fixture helpers. It does not cover remote SSH bootstrap. No lumen changes.

## First native mosh attempt: behavior complete, cleanup not accepted

After static approval, `859d978b` emitted the same behavior-complete record as
SSH: one terminal and attachment, two existing-window/workspace focuses and
no repeat launches. It then failed during cleanup:

```text
Traceback (most recent call last):
  File "/tmp/ask-qualified-roundtrip.hO7xDw/tests/agent-launch-roundtrip-live.py", line 287, in <module>
    main()
    ~~~~^^
  File "/tmp/ask-qualified-roundtrip.hO7xDw/tests/agent-launch-roundtrip-live.py", line 273, in main
    stop_proven(private._descendants(mosh_identity) + [mosh_identity])
                ~~~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^
  File "~/Projects/yoohoo-hub-work/tests/integration/private_sshd_fixture.py", line 502, in _descendants
    raise PrivateSshdSafetyError(
        f"process root changed during descendant scan: {root.pid}"
    )
_yoohoo_private_sshd_fixture.PrivateSshdSafetyError: process root changed during descendant scan: 21058
```

Server 21058 had exited by read-only inventory. Root recovered only the exact
owned private tmux server 20898 (socket/PID/executable confirmed) and SSH
listener 20925 (private pidfile/executable confirmed). All three gone and
Hypr clients `[]`. Preserved failure roots:
`/tmp/ask-live-launch-ggtq9idk`, `/tmp/yoohoo-live-2c84yj0p`,
`/run/user/1000/yoohoo-private-sshd-dbfr1aki`.

Fixture-only correction `35a728273d9bf45e5c67818d4b3f612db9972963ef7afeff434f929814200c9a`
adds bounded retries around original-server gone/UDP/descendant observation,
always rechecking the same recorded identity. Persistent uncertainty raises;
no broad kill or live-process proof bypass. Pending short static review and
both transport reruns. Production modules unchanged.

The statically approved canonical seven-module package is now synchronized
into Ask source. All seven files were compared byte-for-byte; collector is
`06f510e61e598b4378effeb7198b22d5d310e428dbf42396849e5b0c0cb860cc`
and resolver is
`0be324ff3bf9052182c7114b5976a0e6e3ab4696942b6f123da934b1268b65bb`.
The source bundle-integrity test expectations were updated, not any installed
files or installation records. Runtime acceptance still requires Testbed.

Files:

- `tests/agent-launch-roundtrip.test.mjs`
- `tests/launch-roundtrip-matcher.py`

The Node regression calls production `activate` from an empty window list.
It records the actual terminal launch request; for mosh, it executes the
production fallback script against recording-only mosh/SSH stubs with an
isolated PATH and without login profiles. For SSH, it records the exact
production argument list. Neither stub executes the remote tmux command.
The resulting argv is replayed through the bundled canonical StaticCollector
and Resolver, then production activation is requested twice more. Expected:
one terminal launch total, two successful existing-window focus requests.

Names are generated per case, not borrowed from the reported agent. Cases
cover SSH/mosh and named/path sockets, with generic window titles for positive
matching. Comparable wrong window index, pane ID, and socket values must not
earn location-supporting evidence. Independent current-title evidence remains
eligible when those hints conflict. Exact evidence assertions need checking
against the upcoming frozen canonical semantics before acceptance.
Contradictory launch argv must also not regain support through the generic
`process_agent_name_hint` path; both generic-title and current-title cases
assert this separately from the transport-location evidence check.

Proposed command on an authorized test host:

```sh
node --test tests/agent-launch-roundtrip.test.mjs
```

Limits: preflight verification, compositor state, focus dispatch, and process
graphs are injected. Mosh's display argv is synthesized from captured launch
arguments, not collected from a running mosh client. This is a production
launch-plan/parser/activation round-trip regression, NOT live desktop proof.
The next live gate must actually launch through Ask, wait for the resulting
window/client, activate again, and verify focus/workspace and unchanged window
and connection counts. No replacement of that live gate by these checks.

No resolver source edits, installation, or lumen test runs in this step.
