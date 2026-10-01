# Omarchy Ask: agent guide

Omarchy Ask is a Quattro shell plugin: a transient conversation with a local coding agent, plus
search over apps, files, windows and running agents. See README.md for what it does,
CONTRIBUTING.md for setup and design rules, and docs/architecture.md for the invariants.

## Branches and releases

- Do work on a branch. When the work is done and tested, merge it into `main`. Don't leave
  finished work on branches or uncommitted in an installed copy; that is how two and a half
  weeks of features went unreleased before (2026-09-05 to 2026-10-01).
- Releases are cut from `main` (`.github/workflows/release.yml`, "Release main tip"), with the
  version from `manifest.json` and notes in `releases/<version>.md`.
- `omarchy plugin add` and `omarchy plugin update` install whatever is on GitHub's `main`, not
  the latest release. Pushing to `main` therefore ships to everyone who installs or updates.
  Push to `main` only what is ready for users.

## Compositors

Behavior (agents, files, conversations, settings) is the same on every compositor. Only
`bridge/compositor.js` and `ShortcutPlatform.js` may know which compositor is running; see
"Compositors" in docs/architecture.md. Nothing else calls `hyprctl` or checks the desktop.

## Installing a change on a machine

The installed copy lives in `~/.config/omarchy/plugins/clickety-clacks.ask`. The Omarchy shell
runs with Quickshell's file watching off, so copied QML does nothing until
`omarchy restart shell`. A restarted bridge process is not evidence the QML changed. Exercise the
change with real input before calling it done (docs/testing.md).
