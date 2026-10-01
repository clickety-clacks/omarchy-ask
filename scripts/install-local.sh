#!/bin/bash
# Install a committed version of this checkout as the local Omarchy plugin.
#
#   scripts/install-local.sh [--restart] [REF]     REF defaults to HEAD
#
# The installed copy (~/.config/omarchy/plugins/clickety-clacks.ask) stays a
# real clone of GitHub, so `omarchy plugin update` keeps working, but its HEAD
# is moved to the exact commit installed. `git -C <installed> log -1` always
# answers "what is running here?".
#
# Refuses when this checkout has uncommitted changes (commit first; work never
# lives only in an installed copy) or when the installed copy was edited by
# hand. Dependencies and built artifacts in the installed copy (node_modules,
# the compositor module) are git-ignored and kept.
#
# The shell does not reload plugin QML on its own: --restart runs
# `omarchy-restart-shell`. Run it from inside the desktop session.
set -euo pipefail

restart=0
ref=HEAD
for arg in "$@"; do
  case $arg in
    --restart) restart=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    -*) echo "install-local: unknown option $arg" >&2; exit 2 ;;
    *) ref=$arg ;;
  esac
done

repo=$(cd -- "$(dirname -- "$0")/.." && pwd)
id=$(jq -r .id "$repo/manifest.json")
target="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins/$id"
upstream=https://github.com/clickety-clacks/omarchy-ask.git

if [[ -n $(git -C "$repo" status --porcelain) ]]; then
  echo "install-local: $repo has uncommitted changes; commit them first." >&2
  git -C "$repo" status --short >&2
  exit 1
fi
commit=$(git -C "$repo" rev-parse --verify "$ref^{commit}")

if [[ ! -d $target/.git ]]; then
  echo "install-local: $target is not installed; run: omarchy plugin add $upstream" >&2
  exit 1
fi
if [[ -n $(git -C "$target" status --porcelain) ]]; then
  echo "install-local: $target was changed by hand; move those changes into $repo and commit them." >&2
  git -C "$target" status --short >&2
  exit 1
fi

git -C "$target" remote set-url origin "$upstream" 2>/dev/null || git -C "$target" remote add origin "$upstream"
lock_before=$(git -C "$target" rev-parse HEAD:bridge/package-lock.json 2>/dev/null || true)
git -C "$target" fetch --quiet "$repo" "$commit"
git -C "$target" -c advice.detachedHead=false checkout --quiet --detach "$commit"
lock_after=$(git -C "$target" rev-parse HEAD:bridge/package-lock.json)
if [[ $lock_before != "$lock_after" || ! -d $target/bridge/node_modules ]]; then
  (cd "$target/bridge" && npm ci --silent)
fi

echo "Installed $id at $(git -C "$target" log -1 --format='%h %s')"
if (( restart )); then
  omarchy-restart-shell
else
  echo "Restart the shell to load it: omarchy-restart-shell"
fi
