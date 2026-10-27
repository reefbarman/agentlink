import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { convertPpmToPng } from "./ppmToPng.js";

describe("convertPpmToPng", () => {
  it("converts P3 pixels, comments, and non-255 sample ranges", () => {
    const ppm = Buffer.from(
      "P3\n# two test pixels\n2 1\n15\n15 0 0\n0 8 15\n",
      "ascii",
    );

    const png = PNG.sync.read(convertPpmToPng(ppm));

    expect({ width: png.width, height: png.height }).toEqual({
      width: 2,
      height: 1,
    });
    expect([...png.data]).toEqual([255, 0, 0, 255, 0, 136, 255, 255]);
  });

  it("converts P6 without consuming whitespace-valued binary samples", () => {
    const header = Buffer.from("P6\n1 1\n255\n", "ascii");
    const ppm = Buffer.concat([header, Buffer.from([0x0a, 0x20, 0x23])]);

    const png = PNG.sync.read(convertPpmToPng(ppm));

    expect([...png.data]).toEqual([10, 32, 35, 255]);
  });

  it("converts 16-bit P6 samples stored in big-endian order", () => {
    const header = Buffer.from("P6\r\n1 1\r\n1023\r\n", "ascii");
    const ppm = Buffer.concat([
      header,
      Buffer.from([0x03, 0xff, 0x02, 0x00, 0x00, 0x00]),
    ]);

    const png = PNG.sync.read(convertPpmToPng(ppm));

    expect([...png.data]).toEqual([255, 128, 0, 255]);
  });

  it("rejects unsupported Netpbm variants", () => {
    expect(() => convertPpmToPng(Buffer.from("P5\n1 1\n255\n\0"))).toThrow(
      "Unsupported PPM format",
    );
  });

  it("rejects dimensions that would require an excessive decoded buffer", () => {
    expect(() =>
      convertPpmToPng(Buffer.from("P3\n10000 10000\n255\n", "ascii")),
    ).toThrow("PPM dimensions are too large");
  });

  it("rejects truncated binary pixel data", () => {
    expect(() =>
      convertPpmToPng(
        Buffer.concat([
          Buffer.from("P6\n1 1\n255\n", "ascii"),
          Buffer.from([255, 0]),
        ]),
      ),
    ).toThrow("expected 3 bytes, received 2");
  });
});
