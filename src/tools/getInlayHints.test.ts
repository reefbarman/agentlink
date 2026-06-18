import { describe, expect, it, vi } from "vitest";

import type { ToolResult } from "../shared/types.js";
import { handleGetInlayHints } from "./getInlayHints.js";

function textPayload(result: ToolResult) {
  return JSON.parse((result.content[0] as { type: "text"; text: string }).text);
}

const params = {
  path: "src/file.ts",
  start_line: 2,
  end_line: 5,
};

describe("handleGetInlayHints", () => {
  it("returns an explicit unavailable result when no inlay-hints provider is supplied", async () => {
    const result = await handleGetInlayHints(params, "session-1");

    expect(textPayload(result)).toEqual({
      error:
        "Language inlay hints are unavailable in this runtime. Provide a LanguageInlayHintsProvider to enable get_inlay_hints.",
      path: "src/file.ts",
      start_line: 2,
      end_line: 5,
    });
  });

  it("delegates inlay-hints params to the provider", async () => {
    const getInlayHints = vi.fn(async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
    }));

    const result = await handleGetInlayHints(params, "session-1", {
      inlayHintsProvider: { getInlayHints },
    });

    expect(textPayload(result)).toEqual({ ok: true });
    expect(getInlayHints).toHaveBeenCalledWith({
      path: "src/file.ts",
      start_line: 2,
      end_line: 5,
      sessionId: "session-1",
    });
  });

  it("wraps provider errors in the legacy JSON error shape", async () => {
    const getInlayHints = vi.fn(async () => {
      throw new Error("bad inlay lookup");
    });

    const result = await handleGetInlayHints(params, "session-1", {
      inlayHintsProvider: { getInlayHints },
    });

    expect(textPayload(result)).toEqual({
      error: "bad inlay lookup",
      path: "src/file.ts",
    });
  });

  it("preserves ToolResult rejections from providers", async () => {
    const rejectedResult = {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ status: "rejected", path: "src/file.ts" }),
        },
      ],
    };
    const getInlayHints = vi.fn(async () => {
      throw rejectedResult;
    });

    const result = await handleGetInlayHints(params, "session-1", {
      inlayHintsProvider: { getInlayHints },
    });

    expect(result).toBe(rejectedResult);
  });
});
