import { decode } from "bmp-js";
import { PNG } from "pngjs";

const BMP_FILE_HEADER_SIZE = 14;
const BITMAP_INFO_HEADER_SIZE = 40;

// Bound decoded allocation independently of the compressed/on-disk size.
const MAX_BMP_PIXELS = 25_000_000;

function readBmpDimensions(data: Buffer): { width: number; height: number } {
  if (
    data.length < BMP_FILE_HEADER_SIZE + BITMAP_INFO_HEADER_SIZE ||
    data.toString("ascii", 0, 2) !== "BM"
  ) {
    throw new Error("Invalid BMP file");
  }

  const dibHeaderSize = data.readUInt32LE(BMP_FILE_HEADER_SIZE);
  if (dibHeaderSize !== BITMAP_INFO_HEADER_SIZE) {
    throw new Error("Unsupported BMP header");
  }

  const width = data.readInt32LE(18);
  const signedHeight = data.readInt32LE(22);
  const height = Math.abs(signedHeight);

  if (width <= 0 || height === 0) {
    throw new Error("Invalid BMP dimensions");
  }
  if (width * height > MAX_BMP_PIXELS) {
    throw new Error(
      `BMP dimensions are too large (${width}x${height}). Max: ${MAX_BMP_PIXELS.toLocaleString("en-US")} pixels`,
    );
  }

  return { width, height };
}

/** Convert a Windows BMP into a model-compatible PNG. */
export function convertBmpToPng(data: Buffer): Buffer {
  const dimensions = readBmpDimensions(data);
  const decoded = decode(data);

  if (
    decoded.width !== dimensions.width ||
    decoded.height !== dimensions.height ||
    decoded.data.length !== decoded.width * decoded.height * 4
  ) {
    throw new Error("Invalid BMP pixel data");
  }

  // bmp-js exposes pixels as ABGR. Most BMP variants have no alpha channel
  // and use zero for the reserved byte, so only preserve alpha when a 32-bit
  // image contains at least one non-zero alpha value.
  const preserveAlpha =
    decoded.bitPP === 32 &&
    decoded.data.some((value, index) => index % 4 === 0 && value !== 0);
  const rgba = Buffer.alloc(decoded.data.length);
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    rgba[offset] = decoded.data[offset + 3];
    rgba[offset + 1] = decoded.data[offset + 2];
    rgba[offset + 2] = decoded.data[offset + 1];
    rgba[offset + 3] = preserveAlpha ? decoded.data[offset] : 255;
  }

  const png = new PNG({ width: decoded.width, height: decoded.height });
  png.data = rgba;
  return PNG.sync.write(png);
}
