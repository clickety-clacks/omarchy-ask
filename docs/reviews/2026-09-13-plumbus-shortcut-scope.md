# Plumbus scoped-shortcut prototype — in progress

Mike's current goal explicitly authorizes all needed testing on plumbus,
including compositor integration. The prior authorization blocker is resolved.
No experimental compositor code has been loaded on osanwe.

## Implementation in the current worktree

- Ask.qml: removed legacy submap entry, reset and every old reconciliation call.
- ShortcutScope.qml: advertises a focused Ask surface's own chords through a
  small compositor command; does not enumerate or mirror system bindings.
- ShortcutPolicy.js: declarations for conversation, model selector and motion
  editor; row-selection and permission claims are context-dependent.
- Conversation.qml, HarnessSelector.qml, MotionTuner.qml: connected the helper.
- hyprland/shortcut-scope.cpp: ABI-gated Hyprland module. Intercepts native
  regular-bind and client-global-hotkey routing only for a declared chord on a
  focused live Ask surface. Other input calls the original native implementation.
  Does not mutate binding objects, flags, handlers or submaps. Retains ownership
  of release events for presses that began in Ask.
- Build with `make -C hyprland`. `-fno-gnu-unique` is important for actual unload/
  reload of rebuilt modules; without it a reload can retain old library code.

## Test platform and live handles (revalidate before use)

Plumbus is reachable over `ssh plumbus`. Same Hyprland 0.56.2 source/ABI as osanwe,
GCC 16.2.1. It has compiler, pkg-config, make, qs, and wtype. SSH requires an
explicit Hyprland instance or the matching environment. No passwordless sudo;
none was needed for these tests.

- Test root: `/home/mike/Projects/ask-shortcut-test.2wXmli`
- Original desktop: instance
  `efb50993780079460b0cbed1363e2166a2de1d9f_1789165026_2119019914`, PID 1038,
  wayland-1. **No compositor plugins loaded**, rechecked after testing.
- Disposable nested compositor: instance
  `efb50993780079460b0cbed1363e2166a2de1d9f_1789314178_1257467660`, PID 57934,
  wayland-2. Launched over SSH with WAYLAND_DISPLAY=wayland-1,
  AQ_DRM_DEVICES=/dev/null and tests/shortcut-compositor.lua. Exec session 69727.
- Controlled popup: `shell.qml`, QS instance `xea1ea8blt`, PID 60153,
  exec session 76977. Uses tests/ShortcutSurface.qml and real ShortcutScope.qml.
- Actual Ask wrapper: `actual.qml`, QS instance `wz91l58blt`, PID 59612,
  exec session 2804. All conversations currently closed. Uses copied Commons,
  Ui and services from plumbus's Omarchy install plus source in `ask/`.
  ASK_BRIDGE_COMMAND points to tests/shortcut-fake-bridge.py; no account, model
  or network is used. Do not describe these as real harness tests.

Use XDG_RUNTIME_DIR=/run/user/1000 and WAYLAND_DISPLAY=wayland-2 for test qs IPC
and wtype. Every hyprctl command must target the exact nested instance, never
implicitly select the original desktop. Do not kill/restart PID 1038.

## Evidence

`tests/shortcut-routing.py INSTANCE wayland-2 QS_INSTANCE` passed all nine cases
on the current module, including the second global-hotkey hook. Latest runner
exec session 63177 finished exit 0:

1. Super+comma and Ctrl+Return reach the popup, conflicting native actions stay 0.
2. F5 press/release and Super+F12 take the native path, no text leaks into popup.
3. F5 remapped while the popup stays open immediately uses the new callbacks.
4. A newly registered Super+H works without entering h into the popup.
5. Duplicate unclaimed native bindings both execute normally.
6. Disabled binding remains disabled, not revived by the scope.
7. Changing Ask's declaration relinquishes/reclaims only that chord.
8. Close/reopen restores and reacquires precedence.
9. Config reload retains scoped behavior and uses fresh native bindings.

Fixture observations establish both action counters and popup delivery; GUI key
delivery alone would not prove compositor routing. In particular wtype's sparse
keymap requires `input.resolve_binds_by_sym=true` in this **test-only compositor**.
Without it, native binding lookup uses physical-PC keycodes and never matches
the synthesized keys, while Qt still sees them. This explains the earlier
apparent shortcut bypass. Do not change a user's input setting to accommodate a
synthetic test. The osanwe uinput evidence remains valid independently.

