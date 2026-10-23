# Release process

Releases are immutable tags cut from the current `main` tip. GitHub Actions
creates the tag and GitHub release; maintainers do not create release tags by
hand.

## Prepare

1. Update `manifest.json` to the intended semantic version without a leading
   `v`.
2. Run the complete checklist in `docs/testing.md`.
3. Commit the release-ready tree and push it to `main`.
4. Confirm the local and remote `main` tips are identical and CI is green.

## Publish

Run the **Release main tip** workflow from GitHub Actions and provide the same
version as `manifest.json`, for example `0.6.0`.

The workflow refuses to publish unless:

- it is running on `main`;
- the checked-out `main` tip matches the current `origin/main` tip;
- the requested version is valid semantic version syntax;
- `manifest.json` contains that exact version; and
- the corresponding `v<version>` tag does not already exist; and
- the current `stable` tip is an ancestor of `main`, so `stable` only moves
  forward.

It runs the bridge and integration regression tests, including image data and
copied-image-file paste, ordinary text paste, and supported format and size
handling. It validates the Node bridge syntax and plugin manifest, tags the
workflow's checked-out `main` commit, and publishes a GitHub release with
generated notes.
