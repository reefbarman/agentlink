import { PNG } from "pngjs";

/**
 * Image backends return masked edits at their own canonical size (for
 * example 1254x1254 for any square input on the ChatGPT backend) and
 * re-render every pixel, so colours outside the mask drift. These helpers fit
 * a generated PNG back onto the edit target: resample to the target's exact
 * dimensions, then restore the original pixels wherever the mask is opaque,
 * feathering a few pixels inward so the seam blends.
 */

interface AxisTap {
  index: number;
  weight: number;
}

function axisTaps(sourceLength: number, targetLength: number): AxisTap[][] {
  const scale = sourceLength / targetLength;
  const taps: AxisTap[][] = [];
  for (let target = 0; target < targetLength; target++) {
    if (scale > 1) {
      // Downscale: area-average the source span this pixel covers.
      const start = target * scale;
      const end = start + scale;
      const row: AxisTap[] = [];
      for (let index = Math.floor(start); index < Math.ceil(end); index++) {
        const overlap = Math.min(end, index + 1) - Math.max(start, index);
        if (overlap > 0 && index < sourceLength) {
          row.push({ index, weight: overlap / scale });
        }
      }
      taps.push(row);
    } else {
      // Upscale or same size: bilinear between the two nearest centres.
      const position = Math.min(
        Math.max((target + 0.5) * scale - 0.5, 0),
        sourceLength - 1,
      );
      const lower = Math.floor(position);
      const fraction = position - lower;
      const upper = Math.min(lower + 1, sourceLength - 1);
      taps.push(
        fraction === 0 || upper === lower
          ? [{ index: lower, weight: 1 }]
          : [
              { index: lower, weight: 1 - fraction },
              { index: upper, weight: fraction },
            ],
      );
    }
  }
  return taps;
}

/** Resample straight-alpha RGBA pixels, weighting colour by alpha. */
export function resizeRgba(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Buffer {
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) {
    return Buffer.from(source);
  }
  const horizontal = axisTaps(sourceWidth, targetWidth);
  const vertical = axisTaps(sourceHeight, targetHeight);
  // Horizontal pass into premultiplied floats.
  const intermediate = new Float64Array(targetWidth * sourceHeight * 4);
  for (let y = 0; y < sourceHeight; y++) {
    for (let x = 0; x < targetWidth; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const tap of horizontal[x]!) {
        const offset = (y * sourceWidth + tap.index) * 4;
        const alpha = source[offset + 3]! * tap.weight;
        r += source[offset]! * alpha;
        g += source[offset + 1]! * alpha;
        b += source[offset + 2]! * alpha;
        a += alpha;
      }
      const out = (y * targetWidth + x) * 4;
      intermediate[out] = r;
      intermediate[out + 1] = g;
      intermediate[out + 2] = b;
      intermediate[out + 3] = a;
    }
  }
  const result = Buffer.alloc(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < targetWidth; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const tap of vertical[y]!) {
        const offset = (tap.index * targetWidth + x) * 4;
        r += intermediate[offset]! * tap.weight;
        g += intermediate[offset + 1]! * tap.weight;
        b += intermediate[offset + 2]! * tap.weight;
        a += intermediate[offset + 3]! * tap.weight;
      }
      const out = (y * targetWidth + x) * 4;
      if (a > 0) {
        result[out] = clampByte(r / a);
        result[out + 1] = clampByte(g / a);
        result[out + 2] = clampByte(b / a);
      }
      result[out + 3] = clampByte(a);
    }
  }
  return result;
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function boxBlur(
  values: Float64Array,
  width: number,
  height: number,
  radius: number,
): Float64Array {
  if (radius <= 0) return values;
  const horizontal = new Float64Array(values.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const sx = Math.min(width - 1, Math.max(0, x + dx));
        sum += values[y * width + sx]!;
        count++;
      }
      horizontal[y * width + x] = sum / count;
    }
  }
  const result = new Float64Array(values.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = Math.min(height - 1, Math.max(0, y + dy));
        sum += horizontal[sy * width + x]!;
        count++;
      }
      result[y * width + x] = sum / count;
    }
  }
  return result;
}

export interface MaskedEditFitResult {
  png: Buffer;
  width: number;
  height: number;
  providerWidth: number;
  providerHeight: number;
}

/**
 * Fit a generated PNG onto the edit target. Mask alpha 255 keeps the original
 * pixel exactly; alpha 0 takes the generated pixel. The seam is feathered
 * inward only, so pixels the mask protects stay byte-identical.
 */
export function fitMaskedEditImage(params: {
  generatedPng: Buffer;
  editPng: Buffer;
  maskPng: Buffer;
  featherPx?: number;
}): MaskedEditFitResult {
  const generated = PNG.sync.read(params.generatedPng);
  const edit = PNG.sync.read(params.editPng);
  const mask = PNG.sync.read(params.maskPng);
  const { width, height } = edit;
  if (mask.width !== width || mask.height !== height) {
    throw new Error("edit target and mask must have matching dimensions");
  }
  const resized = resizeRgba(
    generated.data,
    generated.width,
    generated.height,
    width,
    height,
  );
  const maskAlpha = new Float64Array(width * height);
  for (let index = 0; index < maskAlpha.length; index++) {
    maskAlpha[index] = mask.data[index * 4 + 3]! / 255;
  }
  const featherPx =
    params.featherPx ?? Math.max(2, Math.round(Math.min(width, height) / 256));
  const feathered = boxBlur(maskAlpha, width, height, featherPx);
  const output = new PNG({ width, height });
  for (let index = 0; index < maskAlpha.length; index++) {
    const keep = Math.max(maskAlpha[index]!, feathered[index]!);
    const offset = index * 4;
    for (let channel = 0; channel < 4; channel++) {
      const original = edit.data[offset + channel]!;
      output.data[offset + channel] =
        keep >= 1
          ? original
          : clampByte(
              keep * original + (1 - keep) * resized[offset + channel]!,
            );
    }
  }
  return {
    png: PNG.sync.write(output),
    width,
    height,
    providerWidth: generated.width,
    providerHeight: generated.height,
  };
}