The fixture's original IPC method `show` collided with a qs CLI subcommand and
printed introspection instead of opening the surface. It was renamed
`openSurface`; the close/reopen case then passed. This was a test bug, not a
reason to skip the lifecycle case.

Actual Ask was loaded in the nested compositor with real QML/components and a
deterministic fake bridge. Verified:

- Super+comma opened the actual harness selector from the overlay; conflicting
  notification action stayed 0.
- F5 native press/release worked while the actual selector was open.
- Escape dismissed the selector; Ctrl+P pinned the same Ask conversation.
- Super+comma opened the selector from the pinned Ask window; native conflict
  still stayed 0.
- No QML runtime errors in these interactions. Closed these test conversations
  through `askTest.closePrompts` afterward.

The six existing harness tests and git diff --check pass. They are unrelated to
proof of routing semantics.

## Required remaining work — do not mark complete yet

- Review and test the exact ShortcutPolicy claims against all enabled QML
  handlers, including composer/file-browser state, shifted and keypad variants,
  text editing/image paste, and permission keys. Do not claim keys Ask does not
  actually handle. No F5/Super+H special case belongs in the implementation.
- More live cases: keycode/device-specific binds, layout/shifted-symbol matching,
  and shell disappearance. Full-keymap protocol tests now cover the first two
  (below); physical hardware/multiple-device interactions still need checking.
  A real client-global-hotkey client now passes five
  cases, recorded below. The
  focus, modifier distinction, held-key, repeat/long-press, foreign-submap,
  module unload/reload and malformed-request cases now pass (see below).
- Registration is asynchronous but now accepts a uniquely mapped Ask surface
  before it takes focus. Layer popups gate initial focus on admission, tested
  below. Pinned-window startup and context-update timing still need evaluation.
  Missing module leaves native bindings usable but does not satisfy the full
  goal.
- Finish installation/ABI compatibility and safe removal, documentation, and
  release-quality tests. An explicit tested management tool now exists, but
  normal Ask startup/upgrade integration remains. README/docs/testing remove obsolete submap
  installation instructions and explicitly identify the integration as still
  in development. No commit, public release or osanwe deployment has
  been made. Prototype is not an accepted production dependency yet.
- Reconcile generic protocol policy/security and unload safety. Native hooks
  are version-specific; refuse unsupported ABI rather than silently promising
  a general fix.
- After acceptance testing, clean up only the explicit test processes/configs;
  original plumbus desktop and all user bindings remain intact.

## Continuation: context policy and lifecycle audit

The prior status-only turn was no progress. This continuation changed source,
reproduced failures, corrected them and expanded live coverage.

Changes:

- `ShortcutPolicy.conversation` now takes named context fields. Pinned windows
  no longer reserve Escape except for the focused composer's actual selection
  dismissal handler. File browsing no longer reserves disabled horizontal
  scrolling shortcuts. Empty-search Backspace is reserved only in that context.
- `tests/shortcut-policy.test.cjs` executes the real QML JS library and passes
  six tests, including all 256 boolean context combinations for duplicate and
  unintended desktop claims. This does **not** replace actual handler tests.
- `ShortcutFocus.qml` adopts installed Omarchy `Ui/KeyboardPanel.qml`'s brief
  75ms Exclusive prime followed by OnDemand. All three Ask layer surfaces and
  the controlled fixture use it. Permanent Exclusive focus prevents native
  window focus in Hyprland `CFocusState::rawWindowFocus`; the tested native
  Super+F6 focus action can now leave the still-mapped popup.
- A new `CTRL + Return + F11` test failed with `(0,0,0)` native counters. The
  routing hook skipped `handleKeybinds`' held-key tracking for Ask-owned keys.
  The hook now maintains the same key/modifier sets on its owned path; all
  unclaimed events still use the original function. No binding objects change.
  Access to these ABI-private input sets requires `-fno-access-control` in the
  module build; this reinforces the exact-version compatibility boundary.
- Module init/exit emits an `askshortcuts` IPC lifecycle event. Open scopes
  invalidate/retry on this event as well as ordinary config reload.

