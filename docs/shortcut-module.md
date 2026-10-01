# Shortcut module development and installation

This integration is verified on the supported plumbus baseline but not released. In
this worktree, Ask initializes shortcut support automatically using the exact
compositor connection reported by Quickshell. It never selects the first
compositor implicitly. The commands below are also available for diagnostics.

An open request waits for initialization before creating a conversation or ACP
process. Toggling again cancels that request. A matching cached build loads
without compiling; a cold build runs outside the QML source tree. Failure does
not add any controls or diagnostic panels to Ask: it reports a single console
warning and opens normally with native system-shortcut precedence. Missing
Node, missing `hyprctl`, and a failed loader must not strand the popup or pin
handoff. The next open retries unavailable support.

The compositor module gives the focused Ask surface precedence only for its
declared application shortcuts. Unclaimed keys use Hyprland's original binding
dispatcher, including its current bindings, submaps, device filters and keymap
policy. Ask's own symbol matching follows the symbol Qt receives, including
shifted symbols and device layouts. When switching between identical keymaps,
Hyprland sends the new layout group's modifiers after the first key; that
first key still uses the prior seat group and ownership accounts for it.

## Explicit management tool

`node hyprland/manage.mjs` defaults to read-only `status`. Mutating actions
require an exact instance signature, either through `--instance INSTANCE` or
`HYPRLAND_INSTANCE_SIGNATURE`; it never selects the first compositor or accepts
a numeric instance index. For isolated testing, always pass `--instance`.

```sh
node hyprland/manage.mjs build --instance INSTANCE
node hyprland/manage.mjs load --instance INSTANCE
node hyprland/manage.mjs status --instance INSTANCE
```

- `build` produces an immutable artifact in
  `$XDG_CACHE_HOME/clickety-clacks.ask/shortcuts` (or the normal `~/.cache`
  fallback). `--cache-dir PATH` selects an isolated test cache.
- The current implementation is explicitly validated for the clean Hyprland
  `0.56.2` commit `efb50993780079460b0cbed1363e2166a2de1d9f`. Other commits are
  rejected before loading; rebuilding alone is not a claim of compatibility.
- It compiles and runs a small separate header-ABI probe before compiling the
  module. A mismatch with the running compositor is reported without loading
  a candidate. The module also performs its own runtime ABI check.
- Builds need Node, make, a C++23 compiler, pkg-config, and matching Hyprland
  development headers/dependencies. The tool does not install packages or
  request privilege elevation. Cached matching builds do not need recompiling.
- `load` verifies the module's ABI, protocol and source-build identity. Loading
  the same build again is a no-op. For a recognized older build in the same
  cache, it builds the replacement before unloading the exact old path. If
  loading the replacement fails, it attempts to restore the previous module.
  Unknown builds, different ABIs, and artifacts loaded from another directory
  are left running. It never unloads unrelated compositor modules.
- No user Hyprland config, keybinding or Omarchy shell config is rewritten.

To unload an artifact loaded from this cache:

```sh
node hyprland/manage.mjs unload --instance INSTANCE --module /absolute/path/from/load.so
```

Use the same `--cache-dir` if a custom cache was selected. Unload retains the
artifact for rollback. It does not delete application settings or reset a
submap. In the absence of the module, native system shortcuts continue to work,
but conflicts with Ask's own shortcuts take native precedence.

## Verification

Static policy and argument checks:

```sh
node --test tests/shortcut-*.test.*
ASK_TEST_NATIVE_BUILD=1 node --test tests/shortcut-install-integration.test.mjs
```

The opt-in integration test uses a fake compositor command and the real build
headers, deliberately reports a different running ABI, and verifies that
`plugin load` is never called and no failed build is published. It never loads
anything into the user's compositor.

Live tests require the explicit disposable compositor and fixtures documented
in [the plumbus evidence](reviews/2026-09-13-plumbus-shortcut-scope.md).
When testing a managed artifact, set `ASK_SHORTCUT_TEST_MODULE` to its exact
path for `tests/shortcut-routing.py`'s unload/reload case.

`tests/shortcut-startup.py` exercises actual QML with a delayed loader, a failed
loader, missing Node and missing `hyprctl`, using an isolated PATH and fake ACP
bridge. `tests/shortcut-upgrade.test.mjs` checks safe replacement, rollback,
failed compilation, unknown modules, foreign paths and idempotence without
touching a compositor. See the evidence document for live upgrade results and
installed-shell/kernel-input acceptance; successful loading alone is not full acceptance.

The installed-shell test can use either Wayland virtual input or a temporary
kernel keyboard (`uinput`). Its optional `--uinput-image sha256:IMAGE_ID` backend
uses an explicitly selected local Python container image, with networking and
capabilities disabled, a read-only root filesystem, and only `/dev/uinput` plus
the read-only test script exposed. It requires existing Docker authorization;
it does not change input-device permissions or sudo policy. The device is
destroyed on EOF and the container is removed. This is automated kernel/libinput
testing, not a claim that a person pressed a physical USB keyboard.
