# Omarchy Ask: agent guide

Omarchy Ask is a Quattro shell plugin: a transient conversation with a local coding agent, plus
search over apps, files, windows and running agents. See README.md for what it does,
CONTRIBUTING.md for setup and design rules, and docs/architecture.md for the invariants.

## Branches and releases

Two long-lived branches:

| Branch | What it is | Who moves it |
|---|---|---|
| `main` | Everyday development. Finished work lands here and is pushed. | Anyone, after tests pass |
| `stable` | The repository's **default branch**: what `omarchy plugin add` clones and `omarchy plugin update` follows. Always a released commit. | Only the release workflow |

Rules:

1. **Work on a branch; push it to GitHub the same day**, WIP commits included. Work that exists only
   on one machine is invisible and one disk away from gone.
2. **When the work is done and tested, merge it into `main` and push.** Pushing `main` ships
   nothing to users, so there is no reason to hold finished work back. Delete the branch.
3. **Releases are cut from `main`.** Set the version in `manifest.json`, write
   `releases/<version>.md`, commit both to `main`, push, then run
   `gh workflow run release.yml --ref main -f version=X.Y.Z`. The workflow checks the tip,
   tests it, tags `vX.Y.Z`, publishes the GitHub release and fast-forwards `stable` to it.
   Never push to `stable` by hand.
4. **Never edit an installed copy.** Install a committed version with `scripts/install-local.sh`
   (below). It refuses uncommitted work.
5. **Finish every session with nothing hanging:** no uncommitted changes, every branch pushed.
   `hanging-work` lists what isn't (it runs daily on Mike's machine and notifies him).

History: from 2026-09-05 to 2026-10-01 two and a half weeks of features lived uncommitted in a
checkout and in the installed copy, because `main` was what users installed and nobody wanted
to push unfinished work there. This setup exists so that never needs to happen again.

## Compositors

Behavior (agents, files, conversations, settings) is the same on every compositor. Only
`bridge/compositor.js` and `ShortcutPlatform.js` may know which compositor is running; see
"Compositors" in docs/architecture.md. Nothing else calls `hyprctl` or checks the desktop.

## Installing a change on a machine

    scripts/install-local.sh [--restart] [REF]

installs a committed version (default `HEAD`) of this checkout as the local plugin
(`~/.config/omarchy/plugins/clickety-clacks.ask`). The installed copy stays a real clone of
GitHub, checked out at exactly the installed commit, so `git -C <installed> log -1` says what is
running. It refuses when the checkout has uncommitted changes or the installed copy was edited by
hand, and reruns `npm ci` when the lockfile changed. `omarchy plugin update` later returns that
copy to `stable` (it can't while the copy is ahead of `stable`; reinstall from a checkout instead).

The Omarchy shell runs with Quickshell's file watching off, so new QML does nothing until the
shell restarts: pass `--restart`, or run `omarchy-restart-shell` from inside the desktop session
(on Scottland, from outside it: `scottland-exec -- omarchy-restart-shell`). A restarted bridge
process is not evidence the QML changed. Exercise the change with real input before calling it
done (docs/testing.md).