Live evidence on the same nested compositor and fixture (revalidated PID 57934,
QS `xea1ea8blt`, PID 60153): `tests/shortcut-routing.py` now passes **19 cases**,
latest exec session **23206**, exit 0. Added coverage beyond the original nine:

10. Extra Shift/Alt modifiers keep distinct native shortcuts.
11. A native Super+F6 window-focus binding leaves mapped Ask; native conflicting
    shortcuts work in the other window; returning focus restores Ask precedence.
12. An Ask-owned key held across surface close cannot fire a native release.
13. A native key held across focus departure retains its release callback.
14. A native repeating key fires repeatedly while Ask is focused.
15. Native long-press fires only after the threshold, not on a short press.
16. Native multi-key bindings see a held Ask key, and release removes that state.
17. A foreign submap remains selected through Ask close/reopen and its native
    bindings work; Ask overrides only its own conflicting chord.
18. Malformed/overflow/invalid-symbol/oversized declarations and a wrong PID
    are rejected without replacing the existing scope.
19. Unloading the module leaves native F5 and Super+comma working. Reloading
    restores precedence in the already-open surface without reopening it.

Test corrections were necessary and are not product fixes: a newly mapped
same-process window did not automatically take focus, so the fixture now tests
an actual native focus binding; expected parser errors use subprocess output
instead of assuming zero exit; negative malformed modifiers are inside the
command payload rather than interpreted as CLI options. Module loading itself
schedules a compositor config reload (`PluginSystem.cpp`), which resets fixture
counters; the reload assertion compares counters after that reset and also
requires application delivery to increase.

`tests/actual-shortcut-routing.py` passes **four cases** in real updated Ask QML
with the deterministic fake bridge (exec session **36517**, exit 0): overlay
F5 press/release; selector Super+comma precedence plus native F5; pinned Escape
reaching a test native binding without closing the conversation; selector
Escape overriding that same native binding only inside the selector. All test
conversations were closed in `finally`. These tests deliberately wait for
initialization and **do not prove startup registration timing**.

All 12 Node tests (six new policy tests plus six existing harness tests) pass;
`git diff --check` is clean. Original plumbus compositor PID 1038 again reports
`no plugins loaded`. Nested compositor reports no config errors. Actual Ask
fixture reports zero conversations. The controlled popup/nested compositor
remain available for the next acceptance cases; no experimental module has
been installed or loaded on osanwe.

## Continuation: popup admission and real global-hotkey client

The preceding turn was progress. This continuation changes the startup order:
`ShortcutScope` now registers when its backing window maps, without waiting
for focus. The native module looks up a **unique live view** with the declared
PID and namespace/title; it still stores a weak view pointer, not a persistent
PID/title template. Ambiguous or missing views are rejected. Routing still
requires that exact view to be focused.

`ShortcutFocus.allowed` gates the layer's initial keyboard focus until the
registration response is received. Admission is latched until hide, so normal
context changes/config reload cannot repeatedly grab focus back. First attempts
run on the next QML event turn; failed attempts retain a 20ms retry interval.
After five failures it admits the window using native binding precedence;
this is the existing missing-module fallback, **not** a complete replacement
for installing the dependency. Conversation/selector/motion layer windows use
the gate. Normal pinned windows do not have an equivalent gate yet.

The controlled popup now records focus arriving before registration, and the
suite immediately sends Super+comma after first focus on twenty rapid reopen
cycles. This test must begin from a fresh shell process: QML hot reload can
inherit an already-focused native surface and therefore does not represent
cold startup. A component-construction undefined-target warning found on the
first cold run was corrected; the final cold run has no such warning.

Final revalidated controlled fixture:

- QS instance `81h1ft9blt`, launched in exec session **44936** with the same
  test root `shell.qml` and nested compositor as above. Earlier fixture PIDs
  60153 and 66870 were explicitly terminated and replaced; do not reuse them.
- `tests/shortcut-routing.py` passes **20 cases**, including the twenty reopen
  cycles, in combined exec session **90561**, exit 0.
- `tests/hotkey-routing.py` passes **five cases** using the new real Wayland
  client `tests/hotkey-client.c`, in the same combined exec session, exit 0.
  It verifies registration while Ask is open; unclaimed F5 press/release with
  no popup leakage; Super+comma precedence; close/reopen; and owned/native
  keys held across Ask close. This directly exercises `routeHotkey`, unlike
  the prior regular-bind tests. The client exits and config is restored.
