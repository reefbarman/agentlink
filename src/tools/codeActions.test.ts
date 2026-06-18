import { describe, expect, it, vi } from "vitest";
import { handleApplyCodeAction, handleGetCodeActions } from "./codeActions.js";

import type { ToolResult } from "../shared/types.js";

function textPayload(result: ToolResult) {
  return JSON.parse((result.content[0] as { type: "text"; text: string }).text);
}

const params = {
  path: "src/file.ts",
  line: 2,
  column: 3,
  end_line: 4,
  end_column: 5,
  kind: "quickfix",
  only_preferred: true,
};

describe("handleGetCodeActions", () => {
  it("returns an explicit unavailable result when no code-actions provider is supplied", async () => {
    const result = await handleGetCodeActions(params, "session-1");

    expect(textPayload(result)).toEqual({
      error:
        "Language code actions are unavailable in this runtime. Provide a LanguageCodeActionsProvider to enable get_code_actions.",
      path: "src/file.ts",
      line: 2,
      column: 3,
    });
  });

  it("delegates code-action params to the provider", async () => {
    const getCodeActions = vi.fn(async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
    }));
    const applyCodeAction = vi.fn();

    const result = await handleGetCodeActions(params, "session-1", {
      codeActionsProvider: { getCodeActions, applyCodeAction },
    });

    expect(textPayload(result)).toEqual({ ok: true });
    expect(getCodeActions).toHaveBeenCalledWith({
      path: "src/file.ts",
      line: 2,
      column: 3,
      end_line: 4,
      end_column: 5,
      kind: "quickfix",
      only_preferred: true,
      sessionId: "session-1",
    });
  });

  it("wraps provider errors in the legacy JSON error shape", async () => {
    const getCodeActions = vi.fn(async () => {
      throw new Error("bad code action lookup");
    });
    const applyCodeAction = vi.fn();

    const result = await handleGetCodeActions(params, "session-1", {
      codeActionsProvider: { getCodeActions, applyCodeAction },
    });

    expect(textPayload(result)).toEqual({
      error: "bad code action lookup",
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
    const getCodeActions = vi.fn(async () => {
      throw rejectedResult;
    });
    const applyCodeAction = vi.fn();

    const result = await handleGetCodeActions(params, "session-1", {
      codeActionsProvider: { getCodeActions, applyCodeAction },
    });

    expect(result).toBe(rejectedResult);
  });
});

describe("handleApplyCodeAction", () => {
  it("returns an explicit unavailable result when no code-actions provider is supplied", async () => {
    const result = await handleApplyCodeAction({ index: 0 }, "session-1");

    expect(textPayload(result)).toEqual({
      error:
        "Language code-action apply is unavailable in this runtime. Provide a LanguageCodeActionsProvider to enable apply_code_action.",
    });
  });

  it("delegates apply params to the provider", async () => {
    const getCodeActions = vi.fn();
    const applyCodeAction = vi.fn(async () => ({
      content: [
        { type: "text" as const, text: JSON.stringify({ status: "applied" }) },
      ],
    }));

    const result = await handleApplyCodeAction({ index: 2 }, "session-1", {
      codeActionsProvider: { getCodeActions, applyCodeAction },
    });

    expect(textPayload(result)).toEqual({ status: "applied" });
    expect(applyCodeAction).toHaveBeenCalledWith({
      index: 2,
      sessionId: "session-1",
    });
  });

  it("wraps provider errors in the legacy JSON error shape", async () => {
    const getCodeActions = vi.fn();
    const applyCodeAction = vi.fn(async () => {
      throw new Error("bad apply");
    });

    const result = await handleApplyCodeAction({ index: 0 }, "session-1", {
      codeActionsProvider: { getCodeActions, applyCodeAction },
    });

    expect(textPayload(result)).toEqual({ error: "bad apply" });
  });
});
