import { describe, expect, it } from "vitest";
import {
  imageGenerationOptionMismatchFields,
  imageGenerationOptionMismatches,
} from "./imageGenerationOptionMismatch.js";

describe("imageGenerationOptionMismatches", () => {
  it("reports size and quality the backend did not honour", () => {
    expect(
      imageGenerationOptionMismatchFields(
        { outputSize: "2560x1440", quality: "high" },
        [
          { size: "1677x938", quality: "medium" },
          { size: "2560x1440", quality: "high" },
        ],
      ),
    ).toEqual({
      option_mismatches: [
        {
          image_index: 0,
          option: "output_size",
          requested: "2560x1440",
          actual: "1677x938",
        },
        {
          image_index: 0,
          option: "quality",
          requested: "high",
          actual: "medium",
        },
      ],
      warning: expect.stringContaining(
        "output_size requested 2560x1440, returned 1677x938; quality requested high, returned medium",
      ),
    });
  });

  it("stays silent when options match, are auto, or are not reported", () => {
    expect(
      imageGenerationOptionMismatchFields(
        { outputSize: "1536x1024", quality: "high" },
        [{ size: "1536x1024", quality: "high" }, {}],
      ),
    ).toEqual({});
    expect(
      imageGenerationOptionMismatches({ quality: "auto" }, [
        { size: "1024x1024", quality: "medium" },
      ]),
    ).toEqual([]);
    expect(
      imageGenerationOptionMismatches({}, [{ size: "1024x1024" }]),
    ).toEqual([]);
  });
});
