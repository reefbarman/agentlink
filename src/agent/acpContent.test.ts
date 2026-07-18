import { describe, expect, it } from "vitest";

import { convertAcpContentBlock } from "./acpContent.js";

describe("ACP content conversion", () => {
  it("converts image content into persisted model image blocks", () => {
    expect(
      convertAcpContentBlock({
        type: "image",
        mimeType: "image/png",
        data: "YWJjZA==",
      }),
    ).toEqual({
      content: {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "YWJjZA==",
        },
      },
    });
  });

  it("returns visible warnings for unsupported or malformed images", () => {
    expect(
      convertAcpContentBlock({
        type: "image",
        mimeType: "image/svg+xml",
        data: "YWJjZA==",
      }),
    ).toEqual({
      warning: "[ACP image omitted: unsupported MIME type image/svg+xml]",
    });
    expect(
      convertAcpContentBlock({
        type: "image",
        mimeType: "image/png",
        data: "not base64!",
      }),
    ).toEqual({ warning: "[ACP image omitted: invalid base64 data]" });
  });
});
