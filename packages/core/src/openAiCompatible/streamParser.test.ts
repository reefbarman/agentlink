import { describe, expect, it } from "vitest";

import { estimateOpenAiCompatibleInputTokens } from "./streamParser.js";

describe("estimateOpenAiCompatibleInputTokens", () => {
  it("counts an inline image at a bounded per-image cost, not as base64 text", () => {
    const text = { type: "text", text: "what is in this screenshot?" };
    const withoutImage = estimateOpenAiCompatibleInputTokens({
      messages: [{ role: "user", content: [text] }],
    });
    const withImage = estimateOpenAiCompatibleInputTokens({
      messages: [
        {
          role: "user",
          content: [
            text,
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${"A".repeat(1_000_000)}`,
              },
            },
          ],
        },
      ],
    });

    expect(withImage - withoutImage).toBeGreaterThan(1_000);
    expect(withImage - withoutImage).toBeLessThan(2_000);
  });

  it("still estimates ordinary text from its serialized length", () => {
    expect(
      estimateOpenAiCompatibleInputTokens({ text: "x".repeat(4_000) }),
    ).toBeGreaterThanOrEqual(1_000);
  });
});
