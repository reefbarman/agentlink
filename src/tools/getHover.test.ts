import { describe, expect, it, vi } from "vitest";

import type { ToolResult } from "../shared/types.js";
import { handleGetHover } from "./getHover.js";

function textPayload(result: ToolResult) {
  return JSON.parse((result.content[0] as { type: "text"; text: string }).text);
}

const params = {
  path: "src/file.ts",
  line: 2,
  column: 3,
};

describe("handleGetHover", () => {
  it("returns an explicit unavailable result when no hover provider is supplied", async () => {
    const result = await handleGetHover(params, "session-1");

    expect(textPayload(result)).toEqual({
      error:
        "Language hover is unavailable in this runtime. Provide a LanguageHoverProvider to enable get_hover.",
      path: "src/file.ts",
      line: 2,
      column: 3,
    });
  });

  it("delegates hover params to the provider", async () => {
    const getHover = vi.fn(async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
    }));

    const result = await handleGetHover(params, "session-1", {
      hoverProvider: { getHover },
    });

    expect(textPayload(result)).toEqual({ ok: true });
    expect(getHover).toHaveBeenCalledWith({
      path: "src/file.ts",
      line: 2,
      column: 3,
      sessionId: "session-1",
    });
  });

  it("wraps provider errors in the legacy JSON error shape", async () => {
    const getHover = vi.fn(async () => {
      throw new Error("bad hover lookup");
    });

    const result = await handleGetHover(params, "session-1", {
      hoverProvider: { getHover },
    });

    expect(textPayload(result)).toEqual({
      error: "bad hover lookup",
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
    const getHover = vi.fn(async () => {
      throw rejectedResult;
    });

    const result = await handleGetHover(params, "session-1", {
      hoverProvider: { getHover },
    });

    expect(result).toBe(rejectedResult);
  });
});
