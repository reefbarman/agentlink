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

  it("reports the served tool and warns when the backend replaced the model", () => {
    const fields = imageGenerationOptionMismatchFields(
      { maskImage: {} as never },
      [{ size: "1254x1254" }],
      {
        requestedImageModel: "gpt-image-2.6-flare",
        tool: { model: "gpt-image-2-codex", size: "auto" },
      },
    );
    expect(fields.served_image_tool).toEqual({
      model: "gpt-image-2-codex",
      size: "auto",
    });
    expect(fields.option_mismatches).toBeUndefined();
    expect(fields.warning).toContain(
      "served gpt-image-2-codex with size auto instead of gpt-image-2.6-flare",
    );
    expect(fields.warning).toContain("The mask was sent");
    expect(fields.warning).not.toContain("complexity low");
  });

  it("warns that complexity had no effect when the backend replaced the model", () => {
    const fields = imageGenerationOptionMismatchFields(
      { complexity: "low" },
      [{}],
      {
        requestedImageModel: "gpt-image-2.6-flare",
        tool: { model: "gpt-image-2-codex" },
      },
    );
    expect(fields.warning).toContain(
      "The complexity low was sent but has no effect on this backend.",
    );
  });

  it("reports the served tool without a warning when the model matches", () => {
    expect(
      imageGenerationOptionMismatchFields({}, [{}], {
        requestedImageModel: "gpt-image-2.6-flare",
        tool: { model: "gpt-image-2.6-flare", size: "1024x1024" },
      }),
    ).toEqual({
      served_image_tool: { model: "gpt-image-2.6-flare", size: "1024x1024" },
    });
  });

  it("warns when a transparent background was returned but not requested", () => {
    for (const background of [undefined, "opaque"] as const) {
      const fields = imageGenerationOptionMismatchFields({ background }, [
        { background: "opaque" },
        { background: "transparent" },
      ]);
      expect(fields.option_mismatches).toEqual([
        {
          image_index: 1,
          option: "background",
          requested: background ?? "unset",
          actual: "transparent",
        },
      ]);
      expect(fields.warning).toContain(
        "transparent background for image 1 although transparency was not requested",
      );
      expect(fields.warning).toContain('background: "opaque"');
      expect(fields.warning).not.toContain("did not honour every");
    }
  });

  it("stays silent about transparency that was requested, auto, or unreported", () => {
    for (const background of ["transparent", "auto"] as const) {
      expect(
        imageGenerationOptionMismatchFields({ background }, [
          { background: "transparent" },
        ]),
      ).toEqual({});
    }
    expect(imageGenerationOptionMismatchFields({}, [{}])).toEqual({});
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
