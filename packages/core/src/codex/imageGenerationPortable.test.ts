import {
  buildCodexImageGenerationRequest,
  parseCodexImageGenerationEvent,
} from "./imageGenerationPortable.js";
import { describe, expect, it } from "vitest";

describe("buildCodexImageGenerationRequest", () => {
  it("builds the fixed OAuth body and places reference roles beside their images", () => {
    const imageURL = "data:image/png;base64,aGVsbG8=";
    expect(
      buildCodexImageGenerationRequest({
        prompt: "A small red house",
        imageModel: "gpt-image-2.5-sunburst",
        references: [{ label: "colour palette", imageURL }],
      }),
    ).toEqual({
      model: "gpt-5.6-sol",
      stream: true,
      store: false,
      instructions:
        "You are an image generation helper. Use the image_generation tool. Create exactly one PNG image. Do not add commentary.",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Create exactly one PNG image. A small red house",
            },
            {
              type: "input_text",
              text: "Reference image role: colour palette",
            },
            { type: "input_image", image_url: imageURL, detail: "auto" },
          ],
        },
      ],
      tools: [{ type: "image_generation", model: "gpt-image-2.5-sunburst" }],
      tool_choice: { type: "image_generation" },
    });
  });

  it("uses the default model and accepts the prompt and reference count boundaries", () => {
    expect(
      buildCodexImageGenerationRequest({ prompt: "x".repeat(16_000) }).tools[0]
        .model,
    ).toBe("gpt-image-2.5-flare");
    expect(
      buildCodexImageGenerationRequest({
        prompt: "x",
        references: Array.from({ length: 8 }, (_, index) => ({
          label: `reference ${index}`,
          imageURL: "data:image/webp;base64,aGVsbG8=",
        })),
      }).input[0].content,
    ).toHaveLength(17);
  });

  it.each([
    [{ prompt: "x".repeat(16_001) }],
    [
      {
        prompt: "x",
        references: Array.from({ length: 9 }, () => ({
          label: "x",
          imageURL: "data:image/png;base64,YQ==",
        })),
      },
    ],
    [
      {
        prompt: "x",
        references: [{ label: "x", imageURL: "https://example.com/image.png" }],
      },
    ],
    [
      {
        prompt: "x",
        references: [{ label: "x", imageURL: "data:image/gif;base64,YQ==" }],
      },
    ],
    [
      {
        prompt: "x",
        references: [
          { label: "x", imageURL: "data:image/png;base64,not base64" },
        ],
      },
    ],
    [{ prompt: "x", quality: "high" }],
    [{ prompt: "x", imageModel: "unsupported" }],
  ] as unknown[])("rejects invalid or unsupported input %#", (params) => {
    expect(() => buildCodexImageGenerationRequest(params as never)).toThrow();
  });
});

describe("parseCodexImageGenerationEvent", () => {
  it("keeps partial and final image events distinct without decoding their payload", () => {
    expect(
      parseCodexImageGenerationEvent({
        type: "response.image_generation_call.partial_image",
        partial_image_b64: "opaque-partial",
      }),
    ).toEqual({
      kind: "partial_image",
      base64: "opaque-partial",
      eventType: "response.image_generation_call.partial_image",
    });
    expect(
      parseCodexImageGenerationEvent({
        type: "response.image_generation_call.completed",
        result: "opaque-final",
      }),
    ).toEqual({
      kind: "final_image",
      base64: "opaque-final",
      eventType: "response.image_generation_call.completed",
      completionEvidence: false,
    });
  });

  it("reports completion evidence separately from image output", () => {
    expect(
      parseCodexImageGenerationEvent({
        type: "response.completed",
        response: { status: "completed" },
      }),
    ).toEqual({
      kind: "completed",
      eventType: "response.completed",
      completionEvidence: true,
      hasFinalImage: false,
    });
    expect(
      parseCodexImageGenerationEvent({
        type: "response.completed",
        response: {
          status: "completed",
          output: [{ type: "image_generation_call", result: "final" }],
        },
      }),
    ).toEqual({
      kind: "final_image",
      base64: "final",
      eventType: "response.completed",
      completionEvidence: true,
    });
  });

  it("never treats failed or incomplete image-bearing events as completion", () => {
    expect(
      parseCodexImageGenerationEvent({
        type: "response.failed",
        item: { type: "image_generation_call", result: "image" },
        response: { status: "failed" },
      }).kind,
    ).toBe("provider_error");
    expect(
      parseCodexImageGenerationEvent({
        type: "response.completed",
        response: {
          status: "incomplete",
          output: [{ type: "image_generation_call", result: "image" }],
        },
      }).kind,
    ).toBe("incomplete");
    expect(
      parseCodexImageGenerationEvent({
        type: "response.completed",
        response: {
          output: [{ type: "image_generation_call", result: "image" }],
        },
      }).kind,
    ).toBe("incomplete");
    expect(() => buildCodexImageGenerationRequest({ prompt: " " })).toThrow();
    expect(() =>
      buildCodexImageGenerationRequest({
        prompt: "x",
        references: [
          { label: "a".repeat(301), imageURL: "data:image/png;base64,YQ==" },
        ],
      }),
    ).toThrow();
  });

  it.each([
    [
      { type: "response.refusal.delta", delta: "not allowed" },
      {
        kind: "refusal",
        eventType: "response.refusal.delta",
        message: "not allowed",
      },
    ],
    [
      {
        type: "response.failed",
        response: { error: { code: "bad_request", message: "failed" } },
      },
      {
        kind: "provider_error",
        eventType: "response.failed",
        code: "bad_request",
        message: "failed",
      },
    ],
    [
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        },
      },
      {
        kind: "incomplete",
        eventType: "response.incomplete",
        reason: "max_output_tokens",
      },
    ],
    [null, { kind: "other" }],
  ])("classifies terminal event fixtures", (event, expected) => {
    expect(parseCodexImageGenerationEvent(event)).toEqual(expected);
  });
});
