#!/usr/bin/gjs

imports.gi.versions.GnomeDesktop = "4.0";
const { Gio, GLib, GnomeDesktop } = imports.gi;
const ByteArray = imports.byteArray;

function emit(value) {
  print(JSON.stringify(value));
}

const requestId = ARGV[0] || "0";
const path = ARGV[1] || "";

try {
  const file = Gio.File.new_for_path(path);
  const info = file.query_info(
    "standard::display-name,standard::content-type,time::modified",
    Gio.FileQueryInfoFlags.NONE,
    null
  );
  const uri = file.get_uri();
  const mime = info.get_content_type() || "application/octet-stream";
  const mtime = info.get_attribute_uint64("time::modified");
  const factory = GnomeDesktop.DesktopThumbnailFactory.new(
    GnomeDesktop.DesktopThumbnailSize.LARGE
  );

  let thumbnail = factory.lookup(uri, mtime);
  if (!thumbnail && factory.can_thumbnail(uri, mime, mtime)) {
    const pixbuf = factory.generate_thumbnail(uri, mime, null);
    if (pixbuf) {
      factory.save_thumbnail(pixbuf, uri, mtime, null);
      thumbnail = factory.lookup(uri, mtime);
    }
  }

  let text = "";
  let truncated = false;
  if (!thumbnail && Gio.content_type_is_a(mime, "text/plain")) {
    const [, contents] = file.load_contents(null);
    const decoded = ByteArray.toString(contents).replace(/\u0000/g, "");
    text = decoded.slice(0, 24000);
    truncated = decoded.length > text.length;
  }

  emit({
    id: requestId,
    path,
    name: info.get_display_name() || file.get_basename() || "",
    mime,
    thumbnail: thumbnail || "",
    text,
    truncated
  });
} catch (error) {
  emit({ id: requestId, path, name: GLib.path_get_basename(path), thumbnail: "", text: "" });
}
