import { describe, expect, it, vi } from "vitest";

import type { ToolResult } from "../shared/types.js";
import { handleGetSymbols } from "./getSymbols.js";

function textResult(result: ToolResult) {
  return (result.content[0] as { type: "text"; text: string }).text;
}

function textPayload(result: ToolResult) {
  return JSON.parse(textResult(result));
}

describe("handleGetSymbols", () => {
  it("returns an explicit unavailable result when no symbols provider is supplied", async () => {
    const result = await handleGetSymbols({ path: "src/file.ts" }, "session-1");

    expect(textPayload(result)).toEqual({
      error:
        "Language symbols are unavailable in this runtime. Provide a LanguageSymbolsProvider to enable get_symbols.",
      path: "src/file.ts",
    });
    expect(textResult(result)).not.toContain("query");
  });

  it("delegates symbols params to the provider", async () => {
    const getSymbols = vi.fn(async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
    }));

    const result = await handleGetSymbols({ query: "Example" }, "session-1", {
      symbolsProvider: { getSymbols },
    });

    expect(textPayload(result)).toEqual({ ok: true });
    expect(getSymbols).toHaveBeenCalledWith({
      query: "Example",
      sessionId: "session-1",
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
    const getSymbols = vi.fn(async () => {
      throw rejectedResult;
    });

    const result = await handleGetSymbols(
      { path: "src/file.ts" },
      "session-1",
      { symbolsProvider: { getSymbols } },
    );

    expect(result).toBe(rejectedResult);
  });

  it("wraps provider errors in the legacy JSON error shape", async () => {
    const getSymbols = vi.fn(async () => {
      throw new Error("symbol failure");
    });

    const result = await handleGetSymbols({ query: "Example" }, "session-1", {
      symbolsProvider: { getSymbols },
    });

    expect(textPayload(result)).toEqual({ error: "symbol failure" });
  });
});
