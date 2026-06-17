import { describe, expect, it, vi } from "vitest";

import type { ToolResult } from "../shared/types.js";
import { handleGetCompletions } from "./getCompletions.js";

function textPayload(result: ToolResult) {
  return JSON.parse((result.content[0] as { type: "text"; text: string }).text);
}

const params = {
  path: "src/file.ts",
  line: 2,
  column: 3,
  limit: 5,
};

describe("handleGetCompletions", () => {
  it("returns an explicit unavailable result when no completions provider is supplied", async () => {
    const result = await handleGetCompletions(params, "session-1");

    expect(textPayload(result)).toEqual({
      error:
        "Language completions are unavailable in this runtime. Provide a LanguageCompletionsProvider to enable get_completions.",
      path: "src/file.ts",
      line: 2,
      column: 3,
    });
  });

  it("delegates completion params to the provider", async () => {
    const getCompletions = vi.fn(async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
    }));

    const result = await handleGetCompletions(params, "session-1", {
      completionsProvider: { getCompletions },
    });

    expect(textPayload(result)).toEqual({ ok: true });
    expect(getCompletions).toHaveBeenCalledWith({
      path: "src/file.ts",
      line: 2,
      column: 3,
      limit: 5,
      sessionId: "session-1",
    });
  });

  it("wraps provider errors in the legacy JSON error shape", async () => {
    const getCompletions = vi.fn(async () => {
      throw new Error("bad completions lookup");
    });

    const result = await handleGetCompletions(params, "session-1", {
      completionsProvider: { getCompletions },
    });

    expect(textPayload(result)).toEqual({
      error: "bad completions lookup",
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
    const getCompletions = vi.fn(async () => {
      throw rejectedResult;
    });

    const result = await handleGetCompletions(params, "session-1", {
      completionsProvider: { getCompletions },
    });

    expect(result).toBe(rejectedResult);
  });
});
