import { describe, expect, it, vi } from "vitest";

import type { ToolResult } from "../shared/types.js";
import { handleGetReferences } from "./getReferences.js";

function textPayload(result: ToolResult) {
  return JSON.parse((result.content[0] as { type: "text"; text: string }).text);
}

const params = {
  path: "src/file.ts",
  line: 2,
  column: 3,
  include_declaration: false,
};

describe("handleGetReferences", () => {
  it("returns an explicit unavailable result when no references provider is supplied", async () => {
    const result = await handleGetReferences(params, "session-1");

    expect(textPayload(result)).toEqual({
      error:
        "Language references are unavailable in this runtime. Provide a LanguageReferencesProvider to enable get_references.",
      path: "src/file.ts",
      line: 2,
      column: 3,
    });
  });

  it("delegates references params to the provider", async () => {
    const getReferences = vi.fn(async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
    }));

    const result = await handleGetReferences(params, "session-1", {
      referencesProvider: { getReferences },
    });

    expect(textPayload(result)).toEqual({ ok: true });
    expect(getReferences).toHaveBeenCalledWith({
      path: "src/file.ts",
      line: 2,
      column: 3,
      include_declaration: false,
      sessionId: "session-1",
    });
  });

  it("wraps provider errors in the legacy JSON error shape", async () => {
    const getReferences = vi.fn(async () => {
      throw new Error("bad reference lookup");
    });

    const result = await handleGetReferences(params, "session-1", {
      referencesProvider: { getReferences },
    });

    expect(textPayload(result)).toEqual({
      error: "bad reference lookup",
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
    const getReferences = vi.fn(async () => {
      throw rejectedResult;
    });

    const result = await handleGetReferences(params, "session-1", {
      referencesProvider: { getReferences },
    });

    expect(result).toBe(rejectedResult);
  });
});
