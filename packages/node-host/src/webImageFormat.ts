import { WebImageError } from "./webImageErrors.js";

export type SupportedWebImageMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp";

export interface SniffedImage {
  mimeType: SupportedWebImageMimeType;
  width: number;
  height: number;
}

export const MAX_WEB_IMAGE_EDGE = 8192;
export const MAX_WEB_IMAGE_PIXELS = 16_000_000;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Identify a static PNG, JPEG or WebP image from its container structure and
 * read its dimensions. This is a bounded header check, not a full decoder.
 * Animated PNG/WebP and every other format are rejected.
 */
export function sniffStaticImage(bytes: Buffer): SniffedImage {
  const sniffed = sniffContainer(bytes);
  if (sniffed.width <= 0 || sniffed.height <= 0) {
    throw new WebImageError("invalid_image", "Image dimensions are missing");
  }
  if (
    sniffed.width > MAX_WEB_IMAGE_EDGE ||
    sniffed.height > MAX_WEB_IMAGE_EDGE ||
    sniffed.width * sniffed.height > MAX_WEB_IMAGE_PIXELS
  ) {
    throw new WebImageError(
      "pixel_limit",
      `Image is ${sniffed.width}x${sniffed.height}; limits are ${MAX_WEB_IMAGE_EDGE}px per side and ${MAX_WEB_IMAGE_PIXELS / 1_000_000} megapixels`,
      { width: sniffed.width, height: sniffed.height },
    );
  }
  return sniffed;
}

function sniffContainer(bytes: Buffer): SniffedImage {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return sniffPng(bytes);
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return sniffJpeg(bytes);
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  ) {
    return sniffWebp(bytes);
  }
  const head = bytes
    .toString("latin1", 0, Math.min(bytes.length, 64))
    .trimStart();
  if (head.startsWith("GIF8")) {
    throw new WebImageError(
      "unsupported_format",
      "GIF images are not supported; only static PNG, JPEG and WebP",
    );
  }
  if (head.startsWith("<")) {
    throw new WebImageError(
      "unsupported_format",
      "The response is HTML or SVG, not a PNG, JPEG or WebP image",
    );
  }
  if (bytes.length >= 12 && bytes.toString("latin1", 4, 8) === "ftyp") {
    throw new WebImageError(
      "unsupported_format",
      "AVIF/HEIF images are not supported; only static PNG, JPEG and WebP",
    );
  }
  throw new WebImageError(
    "unsupported_format",
    "Unrecognized image format; only static PNG, JPEG and WebP are supported",
  );
}

function sniffPng(bytes: Buffer): SniffedImage {
  if (bytes.length < 33 || bytes.toString("latin1", 12, 16) !== "IHDR") {
    throw new WebImageError("invalid_image", "PNG header is truncated");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  let offset = 8;
  let sawIend = false;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (type === "acTL") {
      throw new WebImageError(
        "unsupported_format",
        "Animated PNG images are not supported",
      );
    }
    if (type === "IDAT") break; // acTL must precede image data
    if (type === "IEND") {
      sawIend = true;
      break;
    }
    offset += 12 + length;
  }
  if (sawIend)
    throw new WebImageError("invalid_image", "PNG has no image data");
  return { mimeType: "image/png", width, height };
}

function sniffJpeg(bytes: Buffer): SniffedImage {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      throw new WebImageError(
        "invalid_image",
        "JPEG marker structure is invalid",
      );
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) {
      throw new WebImageError(
        "invalid_image",
        "JPEG segment length is invalid",
      );
    }
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isStartOfFrame) {
      if (offset + 9 > bytes.length) break;
      return {
        mimeType: "image/jpeg",
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  throw new WebImageError("invalid_image", "JPEG dimensions were not found");
}

function sniffWebp(bytes: Buffer): SniffedImage {
  let offset = 12;
  let dimensions: { width: number; height: number } | undefined;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("latin1", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (type === "ANIM" || type === "ANMF") {
      throw new WebImageError(
        "unsupported_format",
        "Animated WebP images are not supported",
      );
    }
    if (type === "VP8X" && data + 10 <= bytes.length) {
      if ((bytes[data]! & 0x02) !== 0) {
        throw new WebImageError(
          "unsupported_format",
          "Animated WebP images are not supported",
        );
      }
      dimensions = {
        width: 1 + bytes.readUIntLE(data + 4, 3),
        height: 1 + bytes.readUIntLE(data + 7, 3),
      };
    } else if (type === "VP8 " && data + 10 <= bytes.length && !dimensions) {
      if (
        bytes[data + 3] !== 0x9d ||
        bytes[data + 4] !== 0x01 ||
        bytes[data + 5] !== 0x2a
      ) {
        throw new WebImageError(
          "invalid_image",
          "WebP VP8 frame header is invalid",
        );
      }
      dimensions = {
        width: bytes.readUInt16LE(data + 6) & 0x3fff,
        height: bytes.readUInt16LE(data + 8) & 0x3fff,
      };
    } else if (type === "VP8L" && data + 5 <= bytes.length && !dimensions) {
      if (bytes[data] !== 0x2f) {
        throw new WebImageError(
          "invalid_image",
          "WebP lossless header is invalid",
        );
      }
      const bits = bytes.readUInt32LE(data + 1);
      dimensions = {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >> 14) & 0x3fff),
      };
    }
    offset = data + size + (size % 2);
  }
  if (!dimensions) {
    throw new WebImageError("invalid_image", "WebP dimensions were not found");
  }
  return { mimeType: "image/webp", ...dimensions };
}

/** Declared Content-Type must not contradict the sniffed container. */
export function assertContentTypeCompatible(
  contentType: string | undefined,
  mimeType: SupportedWebImageMimeType,
): void {
  const declared = contentType?.split(";")[0]?.trim().toLowerCase();
  if (
    !declared ||
    declared === "application/octet-stream" ||
    declared === "binary/octet-stream"
  ) {
    return;
  }
  const normalized =
    declared === "image/jpg" || declared === "image/pjpeg"
      ? "image/jpeg"
      : declared;
  if (normalized.startsWith("image/") && normalized !== mimeType) {
    throw new WebImageError(
      "invalid_image",
      `Declared ${declared} but the bytes are ${mimeType}`,
    );
  }
  if (!normalized.startsWith("image/")) {
    throw new WebImageError(
      "unsupported_format",
      `The URL returned ${declared}, not an image`,
    );
  }
}
