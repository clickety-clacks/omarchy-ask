import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ImagePasteError,
  decodeClipboardOffer,
  parseFileUris,
  sniffImageMimeType,
} from "./image-paste.js";

const policy = {
  mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
  maxImageBytes: 32,
  maxTotalBytes: 64,
};
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 1]);

function offer(types, values = {}, files = {}) {
  return {
    async listTypes() { return types; },
    async readType(type) { return values[type] ?? Buffer.alloc(0); },
    async readFile(path) { return files[path]; },
    async stat(path) { return { size: files[path].length }; },
  };
}

test("recognizes supported image bytes and local file URIs", () => {
  assert.equal(sniffImageMimeType(png), "image/png");
  assert.equal(sniffImageMimeType(jpeg), "image/jpeg");
  assert.deepEqual(parseFileUris([
    "# copied files",
    "copy",
    "file:///tmp/one%20image.png",
    "https://example.com/not-local.png",
  ].join("\n")), ["/tmp/one image.png"]);
});

test("browser or screenshot image data wins over text alternatives", async () => {
  const result = await decodeClipboardOffer(offer(
    ["text/html", "image/png", "text/plain;charset=utf-8"],
    { "image/png": png, "text/plain;charset=utf-8": "fallback" }), policy);
  assert.equal(result.kind, "images");
  assert.equal(result.source, "data");
  assert.equal(result.images[0].data, png.toString("base64"));
});

test("copied image files win over their URI-list text", async () => {
  const result = await decodeClipboardOffer(offer(
    ["text/uri-list", "text/plain"],
    { "text/uri-list": "file:///tmp/first.png\nfile:///tmp/second.jpg" },
    { "/tmp/first.png": png, "/tmp/second.jpg": jpeg }), policy);
  assert.equal(result.kind, "images");
  assert.equal(result.source, "files");
  assert.deepEqual(result.images.map((image) => image.name), ["first.png", "second.jpg"]);
});

test("ordinary text paste preserves its content", async () => {
  const text = "first line\nsecond line\n";
  const result = await decodeClipboardOffer(offer(
    ["text/plain;charset=utf-8"], { "text/plain;charset=utf-8": text }), policy);
  assert.deepEqual(result, { kind: "text", text });
});

test("unsupported formats and mixed file selections fail clearly", async () => {
  await assert.rejects(decodeClipboardOffer(offer(
    ["image/avif"], { "image/avif": Buffer.from("avif") }), policy),
  /Unsupported image format.*PNG, JPEG, GIF, WEBP/);
  await assert.rejects(decodeClipboardOffer(offer(
    ["text/uri-list"],
    { "text/uri-list": "file:///tmp/first.png\nfile:///tmp/notes.txt" },
    { "/tmp/first.png": png, "/tmp/notes.txt": Buffer.from("notes") }), policy),
  /Copy only image files/);
});

test("per-image and aggregate limits report the exceeded boundary", async () => {
  await assert.rejects(decodeClipboardOffer(offer(
    ["image/png"], { "image/png": Buffer.concat([png, Buffer.alloc(32)]) }), policy),
  /per-image limit/);
  const smallPolicy = { ...policy, maxImageBytes: 10, maxTotalBytes: 12 };
  await assert.rejects(decodeClipboardOffer(offer(
    ["text/uri-list"],
    { "text/uri-list": "file:///tmp/first.png\nfile:///tmp/second.png" },
    { "/tmp/first.png": png, "/tmp/second.png": png }), smallPolicy),
  /total more than/);

  const changedFile = offer(
    ["text/uri-list"], { "text/uri-list": "file:///tmp/changed.png" },
    { "/tmp/changed.png": Buffer.concat([png, Buffer.alloc(32)]) });
  changedFile.stat = async () => ({ size: png.length });
  await assert.rejects(decodeClipboardOffer(changedFile, policy), /per-image limit/);
});

test("declared MIME must match the image bytes", async () => {
  await assert.rejects(decodeClipboardOffer(offer(
    ["image/png"], { "image/png": jpeg }), policy),
  (error) => error instanceof ImagePasteError && /does not match image\/png/.test(error.message));
});
