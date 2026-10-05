# Duplicate agent window: real mosh acceptance

The user reproduced duplicate creation on lumen after source-only best-effort
work. Read-only hashes confirmed installed Ask still used Linux collector
`29869743`; source used `c83fd9f9`. The explicit no-deployment instruction meant
the installed behavior had not changed. This explains deployment state, but
does not establish that the new code fixes the actual connection topology.

Earlier Testbed live tests used two equal-title Ghostty windows and a synthetic
remote roster. Those checks exercised real activation but did not run mosh.
They are insufficient evidence for the user's `0_1_9` case.

Required reproduction: two real Ghostty/mosh connections to the same owned
private tmux target on Testbed, generic window titles rather than agent-name
titles; select via Ask's production activation path; focus an existing window
and its workspace; preserve the full window set and tmux client count. Use
actual local process/transport metadata and record the exact scope of any
synthetic roster. No lumen runtime testing or deployment is authorized here.

## Result: real mosh activation passed on Testbed

The final run of `tests/bundled-resolver-mosh-windows.py` passed through Ask's
production `activate()` path. It created two real Ghostty windows, each running
a real encrypted loopback mosh connection attached to the same private tmux
pane. Both titles were the generic `mosh`, and the synthetic roster agent name
was deliberately unrelated to the window titles. The mosh-client `-#` display
arguments carried the target host/session hints, matching the user's captured
standalone-client command form. The host label was synthetic (`atlas.invalid`);
this was not a connection to Atlas or a roaming-network test.

The test put the windows on separate workspaces, made the first most recently
used, then invoked activation from an empty workspace. Both real match passes
returned both candidates. Actual compositor focus reached the first window
and its workspace. No attachment was attempted; the full two-window identity
set and two tmux-client rows were unchanged after activation.

Output:

```json
{"candidateCount":2,"newAttachmentAttempts":0,"status":"passed","tmuxClientCount":2,"windowCount":2,"workspaceSwitched":true}
```

The fixture cleans up its owned terminal/client trees, then private mosh
servers, then private tmux/sshd. Post-run read-only inventory showed no desktop
windows, Ghostty, mosh, tmux, or private sshd fixture processes. Only the current
inspection SSH session remained. Mosh keys stayed in memory/child environment;
they were not printed or persisted.

## Exact source and scope

- Fixture SHA256: `12bd8e2a5c1f8bbea2545baed34a3f38304257d7c02d596a464cd436cb572e21`.
- Shared collector SHA256: `f2911ba1d4cca826542ed8c1a8be571a6688ac7f37443b7cd996775d7663af45`.
- Shared matcher SHA256: `24174377501e53434c8786f75641be5be9e71baa9b0e96274e9e1aca72d40d42`.
- Resolver client SHA256: `90f4c66819fb66c0934795c999be203c03791d7ed227248aba6f34bc93484558`.
- Tested Hub adapter SHA256: `865cc2d1e59b4cfd01e91586fd427ee97725e3756a2b60834f3d803a65c7f2e3`.
  Local source differs only in its two introductory comment lines describing
  best-effort ranking; every executable line is identical.
- Staged at `/tmp/ask-bundled-library.x7JPAb` on Testbed.
- All seven bundled Python files match the canonical handoff unchanged.
- The 33 resolver-client/activation-policy checks also passed on Testbed with
  the final shared source. These checks are supplementary, not the live proof.

Sol statically reviewed fixture startup/cleanup before the live run. Two
fixture-only corrections were needed: discover Node from the test environment
(Testbed uses mise), and use the current Hyprland Lua workspace dispatchers.
Earlier failed attempts are not product failures or claimed passing runs.

This proves the real-mosh existing-window **activation path**, not a mouse
click through the Ask popup, full network roaming, or the actual lumen/Atlas
session. The installed lumen Ask remains unchanged; no lumen runtime tests or
deployment were performed. Yoohoo owns its separate product activation gate
and can reuse the frozen fixture's product-neutral callback.
