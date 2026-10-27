import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { convertBmpToPng } from "./bmpToPng.js";

function create24BitBmp(width: number, height: number, pixels: Buffer): Buffer {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelSize = rowSize * height;
  const bmp = Buffer.alloc(54 + pixelSize);

  bmp.write("BM", 0, "ascii");
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(-height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(pixelSize, 34);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      const target = 54 + y * rowSize + x * 3;
      bmp[target] = pixels[source + 2];
      bmp[target + 1] = pixels[source + 1];
      bmp[target + 2] = pixels[source];
    }
  }

  return bmp;
}

describe("convertBmpToPng", () => {
  it("converts BMP pixels to an opaque PNG without swapping color channels", () => {
    const bmp = create24BitBmp(
      2,
      1,
      Buffer.from([255, 0, 0, 255, 0, 128, 255, 255]),
    );

    const png = PNG.sync.read(convertBmpToPng(bmp));

    expect({ width: png.width, height: png.height }).toEqual({
      width: 2,
      height: 1,
    });
    expect([...png.data]).toEqual([255, 0, 0, 255, 0, 128, 255, 255]);
  });

  it("rejects files without a Windows BMP header", () => {
    expect(() => convertBmpToPng(Buffer.from("not a bitmap"))).toThrow(
      "Invalid BMP file",
    );
  });

  it("rejects dimensions that would require an excessive decoded buffer", () => {
    const bmp = Buffer.alloc(54);
    bmp.write("BM", 0, "ascii");
    bmp.writeUInt32LE(54, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(10_000, 18);
    bmp.writeInt32LE(10_000, 22);

    expect(() => convertBmpToPng(bmp)).toThrow("BMP dimensions are too large");
  });
});
