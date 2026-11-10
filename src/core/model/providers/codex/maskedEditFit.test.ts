import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import {
  applyCodexMaskComposite,
  assertCodexMaskCompositeSupported,
  type CodexGeneratedImage,
  type CodexImageReferenceImage,
} from "./imageGeneration.js";
import { fitMaskedEditImage, resizeRgba } from "./maskedEditFit.js";

function solidPng(
  width: number,
  height: number,
  rgba: [number, number, number, number],
  transparentHole?: { x0: number; y0: number; x1: number; y1: number },
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const inHole =
        transparentHole &&
        x >= transparentHole.x0 &&
        x < transparentHole.x1 &&
        y >= transparentHole.y0 &&
        y < transparentHole.y1;
      png.data[offset] = rgba[0];
      png.data[offset + 1] = rgba[1];
      png.data[offset + 2] = rgba[2];
      png.data[offset + 3] = inHole ? 0 : rgba[3];
    }
  }
  return PNG.sync.write(png);
}

function pixel(png: PNG, x: number, y: number): number[] {
  const offset = (y * png.width + x) * 4;
  return Array.from(png.data.subarray(offset, offset + 4));
}

function reference(id: string, png: Buffer): CodexImageReferenceImage {
  return {
    id,
    label: id,
    mimeType: "image/png",
    base64: png.toString("base64"),
    source: "session",
  };
}

describe("resizeRgba", () => {
  it("area-averages when downscaling", () => {
    const source = Uint8Array.from([
      0, 0, 0, 255, 200, 200, 200, 255, 0, 0, 0, 255, 200, 200, 200, 255,
    ]);
    expect(Array.from(resizeRgba(source, 2, 2, 1, 1))).toEqual([
      100, 100, 100, 255,
    ]);
  });

  it("ignores the colour of fully transparent pixels", () => {
    const source = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 0]);
    expect(Array.from(resizeRgba(source, 2, 1, 1, 1))).toEqual([
      255, 0, 0, 128,
    ]);
  });

  it("upscales to the requested dimensions", () => {
    const source = Uint8Array.from([10, 20, 30, 255]);
    const resized = resizeRgba(source, 1, 1, 3, 2);
    expect(resized.byteLength).toBe(3 * 2 * 4);
    expect(Array.from(resized.subarray(0, 4))).toEqual([10, 20, 30, 255]);
  });
});

describe("fitMaskedEditImage", () => {
  it("resizes to the edit target and keeps unmasked pixels identical", () => {
    const edit = solidPng(32, 32, [20, 120, 40, 255]);
    const mask = solidPng(32, 32, [0, 0, 0, 255], {
      x0: 8,
      y0: 8,
      x1: 24,
      y1: 24,
    });
    const generated = solidPng(48, 48, [250, 240, 10, 255]);

    const fitted = fitMaskedEditImage({
      generatedPng: generated,
      editPng: edit,
      maskPng: mask,
      featherPx: 2,
    });
    const output = PNG.sync.read(fitted.png);

    expect(fitted).toMatchObject({
      width: 32,
      height: 32,
      providerWidth: 48,
      providerHeight: 48,
    });
    for (const [x, y] of [
      [0, 0],
      [7, 16],
      [31, 31],
      [24, 24],
    ]) {
      expect(pixel(output, x!, y!)).toEqual([20, 120, 40, 255]);
    }
    expect(pixel(output, 16, 16)).toEqual([250, 240, 10, 255]);
    // The seam is feathered inward: the first masked pixel is a blend.
    const seam = pixel(output, 8, 16);
    expect(seam[0]).toBeGreaterThan(20);
    expect(seam[0]).toBeLessThan(250);
  });
});

describe("applyCodexMaskComposite", () => {
  const edit = reference("edit", solidPng(16, 16, [0, 0, 255, 255]));
  const mask = reference(
    "mask",
    solidPng(16, 16, [0, 0, 0, 255], { x0: 4, y0: 4, x1: 12, y1: 12 }),
  );
  const generatedPng = solidPng(24, 24, [255, 0, 0, 255]);
  const generated = (): CodexGeneratedImage => ({
    bytes: generatedPng.byteLength,
    mimeType: "image/png",
    base64: generatedPng.toString("base64"),
    size: "24x24",
    event_type: "response.image_generation_call.completed",
  });

  it("fits PNG results and reports the provider size", () => {
    const images = [generated()];
    applyCodexMaskComposite({
      images,
      editImage: edit,
      options: { maskImage: mask },
    });
    expect(images[0]).toMatchObject({
      size: "16x16",
      provider_size: "24x24",
      mask_composite: "applied",
      mimeType: "image/png",
    });
    expect(PNG.sync.read(Buffer.from(images[0]!.base64, "base64")).width).toBe(
      16,
    );
  });

  it("leaves raw output when disabled", () => {
    const images = [generated()];
    applyCodexMaskComposite({
      images,
      editImage: edit,
      options: { maskImage: mask, maskComposite: false },
    });
    expect(images[0]).toEqual(generated());
  });

  it("keeps non-PNG output and reports why it was skipped", () => {
    const images = [{ ...generated(), mimeType: "image/webp" }];
    applyCodexMaskComposite({
      images,
      editImage: edit,
      options: { maskImage: mask },
    });
    expect(images[0]).toMatchObject({
      size: "24x24",
      mask_composite: "skipped",
      mask_composite_reason: "requires PNG output",
    });
  });
});

describe("assertCodexMaskCompositeSupported", () => {
  const mask = reference("mask", solidPng(1, 1, [0, 0, 0, 255]));

  it("rejects an explicit composite with non-PNG output", () => {
    expect(() =>
      assertCodexMaskCompositeSupported({
        maskImage: mask,
        maskComposite: true,
        outputFormat: "webp",
      }),
    ).toThrow("mask_composite requires PNG output");
  });

  it("rejects mask_composite without a mask", () => {
    expect(() =>
      assertCodexMaskCompositeSupported({
        maskImage: undefined,
        maskComposite: false,
        outputFormat: undefined,
      }),
    ).toThrow("mask_composite requires a mask image");
  });

  it("allows the default with any output format", () => {
    expect(() =>
      assertCodexMaskCompositeSupported({
        maskImage: mask,
        maskComposite: undefined,
        outputFormat: "jpeg",
      }),
    ).not.toThrow();
  });
});