- `tests/actual-shortcut-routing.py` again passes all **four cases** against
  the updated actual Ask QML/fake bridge (exec session **22063**, exit 0).
  No real model/account test is implied.
- All 12 Node policy/harness tests pass; `git diff --check` is clean.

Build the client with `make -C tests
HYPRLAND_PROTOCOLS=/tmp/hyprland-src/protocols`; Wayland scanner generates
client bindings from the protocol XML in the exact tested Hyprland source
tree. Generated files/binary live in ignored `tests/.build/`. No production
dependency on this test client or its protocol generator was added.

No installation/upgrade helper, persistent compositor configuration, commit,
release, or osanwe deployment was made. Remaining work above is still a real
release/completion gate, particularly pinned/context timing, physical/layout
coverage, and safe dependency installation/recovery.

## Continuation: full keymaps and explicit module management

The preceding turn was progress. This continuation reproduced and corrected
an actual shifted-symbol routing failure, added a real full-XKB virtual keyboard
client, and built/installed a managed artifact in the disposable compositor.

### Input correction and coverage

`tests/keyboard-client.c` supplies a full `evdev`/`pc105` XKB keymap, conventional
Linux keycodes, real modifier-key events, and US/German layout groups. The
test disables the wtype-only `resolve_binds_by_sym` accommodation. It is still
virtual-keyboard protocol input, not physical hardware.

`Ctrl+Shift+=` producing `+` failed before the correction: the configured native
binding fired instead of Ask, with native counters `(1111,1,1)`. Native binding
resolution intentionally uses its configured unshifted map, whereas Ask's
declaration refers to the app-delivered symbol. The owned path now checks
`keyboard->m_xkbState`; native unclaimed dispatch and multi-key bookkeeping keep
their original symbols. A third, outer `onKeyEvent` hook carries the **actual
event keyboard** through the earlier global-hotkey call. SeatManager's keyboard
can still be the previous device at that point. Global-hotkey owned presses are
now tracked by device plus code, not code alone.

Nine full-keymap cases pass:

1. Native F5 with ordinary codes and symbol accommodation disabled.
2. Native Super+H alongside Ask-owned Super+comma.
3. A newly added explicit `code:191` binding.
4. Device inclusion filters, including rejection of a different device name.
5. Shifted `+` overriding its conflicting native physical binding.
6. Ask claims following the active German layout group.
7. Releasing that claim restoring unchanged native keymap resolution.
8. Caps Lock not changing shortcut ownership.
9. Keypad Enter and Shift+Tab matching their app-delivered symbols.

One test correction: the standard XKB `inet(evdev)` map assigns physical FK14
to `XF86Launch5`, not `F14`. The device-filter case now uses ordinary F6; the
explicit code test separately covers extended function-key codes. No user
keymap was changed to make that test pass.

### Management and ABI checks

`hyprland/manage.mjs` implements explicit `status`, `build`, `load`, and `unload`.
It refuses guessed/numeric compositor targets, unsupported/dirty compositor
commits, mismatched headers, and replacement of a different loaded Ask module.
It stores source-hashed, ABI-qualified immutable artifacts in a cache and never
rewrites user config. It verifies native module identity after loading.

The initial standalone ABI probe could not link when including PluginAPI.hpp,
because that header initializes compositor-only globals. It now includes only
`version.h` and the exact supported PluginAPI ABI formula. The module separately
uses the actual PluginAPI check at load time. Both report the same current ABI.

Five installation tests pass, including an opt-in integration test that uses
real headers plus a deliberately mismatched fake compositor ABI and proves no
`plugin load` call occurs and no failed artifact remains. The four ordinary
installer tests plus the six policy and six harness tests also pass together
(16 tests, exit 0); `git diff --check` is clean.

On plumbus the management tool successfully:

- Built without altering the initially loaded development module.
- Refused `load` while that different module remained loaded.
- Loaded the new artifact after an explicit unload of the known test module.
- Returned `unchanged:true` on a repeated load.
- Unloaded the exact cached module, reported `loaded:false`, then loaded it
  again and verified its protocol/ABI/build identity. The artifact was retained.

