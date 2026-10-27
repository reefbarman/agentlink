import { PNG } from "pngjs";

// Bound decoded allocation independently of the on-disk size.
const MAX_PPM_PIXELS = 25_000_000;

interface Token {
  value: string;
  end: number;
}

function isWhitespace(value: number): boolean {
  return (
    value === 0x09 ||
    value === 0x0a ||
    value === 0x0b ||
    value === 0x0c ||
    value === 0x0d ||
    value === 0x20
  );
}

function skipWhitespaceAndComments(data: Buffer, start: number): number {
  let offset = start;
  while (offset < data.length) {
    if (isWhitespace(data[offset])) {
      offset += 1;
      continue;
    }
    if (data[offset] !== 0x23) break;

    while (
      offset < data.length &&
      data[offset] !== 0x0a &&
      data[offset] !== 0x0d
    ) {
      offset += 1;
    }
  }
  return offset;
}

function readToken(data: Buffer, start: number, label: string): Token {
  const offset = skipWhitespaceAndComments(data, start);
  let end = offset;
  while (end < data.length && !isWhitespace(data[end]) && data[end] !== 0x23) {
    end += 1;
  }
  if (end === offset) {
    throw new Error(`Invalid PPM file: missing ${label}`);
  }
  return { value: data.toString("ascii", offset, end), end };
}

function parseInteger(token: Token, label: string): number {
  if (!/^\d+$/.test(token.value)) {
    throw new Error(`Invalid PPM ${label}: ${token.value}`);
  }
  const value = Number(token.value);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Invalid PPM ${label}: ${token.value}`);
  }
  return value;
}

function scaleSample(value: number, maxValue: number): number {
  return Math.round((value * 255) / maxValue);
}

/** Convert an ASCII (P3) or binary (P6) PPM image into a model-compatible PNG. */
export function convertPpmToPng(data: Buffer): Buffer {
  const magic = readToken(data, 0, "magic number");
  if (magic.value !== "P3" && magic.value !== "P6") {
    throw new Error("Unsupported PPM format: expected P3 or P6");
  }

  const widthToken = readToken(data, magic.end, "width");
  const heightToken = readToken(data, widthToken.end, "height");
  const maxValueToken = readToken(data, heightToken.end, "maximum value");
  const width = parseInteger(widthToken, "width");
  const height = parseInteger(heightToken, "height");
  const maxValue = parseInteger(maxValueToken, "maximum value");

  if (width <= 0 || height <= 0) {
    throw new Error("Invalid PPM dimensions");
  }
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_PPM_PIXELS) {
    throw new Error(
      `PPM dimensions are too large (${width}x${height}). Max: ${MAX_PPM_PIXELS.toLocaleString("en-US")} pixels`,
    );
  }
  if (maxValue <= 0 || maxValue > 65_535) {
    throw new Error("Invalid PPM maximum value: expected 1-65535");
  }

  const rgba = Buffer.alloc(pixelCount * 4);
  const sampleCount = pixelCount * 3;

  if (magic.value === "P3") {
    let offset = maxValueToken.end;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const token = readToken(data, offset, `pixel sample ${sampleIndex + 1}`);
      const sample = parseInteger(token, `pixel sample ${sampleIndex + 1}`);
      if (sample > maxValue) {
        throw new Error(
          `Invalid PPM pixel sample ${sample}: exceeds maximum value ${maxValue}`,
        );
      }
      const pixelIndex = Math.floor(sampleIndex / 3);
      const channel = sampleIndex % 3;
      rgba[pixelIndex * 4 + channel] = scaleSample(sample, maxValue);
      rgba[pixelIndex * 4 + 3] = 255;
      offset = token.end;
    }

    if (skipWhitespaceAndComments(data, offset) !== data.length) {
      throw new Error("Invalid PPM file: unexpected data after pixel samples");
    }
  } else {
    let rasterOffset = maxValueToken.end;
    if (rasterOffset >= data.length || !isWhitespace(data[rasterOffset])) {
      throw new Error("Invalid PPM file: missing raster separator");
    }
    // Treat CRLF as one logical line-ending separator. Do not skip arbitrary
    // whitespace here because the first binary sample may itself be whitespace.
    if (data[rasterOffset] === 0x0d && data[rasterOffset + 1] === 0x0a) {
      rasterOffset += 2;
    } else {
      rasterOffset += 1;
    }

    const bytesPerSample = maxValue < 256 ? 1 : 2;
    const expectedBytes = sampleCount * bytesPerSample;
    if (data.length - rasterOffset !== expectedBytes) {
      throw new Error(
        `Invalid PPM pixel data: expected ${expectedBytes} bytes, received ${data.length - rasterOffset}`,
      );
    }

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const sampleOffset = rasterOffset + sampleIndex * bytesPerSample;
      const sample =
        bytesPerSample === 1
          ? data[sampleOffset]
          : data.readUInt16BE(sampleOffset);
      if (sample > maxValue) {
        throw new Error(
          `Invalid PPM pixel sample ${sample}: exceeds maximum value ${maxValue}`,
        );
      }
      const pixelIndex = Math.floor(sampleIndex / 3);
      const channel = sampleIndex % 3;
      rgba[pixelIndex * 4 + channel] = scaleSample(sample, maxValue);
      rgba[pixelIndex * 4 + 3] = 255;
    }
  }

  const png = new PNG({ width, height });
  png.data = rgba;
  return PNG.sync.write(png);
}
