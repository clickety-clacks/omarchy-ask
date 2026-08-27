# Contributing

Omarchy Ask is a Quattro shell plugin. Changes should preserve its small visual
surface and the lifecycle, permission, and privacy invariants documented in
`docs/architecture.md`.

## Setup

```sh
git clone https://github.com/clickety-clacks/omarchy-ask.git
cd omarchy-ask/bridge
npm ci
```

For live development, install or link the repository as an Omarchy user plugin
and enable `clickety-clacks.ask`. Omarchy Shell reloads local plugin changes;
use `omarchy restart shell` after structural QML changes or a stale reload.

## Before committing

Run the static checks and relevant manual cases from
[`docs/testing.md`](docs/testing.md). Do not validate the repository with its
`node_modules` tree included: npm's executable symlinks are runtime dependency
artifacts, not distributable plugin files.

Keep `package-lock.json` committed. Do not add generated dependencies,
transcripts, credentials, or `~/.config/omarchy/ask.json`.

## Design rules

- Keep `Ask.qml` a manager and `Conversation.qml` the owner of one live ACP
  session.
- Never restart or clone a bridge merely to pin its conversation.
- Keep Ask mode fail-safe and never synthesize ACP permission options.
- Use ACP `messageId` for assistant boundaries.
- Preserve the user's scroll position when they leave the tail.
- Avoid raw tool arguments in logs and durable state.
- Keep compatibility scoped to Omarchy Quattro unless another generation is
  explicitly implemented and tested.

## Releasing

1. Complete the release checklist in `docs/testing.md`.
2. Update `manifest.json` to the semantic version being released.
3. Commit the version and release-ready changes.
4. Push `main`.
5. Create and push an annotated `vX.Y.Z` tag at that commit.
6. Publish a GitHub release from the tag with user-facing notes.
7. Confirm `main`, the tag, the manifest version, and the GitHub release agree.

Example:

```sh
git tag -a vX.Y.Z -m 'Omarchy Ask X.Y.Z'
git push origin main
git push origin vX.Y.Z
gh release create vX.Y.Z --repo clickety-clacks/omarchy-ask \
  --title 'Omarchy Ask X.Y.Z' --notes-file /path/to/release-notes.md
```

Do not move an existing release tag. Correct mistakes with a new patch release.