**Current loaded module path in the nested compositor** (do not assume the old
`hyprland/ask-shortcut-scope.so` path is loaded):

`/home/mike/Projects/ask-shortcut-test.2wXmli/managed/efb50993780079460b0cbed1363e2166a2de1d9f_aq_0.14_hu_0.14_hg_0.5_hc_0.1_hlg_0.6-8111632a619b6403828d92be.so`

Build ID: `8111632a619b6403828d92be`. Set `ASK_SHORTCUT_TEST_MODULE` to that path
when running the routing suite's unload/reload case. The `manage.mjs` source
and module source/build files are copied to the test root's `hyprland/`.

Combined live exec session **17223** passed all **38 cases**, exit 0: 20 ordinary
routing/startup/lifecycle cases, nine full-keymap cases, five real global-hotkey
cases and four actual Ask QML cases with the deterministic fake bridge. Fixture
QS IDs remain `81h1ft9blt` (PID 68732) and `wz91l58blt` (actual Ask). All real-Ask
test conversations were closed; the controlled popup was closed by the hotkey
suite. Only the explicit nested compositor was targeted.

This is not yet normal install/startup integration or a release. Pin handoff,
context timing, remaining hardware/multi-device/crash coverage, and normal
startup/upgrade handling remain open. No osanwe plugin or compositor was changed.

## Startup, pinning, contexts and multi-device completion pass

This section supersedes the open startup/pinning/context work and module paths
above. The worktree remains unreleased; osanwe's installed Ask was not changed.

### Product changes

- Ask initializes the native support once per manager. It uses Quickshell's
  actual Hyprland socket, not a guessed/default compositor. Opening during a
  build queues the request without a conversation or ACP process; toggling
  closed cancels it. Missing executables and loader failures still allow Ask
  to open with native-key precedence, without new UI controls.
- Pinning acknowledges the overlay's temporary focus hold before mapping the
  toplevel, registers the toplevel before admitting focus, and retains the
  same bridge. The handoff also terminates safely when `hyprctl` cannot start.
- Composer declarations follow its selected-field state (`focus`), not desktop
  focus (`activeFocus`). Losing desktop focus no longer drops declarations
  just before returning to the pinned window.
- Permission Y/N work even when an editable composer remains active. The
  context test exposed TextArea consuming these before window Shortcuts; the
  shared key handlers now handle them only while permission is pending.
- Managed upgrades build first, replace only a recognized same-cache artifact,
  and attempt rollback if the new module fails. Unknown builds and foreign
  loaded paths are left alone. Neither user config nor packages are changed.
- Two keyboard devices are tested concurrently, including the same held code.
  A same-keymap/different-group switch exposed a native ordering detail:
  `CSeatManager::setKeyboard` does not send modifiers before the first key,
  and `CWLKeyboardResource::sendKeymap` skips identical keymaps. Ownership now
  uses the previous seat group's symbol for that first event, matching Qt,
  without changing the compositor's native binding resolution or event order.
- The virtual-keyboard test client now releases its held keys on EOF, including
  assertion-failure cleanup. Earlier failed-device runs could otherwise leave
  Qt repeat/held-key state behind and contaminate the next run.

### Verified evidence

- Full current module: **ba105f462bf199a1331815aa**.
  Loaded artifact in the disposable compositor:
  `/home/mike/.cache/ask-shortcut-startup.hW5JMS/efb50993780079460b0cbed1363e2166a2de1d9f_aq_0.14_hu_0.14_hg_0.5_hc_0.1_hlg_0.6-ba105f462bf199a1331815aa.so`.
- Live manager upgrades succeeded from `8111632a619b6403828d92be` to
  `a3bf6b8b30d03204aaa3d6c6`, then to the current build. The module-reported
  identity was inspected after replacement. A separate cold empty-cache
  startup had already built/loaded the a3bf artifact successfully.
- Exec **22223**, exit 0, current build: **20** routing/lifecycle cases,
  **5** real client-global-hotkey cases, and **9** actual Ask QML cases.
  The latter include five fresh pin cycles with zero unregistered pinned-focus
  events and unchanged bridge PIDs, plus search, permission and file-browser
  native-conflict tests. The actual shell was cold-started after the permission
  fix; an earlier hot reload had not picked it up and was not accepted as proof.
