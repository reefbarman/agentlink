import { describe, expect, it, vi } from "vitest";

import type { ToolResult } from "../shared/types.js";
import { handleGoToDefinition } from "./goToDefinition.js";
import { handleGoToImplementation } from "./goToImplementation.js";
import { handleGoToTypeDefinition } from "./goToTypeDefinition.js";

function textPayload(result: ToolResult) {
  return JSON.parse((result.content[0] as { type: "text"; text: string }).text);
}

const params = { path: "src/file.ts", line: 2, column: 3 };

describe("language navigation handlers", () => {
  it("returns explicit unavailable results when no navigation provider is supplied", async () => {
    await expect(handleGoToDefinition(params, "session-1")).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error:
              "Language navigation is unavailable in this runtime. Provide a LanguageNavigationProvider to enable go_to_definition.",
            path: "src/file.ts",
            line: 2,
            column: 3,
          }),
        },
      ],
    });

    await expect(
      handleGoToImplementation(params, "session-1"),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error:
              "Language navigation is unavailable in this runtime. Provide a LanguageNavigationProvider to enable go_to_implementation.",
            path: "src/file.ts",
            line: 2,
            column: 3,
          }),
        },
      ],
    });

    await expect(
      handleGoToTypeDefinition(params, "session-1"),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error:
              "Language navigation is unavailable in this runtime. Provide a LanguageNavigationProvider to enable go_to_type_definition.",
            path: "src/file.ts",
            line: 2,
            column: 3,
          }),
        },
      ],
    });
  });

  it("delegates definition params to the navigation provider", async () => {
    const goToDefinition = vi.fn(async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
    }));

    const result = await handleGoToDefinition(params, "session-1", {
      navigationProvider: {
        goToDefinition,
        goToImplementation: vi.fn(),
        goToTypeDefinition: vi.fn(),
      },
    });

    expect(textPayload(result)).toEqual({ ok: true });
    expect(goToDefinition).toHaveBeenCalledWith({
      path: "src/file.ts",
      line: 2,
      column: 3,
      sessionId: "session-1",
    });
  });

  it("delegates implementation params to the navigation provider", async () => {
    const goToImplementation = vi.fn(async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
    }));

    const result = await handleGoToImplementation(params, "session-1", {
      navigationProvider: {
        goToDefinition: vi.fn(),
        goToImplementation,
        goToTypeDefinition: vi.fn(),
      },
    });

    expect(textPayload(result)).toEqual({ ok: true });
    expect(goToImplementation).toHaveBeenCalledWith({
      path: "src/file.ts",
      line: 2,
      column: 3,
      sessionId: "session-1",
    });
  });

  it("delegates type-definition params to the navigation provider", async () => {
    const goToTypeDefinition = vi.fn(async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
    }));

    const result = await handleGoToTypeDefinition(params, "session-1", {
      navigationProvider: {
        goToDefinition: vi.fn(),
        goToImplementation: vi.fn(),
        goToTypeDefinition,
      },
    });

    expect(textPayload(result)).toEqual({ ok: true });
    expect(goToTypeDefinition).toHaveBeenCalledWith({
      path: "src/file.ts",
      line: 2,
      column: 3,
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
    const goToDefinition = vi.fn(async () => {
      throw rejectedResult;
    });

    const result = await handleGoToDefinition(params, "session-1", {
      navigationProvider: {
        goToDefinition,
        goToImplementation: vi.fn(),
        goToTypeDefinition: vi.fn(),
      },
    });

    expect(result).toBe(rejectedResult);
  });
});
