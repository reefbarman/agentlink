import { describe, expect, it, vi } from "vitest";

import type { ToolResult } from "../shared/types.js";
import { handleGetTypeHierarchy } from "./getTypeHierarchy.js";

function textPayload(result: ToolResult) {
  return JSON.parse((result.content[0] as { type: "text"; text: string }).text);
}

const params = {
  path: "src/file.ts",
  line: 2,
  column: 3,
  direction: "both",
  max_depth: 2,
};

describe("handleGetTypeHierarchy", () => {
  it("returns an explicit unavailable result when no hierarchy provider is supplied", async () => {
    const result = await handleGetTypeHierarchy(params, "session-1");

    expect(textPayload(result)).toEqual({
      error:
        "Language type hierarchy is unavailable in this runtime. Provide a LanguageHierarchyProvider to enable get_type_hierarchy.",
      path: "src/file.ts",
      line: 2,
      column: 3,
    });
  });

  it("delegates type hierarchy params to the provider", async () => {
    const getTypeHierarchy = vi.fn(async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
    }));

    const result = await handleGetTypeHierarchy(params, "session-1", {
      hierarchyProvider: { getCallHierarchy: vi.fn(), getTypeHierarchy },
    });

    expect(textPayload(result)).toEqual({ ok: true });
    expect(getTypeHierarchy).toHaveBeenCalledWith({
      path: "src/file.ts",
      line: 2,
      column: 3,
      direction: "both",
      max_depth: 2,
      sessionId: "session-1",
    });
  });

  it("wraps provider errors in the legacy JSON error shape", async () => {
    const getTypeHierarchy = vi.fn(async () => {
      throw new Error("bad type hierarchy lookup");
    });

    const result = await handleGetTypeHierarchy(params, "session-1", {
      hierarchyProvider: { getCallHierarchy: vi.fn(), getTypeHierarchy },
    });

    expect(textPayload(result)).toEqual({
      error: "bad type hierarchy lookup",
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
    const getTypeHierarchy = vi.fn(async () => {
      throw rejectedResult;
    });

    const result = await handleGetTypeHierarchy(params, "session-1", {
      hierarchyProvider: { getCallHierarchy: vi.fn(), getTypeHierarchy },
    });

    expect(result).toBe(rejectedResult);
  });
});
