# Themed Markdown links spike

Qt Quick's selectable `TextEdit` supports `MarkdownText` but, unlike `Text`,
does not expose `linkColor`. Its renderer therefore uses an internal blue for
links regardless of the Omarchy palette.

The spike keeps `TextEdit.MarkdownText` and rewrites only ordinary inline link
labels from `[label](destination)` to a label containing a themed HTML `span`.
Qt retains that inline color while continuing to own Markdown parsing, text
selection, wrapping and `onLinkActivated`.

Direct Qt 6.11 testing also established that a document-level `<style>` block
is ignored. The link-local span is the smallest approach that works without a
compiled QML extension or a second Markdown renderer.

Known spike limits:

- Reference-style links and automatic URL links are not recolored.
- Markdown formatting nested inside a link label needs broader fixtures before
  this should ship.
- The transformation must continue to run on the original assistant Markdown,
  never on already transformed output.
