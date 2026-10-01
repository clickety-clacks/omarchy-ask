# System-shortcut acceptance

Objective: fully support system shortcut keys except where Ask overrides them;
test on the authorized plumbus platform.

Implementation and the installed plumbus copy are verified against the current
Omarchy/Hyprland baseline. This is not a public release or an osanwe deployment.
Detailed commands, build identities, failed-test findings and successful reruns
are recorded in [the live evidence](2026-09-13-plumbus-shortcut-scope.md).

| Requirement | Current evidence |
| --- | --- |
| Honor the live desktop map, including new user bindings | Native dispatcher retained; live F5/Super+H/keycode/remap tests pass in isolated and installed shells, including kernel input. No keymap copying or submap changes. |
| Give Ask precedence only for its active shortcuts | Context declarations plus focused-surface ownership; selector, search, permission, file-browser, pinned Escape and inactive-window cases pass. |
| Preserve native input semantics | Press/release, held keys across focus/close, repeats, long press, duplicate/disabled bindings, device filters, modifier distinctions, layouts, simultaneous devices, native submaps and real client global hotkeys pass. |
| Do not strand focus or seize normal desktop focus actions | Popup admission, repeated pin handoffs, settings popups with the pointer outside their cards, and native focus leaving a still-mapped popup pass. Settings dismiss without additional visible controls. |
| Preserve conversation lifecycle | Five fresh pin cycles retain bridge identity; installed shell opens a new overlay on the first toggle after pin and closes only that overlay. |
| Initialize/recover safely | Empty-cache build, cached loading, explicit compositor selection, supported ABI checks, safe managed upgrades/rollback, missing executables, delayed-open cancellation, reload/unload and abrupt shell exit verified. |
| Verify the actual test-platform installation | Current code installed/enabled in the normal plumbus shell; all 13 runtime source/build files match the repository. Six integration cases pass through a temporary kernel/libinput keyboard, not just Wayland synthetic input. |
| Preserve unrelated state and clean up | Only Ask was added to the shell config; temporary bindings, keyboard and container removed. Disposable compositor/shell stopped. Device permissions unchanged. Osanwe's differing installed image work untouched. |

There are **56 distinct live integration cases** plus **26 static, installer
and harness-policy/error checks**, all passing. Repeated backends/runs are not
counted as new behavior cases. The kernel keyboard was automated through uinput;
no claim is made that a person pressed physical USB keys. No model prompt was
needed for keyboard acceptance.

Compatibility remains explicit: native hooks are verified for the clean
Hyprland 0.56.2 source/ABI identified in the evidence. Unknown versions are not
loaded speculatively. If support is unavailable, native bindings stay usable
and Ask can still open, but conflicting native shortcuts take precedence.
Future compositor versions require compatibility verification, not merely a
recompile. Public release and merging/deploying into osanwe's separate working
tree remain separate authorized delivery actions.