- Exec **94554**, exit 0: the ten-case full-keymap suite passed twice, once with
  distinct device keymaps and once with identical maps/different groups.
  These cover **11 unique cases**, not twenty distinct cases.
- Exec **12310**, exit 0, current source/module: **4** actual startup/failure
  scenarios passed (delayed, failed loader, missing Node, missing hyprctl).
  Each verifies native F5 and a completed pin handoff. Delayed/failed setup
  also verifies cancellation with zero conversations/bridge processes.
- Exec **72832**, exit 0: focused test shell PID 68732 was deliberately killed
  with SIGKILL. F5 press/release and native Super+comma recovered immediately,
  without resetting bindings or changing submaps. Only that test fixture was
  killed; the real Omarchy shell was not targeted.
- 26 static/installer/harness tests passed, including a real-header ABI-mismatch
  preflight and mocked safe-update/rollback cases. Clean-tree `omarchy plugin
  validate` passed, as did `git diff --check` and C test-client compilation
  with warnings treated as errors.

The above is **50 unique live cases** (20+11+5+9+4+1), not a claim of physical
keyboard or actual-harness testing. ACP was the deterministic fake bridge.
`/dev/uinput` on plumbus is root-only, no ydotool injector is installed, and
the user has no passwordless sudo permission for input injection. No ACL,
sudo policy, system package or original-desktop binding was changed to bypass
that restriction. Full-keymap input uses the real Wayland keyboard path and
conventional evdev codes, but is not a physical hardware acceptance result.

### Current test topology

The original desktop remains PID 1038 / wayland-1 and still reports no native
plugins loaded. The disposable compositor remains PID 57934 / wayland-2,
instance `efb50993780079460b0cbed1363e2166a2de1d9f_1789314178_1257467660`.
The post-crash controlled fixture is `su02rtcblt` (exec 88536). The actual-Ask
fixture `ojv1bgcblt` was stopped before the startup suite, which owns and cleans
up its own shells. Do not reuse prior actual-Ask IDs.

The test-client Makefile and exact source protocol XML are now present on
plumbus. Build with
`HYPRLAND_PROTOCOLS=/home/mike/Projects/ask-shortcut-test.2wXmli/tests/protocols`;
the earlier `/tmp/hyprland-src` path exists on osanwe, not on plumbus.

Post-crash recovery was also verified: exec **22996** reran all 20 routing
cases against the newly launched controlled fixture, exit 0. Exec **63467**
reran all 26 static/installer/harness checks after the final source change,
exit 0, with the real-header test enabled and no skips.

Remaining release acceptance is the real-device input check and testing the
installed plugin alongside the user's actual shell/plugin set (including the
separate image work). Do not infer either from the isolated fixtures. No
release was cut and no experimental module was loaded into a user desktop.

## Installed-shell and kernel-input acceptance

This final section supersedes the installation/input limitations above.
Plumbus had **no installed Ask**, so there was no image work there to overwrite.
The worktree was installed at
`/home/mike/.config/omarchy/plugins/clickety-clacks.ask`, dependencies installed
with `npm ci`, and the plugin enabled through Omarchy's normal CLI. The previous
shell config was backed up as `shell-before-install.json` in the test root.
Osanwe's installed plugin (which differs from this repository) was not touched.

The native support automatically built/loaded into the original plumbus
compositor, PID 1038 / wayland-1. Its module identity is build
`ba105f462bf199a1331815aa`, protocol 1, the supported ABI. `/proc/1038/maps`
confirms the actual loaded file is:

`/home/mike/.cache/clickety-clacks.ask/shortcuts/efb50993780079460b0cbed1363e2166a2de1d9f_aq_0.14_hu_0.14_hg_0.5_hc_0.1_hlg_0.6-ba105f462bf199a1331815aa.so`

### Installed-shell finding and fix

The first real-shell run exposed a focus issue the isolated desktop did not:
the model selector could open, but Escape closed the underlying Ask instead.
The real pointer was outside the selector card. In this Hyprland version,
changing a focused layer from Exclusive to OnDemand calls
`simulateMouseMovement()`. A card-only input mask allowed that to send keyboard
focus back to the underlying full-screen Ask layer.

