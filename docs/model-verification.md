# Model verification — September 4, 2026

The previous adapter bundled Codex 0.148.0: an Astra prompt returned a server
error requiring a newer CLI even though ACP reported readiness and end_turn.
Upgraded codex-acp to 1.10.0 and claude-agent-acp to 0.74.0. The lockfile
installs Codex 0.153.4 and Claude SDK 0.3.257.

Real prompts requested `ASK_MODEL_OK`, with tools forbidden in the prompt.
Verified response text as well as completion; readiness alone is insufficient.
The medium/high/xhigh/max sweep used the installed plugin bridge; initial low
tests used the identical source bridge and upgraded dependencies.

Verified models: gpt-6-astra, gpt-5.6-luna, gpt-5.6-terra, gpt-5.6-sol,
claude-opus-4-8, claude-opus-5, claude-fable-5, claude-fable-5-1.
Verified effort settings: low, medium, high, xhigh, max.
ACP config responses were checked for the selected model and effort.
Opus 5 resolves to `opus[1m]`, whose adapter metadata explicitly identifies
Opus 5. Versioned Claude selections are passed through per-session settings;
substring matching was removed to prevent Fable 5 selecting Fable 5.1.

UI checks: Hyprland send_shortcut opened the selector in overlay and pinned
windows. Home selected Luna, Return persisted it, and a shell restart retained
the selection. End/Return restored Astra. Super+comma is registered only in
the temporary omarchy-ask submap; the global notification binding is unchanged.
wtype did not reliably deliver the chord on this machine.

No release was published as part of this repair.

## System-harness follow-up

The adapter dependency versions above are not the harness launch policy.
Ask now explicitly resolves system Codex/Claude from PATH (or the documented
executable override), and fails visibly rather than using a transitive copy.
With no saved Ask override, the bridge reads Omarchy’s Default Agent.

`node bridge/model-smoke.js --full` passed all 41 live cases: the system
default and eight explicit models at low/medium/high/xhigh/max. Every explicit
case checked final ACP model/effort metadata and an exact `ASK_SYSTEM_OK`
response, not merely readiness. System versions were Codex 0.153.3 and Claude
Code 2.1.259. Tests did not alter credentials or default settings.

An isolated Quickshell popup rendered an unsupported-harness error, restarted
with system Codex, and rendered `ASK_RECOVERY_OK`. The installed popup was
then reloaded with no existing Ask conversations open: its selector showed
“Omarchy default” and its real Astra/low prompt rendered `ASK_INSTALLED_OK`.
The live ask.json and defaults/agent SHA-256 hashes remained unchanged.

The automated policy tests also cover missing defaults, changed defaults,
saved/explicit overrides, unsupported agents, missing binaries, executable
directories, named/path overrides, and structured startup failures.

Final failure checks used the installed bridge with temporary, empty credential
directories and minimal environments. Real Codex and Claude both produced a
structured fatal login message explaining how to sign in to the system harness
and start a new Ask session. No real credentials were moved. Prompt-time auth
failures are terminal too, so the popup exposes its recovery controls.
Closed-connection and outdated-version message handling is covered by unit
tests; the system harnesses were not downgraded to reproduce an old release.
Unrecognized errors retain their original details. All six automated tests pass.

During final checks, `mise which claude` unexpectedly pruned older tool
installations and reported an inactive Claude entry. No mise configuration was
changed by Ask. A subsequent real Ask/Claude prompt still succeeded. This is
distinct from the completed 41-case model sweep recorded above.
