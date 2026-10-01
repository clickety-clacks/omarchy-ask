# Keyboard inheritance investigation — incomplete

Goal: Ask overrides only its own shortcuts; every other current user mapping
continues working automatically, including mappings added/remapped while open.

## Actual desktop evidence

Osanwe, Hyprland 0.56.2 (efb50993780079460b0cbed1363e2166a2de1d9f),
2026-09-13. The installed Ask was the existing image-paste WIP; no plugin files,
ACP code, or image work were replaced, and the shell was not restarted.

`tests/keyboard-input.py` creates a temporary uinput device and sends Linux key
codes through libinput. It reads no keyboard/clipboard/chat data. `wtype` is not
an adequate shortcut test on this desktop: its virtual keyboard events bypass
Hyprland binding dispatch. A counter remained zero with wtype but incremented
using uinput for the same temporary Super+F12 binding.

Real-input sequence (counter is a Lua variable, not a command with side effects):

1. Normal desktop, Super+F12: counter 0 -> 1.
2. Open installed Ask: `hyprctl submap` = `omarchy-ask`. Super+F12: remains 1.
3. Reset submap while keeping the same Ask popup open: Super+F12 -> 2.
   Exclusive focus was still enabled. Thus exclusive focus alone did not block
   this native compositor binding. The prior claim that it necessarily did was
   incorrect. Its pointer/focus behavior is a separate concern.
4. Close the empty test popup. Set the existing live preference
   `useHyprlandShortcutSubmap` to false, without restarting the shell.
5. Register fresh Super+F12 counter binding and open Ask: map stays `default`;
   real-input shortcut increments 0 -> 1.
6. While that popup remains open, replace the binding with an increment-by-10
   callback. Same input increments 1 -> 11, without reopening Ask.
7. Remove the temporary binding and device; close the empty test popup. Verified
   no `ask-shortcut-test` keyboard remains, map is `default`, configerrors empty.

No physical dictation acceptance is claimed by this test. It proves the
compositor route and live remapping for a harmless test chord, not microphone
behavior or all possible bind flags/devices/layouts.

## Current changes and remaining work

- Source Ask.qml no longer enters the legacy isolated submap or honors the old
  opt-in. The subsequent audit also removed its startup reset: the read/dispatch
  recovery races with other actors changing maps. New Ask code never changes
  compositor submaps. Any legacy stale map must be recovered deliberately during
  deployment, without a lingering automatic reset in the application.
- Osanwe's live ask.json has that setting false as a mitigation. Source QML is
  NOT installed; active pinned conversations must not be destroyed to deploy it.
- Six existing harness tests pass and `git diff --check` passes. These tests say
  nothing about shortcut precedence.
- **Not complete:** Ask's explicit conflicting shortcuts still need scoped
  compositor precedence. In particular Super+comma conflicts with dismiss-last-
  notification, Ctrl+Return with half-width-window. Merely disabling the submap
  restores desktop shortcuts but leaves those Ask controls losing conflicts.
- README and docs/testing still describe the old opt-in. Update them with the
  actual complete mechanism when implemented; do not publish this partial state.

## Constraints established from compositor source

Read the matching v0.56.2 source, not just current wiki syntax:

- KeybindManager.cpp checks submap membership, enabled state, input capture,
  inhibitors and session lock before invoking matching binds. It collects ALL
  matching binds before dispatch; registering a second matching bind does not
  override the first. Mutating handles in a sentinel callback is too late.
- InputManager.cpp emits `input.keyboard.key` before keybind dispatch. Native
  Wayland injected events can take the DISALLOWACTION route and skip dispatch.
- LuaKeybind.cpp exposes enabled/set_enabled, key/keycode/modmask and flags but
  its `remove` removes by chord, not just that handle. Do not use it to install
  temporary overlapping bindings and expect precise cleanup.
- Lua registration exposes `hl.bind`, `hl.unbind`, `hl.define_submap` and input
  events. It does not expose a documented inheriting/fallback submap.
- vicinae-hotkey-v1 rejects compositor-binding conflicts; it cannot provide the
  required temporary override semantics here.

Possible integration designs still need evaluation. Do not copy the user's
keymap, blanket-enable bindings in all user submaps, replace native dispatch
with synthesized keys, or patch only Super+H. Preserve release/repeat/chord/
device flags, disabled bindings, reloads, and cleanup on popup destruction.
If wrapping Lua binding registration is considered, it must handle preexisting
bindings, later registration/removal and conditional enabled-state changes;
do not ship a broad userdata proxy without checking compatibility.

## Follow-up API audit

The live `hl` table exposes only `bind`, `unbind` and `is_key_down` among names
containing `bind` or `key`. There is no binding-enumeration/fallback/priority API
in this installed release. The native headers are installed, but no compositor
plugins are loaded. Nothing was built, installed or loaded into Hyprland.

A robust native scoped-routing implementation could leave the live binding
objects and native dispatch untouched for non-Ask chords, and pass only Ask-owned
chords to the focused Ask surface. It must maintain press/release state, stop
claiming chords on focus loss/unmap/pin/crash, and avoid a broad key grab. This is
a proposed compositor integration, not an implemented or accepted solution.
Loading native code into the user's compositor introduces desktop-crash risk and
needs explicit approval beyond the existing Ask testing authorization. Isolated
compositor tests should precede any proposed live installation.

Tightbeam Ask PDO was notified that this external session owns keyboard-specific
implementation/testing; it retains image work. Its previously reported image
acceptance wait was for an unlocked desktop. No unlock was asserted on its behalf.