Both settings popups now retain their transparent outside area as an input
region and dismiss on an outside click, with no new visible controls. The
underlying Ask panel uses keyboard interactivity None while its settings popup
is wanted; it returns to its normal brief prime/OnDemand lifecycle afterward.
Native keyboard focus actions still work while the popup remains mapped.

The old shell had cached QML components despite files changing. Acceptance was
therefore rerun after `omarchy restart shell`, not inferred from a hot reload.
The new original-desktop shell is QS **ql82lfdblt**, PID **104462**. Its plugin
list reports `clickety-clacks.ask` enabled. The isolated shells were not restarted
by that operation. A clean shell restart is required for this structural update.

### Real input path and results

The user already had Docker access on plumbus. The kernel input test used the
official Python image pinned to local ID
`sha256:c6ead215bfd31f1e433d968853b7a769989117115b728874824e6c0a27cb96fc`.
The container had no network, no Linux capabilities, a read-only root filesystem,
no-new-privileges, a 128 MiB memory limit and 32-process limit. Its only host
exposures were `/dev/uinput` and the read-only test script. No sudo permission,
device ACL or system package was changed. The image remains as a test cache.

Exec **28595**, exit 0, passed these **six installed-shell cases using the
kernel/libinput keyboard path**:

1. Ask's selector receives Super+comma over the existing consuming notification
   binding; F5 press/release and Super+H retain their native actions.
2. The motion popup keeps keyboard focus with the pointer outside its card,
   closes with Escape, and preserves native F5.
3. A newly changed Super+H binding works without reopening the Ask overlay.
4. Pinning finishes, the first pinned Super+comma works, and F5/Super+H remain
   native in the pinned window.
5. The normal shell toggle opens a new overlay on the first invocation after
   pinning; hiding that overlay leaves the pinned conversation intact.
6. A native focus shortcut moves focus to the nested compositor's ordinary
   window while the settings popup stays mapped.

The runner also verified creation/removal of the named kernel keyboard. After
exit, no `ask-shortcut-uinput-*` container remained and `/dev/uinput` was still
`600 root root`. F5 and Super+H were initially unused on plumbus; the temporary
test bindings were removed by reloading the original config, with no config
errors. No prompt was submitted to a model. This is a kernel-device-path test,
not a claim of physical USB key presses by a person.

The four earlier installed-shell cases also passed with ordinary Wayland
virtual input (exec **40348**), then kernel input (exec **45975**). The backend
confirmation output is not counted as another user-behavior test.

After the settings-focus fix, exec **80782**, exit 0, reran all 20 routing cases,
both ten-case keyboard variants (11 unique cases), and five client-global-hotkey
cases. Exec **16188** reran all 26 static/installer/harness checks with the real
header test enabled, exit 0, and verified the enabled installed plugin and actual
loaded module path above. Together with the conversation/startup/crash cases,
the acceptance set comprises **56 unique live cases**, with separate repeated
input backends rather than inflated duplicate counts.

This is a tested worktree installation on the authorized test platform, not a
public release or deployment to osanwe. Merging it into osanwe's separate image
work and cutting a release are separate delivery actions, not performed here.

### Final verification and handoff

- Exec **26471**, exit 0: all nine actual-Ask cases passed on the final QML,
  after a cold fixture start. Exec **66439**, exit 0: all four startup/failure
  cases passed again on that final source.
- SHA-256 comparison of all 13 runtime QML/JS/native-source/build files showed
  an exact match between the repository and the installed plumbus plugin.
- Final clean-tree Omarchy plugin validation and `git diff --check` passed.
- Comparing shell config before/after installation found only the added
  `clickety-clacks.ask` entry. The existing `mike.agentd-menu` entry was retained.
  The temporary F5/Super+H bindings were absent after tests, and the real shell
  answered `ping` successfully.
- The disposable controlled shell PID 94420 and nested compositor PID 57934
  were terminated after acceptance. The actual-Ask fixture and startup runners
  had already exited. Test artifacts, the original shell-config backup and
  compiled caches remain for reproducibility; no user documents were deleted.
- Plumbus retains the enabled tested Ask installation and its native support.
  Original compositor PID 1038 and shell PID 104462 were not targeted by test
  cleanup. There is no running test-input container or kernel test keyboard.
