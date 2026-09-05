import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IMAGE_LIKE_EXTENSIONS = new Set([
  ".avif", ".bmp", ".gif", ".heic", ".heif", ".jpeg", ".jpg",
  ".png", ".svg", ".tif", ".tiff", ".webp",
]);

export class ImagePasteError extends Error {}

function asBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value || "");
}

export function sniffImageMimeType(value) {
  const data = asBuffer(value);
  if (data.length >= 8 && data.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return "image/jpeg";
  if (data.length >= 6) {
    const signature = data.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF"
      && data.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp";
  return "";
}

export function parseFileUris(value) {
  const paths = [];
  for (const rawLine of String(value || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line === "copy" || line === "cut") continue;
    try {
      const url = new URL(line);
      if (url.protocol === "file:" && (!url.hostname || url.hostname === "localhost"))
        paths.push(fileURLToPath(url));
    } catch {}
  }
  return paths;
}

function normalizeTypes(types) {
  return Array.from(new Set((types || []).map((type) => String(type).trim())
    .filter(Boolean)));
}

function normalizePolicy(policy) {
  const mimeTypes = normalizeTypes(policy?.mimeTypes);
  const maxImageBytes = Number(policy?.maxImageBytes);
  const maxTotalBytes = Number(policy?.maxTotalBytes);
  if (mimeTypes.length === 0 || !Number.isFinite(maxImageBytes) || maxImageBytes <= 0
      || !Number.isFinite(maxTotalBytes) || maxTotalBytes < maxImageBytes)
    throw new TypeError("Image paste policy is incomplete");
  return { mimeTypes, maxImageBytes, maxTotalBytes };
}

function supportedFormats(policy) {
  return policy.mimeTypes.map((type) => type.replace("image/", "").toUpperCase())
    .join(", ");
}

function formatMiB(bytes) {
  return `${Math.ceil(bytes / (1024 * 1024) * 10) / 10} MiB`;
}

function checkSize(name, size, total, policy) {
  if (size > policy.maxImageBytes)
    throw new ImagePasteError(
      `${name} is ${formatMiB(size)}; the per-image limit is ${formatMiB(policy.maxImageBytes)}.`);
  if (total + size > policy.maxTotalBytes)
    throw new ImagePasteError(
      `These images total more than ${formatMiB(policy.maxTotalBytes)}.`);
}

function imageRecord(name, data, declaredMimeType, policy) {
  const buffer = asBuffer(data);
  const mimeType = sniffImageMimeType(buffer);
  if (!mimeType || !policy.mimeTypes.includes(mimeType))
    throw new ImagePasteError(
      `Unsupported image format. Paste ${supportedFormats(policy)}.`);
  if (declaredMimeType && declaredMimeType !== mimeType)
    throw new ImagePasteError(`Clipboard image data does not match ${declaredMimeType}.`);
  return {
    name,
    mimeType,
    size: buffer.length,
    data: buffer.toString("base64"),
  };
}

function preferredTextType(types) {
  return types.find((type) => type.toLowerCase().startsWith("text/plain")) || "";
}

function preferredUriType(types) {
  return types.includes("text/uri-list") ? "text/uri-list"
    : (types.includes("x-special/gnome-copied-files")
      ? "x-special/gnome-copied-files" : "");
}

export async function decodeClipboardOffer(io, rawPolicy) {
  const policy = normalizePolicy(rawPolicy);
  const types = normalizeTypes(await io.listTypes());
  const uriType = preferredUriType(types);
  if (uriType) {
    const uriText = String(await io.readType(uriType, policy.maxTotalBytes));
    const paths = parseFileUris(uriText);
    const imagePaths = paths.filter((path) => IMAGE_LIKE_EXTENSIONS.has(
      extname(path).toLowerCase()));
    if (imagePaths.length > 0) {
      if (imagePaths.length !== paths.length)
        throw new ImagePasteError("Copy only image files before pasting them into Ask.");
      const images = [];
      let total = 0;
      for (const path of imagePaths) {
        const info = await io.stat(path);
        const name = basename(path) || "Pasted image";
        checkSize(name, info.size, total, policy);
        const data = await io.readFile(path);
        checkSize(name, asBuffer(data).length, total, policy);
        const image = imageRecord(name, data, "", policy);
        total += image.size;
        images.push(image);
      }
      return { kind: "images", source: "files", images };
    }
  }

  const declaredMimeType = policy.mimeTypes.find((type) => types.includes(type));
  if (declaredMimeType) {
    let data;
    try {
      data = await io.readType(declaredMimeType, policy.maxImageBytes);
    } catch (error) {
      if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
        throw new ImagePasteError(
          `Clipboard image exceeds the ${formatMiB(policy.maxImageBytes)} per-image limit.`);
      throw error;
    }
    checkSize("Clipboard image", asBuffer(data).length, 0, policy);
    return {
      kind: "images",
      source: "data",
      images: [imageRecord("Pasted image", data, declaredMimeType, policy)],
    };
  }

  if (types.some((type) => type.toLowerCase().startsWith("image/")))
    throw new ImagePasteError(
      `Unsupported image format. Paste ${supportedFormats(policy)}.`);

  const textType = preferredTextType(types);
  if (textType)
    return { kind: "text", text: String(await io.readType(textType, policy.maxTotalBytes)) };
  throw new ImagePasteError("The clipboard does not contain text or a supported image.");
}

async function wlPaste(args, maxBuffer, encoding = "buffer") {
  try {
    const result = await execFileAsync("wl-paste", args, { encoding, maxBuffer });
    return result.stdout;
  } catch (error) {
    if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error;
    throw new ImagePasteError("Could not read the clipboard.");
  }
}

export async function readClipboard(rawPolicy) {
  const policy = normalizePolicy(rawPolicy);
  return decodeClipboardOffer({
    async listTypes() {
      const output = await wlPaste(["--list-types"], 64 * 1024, "utf8");
      return String(output).split(/\r?\n/);
    },
    readType(type, maxBytes) {
      return wlPaste(["--no-newline", "--type", type], maxBytes + 1);
    },
    readFile,
    stat,
  }, policy);
}
