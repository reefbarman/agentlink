import { describe, expect, it } from "vitest";
import {
  errorResult,
  handleToolError,
  jsonResult,
  successResult,
  type ToolResult,
} from "./types.js";

function text(result: ReturnType<typeof jsonResult>): string {
  const item = result.content[0];
  if (item?.type !== "text") throw new Error("Expected text result");
  return item.text;
}

describe("ToolResult JSON helpers", () => {
  it("preserves compact and pretty serialization with canonical data", () => {
    const payload = { status: "ok", count: 2 };
    const compact = jsonResult(payload);
    const pretty = jsonResult(payload, true);

    expect(text(compact)).toBe('{"status":"ok","count":2}');
    expect(text(pretty)).toBe('{\n  "status": "ok",\n  "count": 2\n}');
    expect(compact).toMatchObject({ data: payload, isError: false });
    expect(pretty).toMatchObject({ data: payload, isError: false });
  });

  it("normalizes canonical data from the serialized payload", () => {
    const result = jsonResult({
      present: "value",
      omitted: undefined,
      items: ["value", undefined],
    });

    expect(text(result)).toBe('{"present":"value","items":["value",null]}');
    expect(result.data).toStrictEqual({
      present: "value",
      items: ["value", null],
    });
    expect(Object.hasOwn(result.data as object, "omitted")).toBe(false);
  });

  it("rejects unsupported top-level payloads", () => {
    expect(() => jsonResult(undefined)).toThrow(
      "Tool result payload must be JSON-serializable",
    );
    expect(() => jsonResult(() => undefined)).toThrow(
      "Tool result payload must be JSON-serializable",
    );
  });

  it("preserves success formatting and canonical data", () => {
    const payload = { status: "ok" };
    const result = successResult(payload);

    expect(text(result)).toBe('{\n  "status": "ok"\n}');
    expect(result).toMatchObject({ data: payload, isError: false });
  });

  it("preserves error formatting with explicit canonical error state", () => {
    const result = errorResult("missing", { path: "src/file.ts" });

    expect(text(result)).toBe('{"error":"missing","path":"src/file.ts"}');
    expect(result).toMatchObject({
      data: { error: "missing", path: "src/file.ts" },
      isError: true,
      error: { kind: "tool_error", message: "missing" },
    });
  });

  it("marks thrown ToolResult values as errors without changing content or uiMeta", () => {
    const thrown: ToolResult = {
      content: [{ type: "text", text: "legacy failure bytes" }],
      uiMeta: {
        mcpApprovalPromotion: {
          serverName: "example",
          bareToolName: "read",
          scopes: ["session"],
        },
      },
    };

    const result = handleToolError(thrown);

    expect(result).toBe(thrown);
    expect(result.content).toBe(thrown.content);
    expect(result.uiMeta).toBe(thrown.uiMeta);
    expect(result.data).toBeUndefined();
    expect(result).toMatchObject({
      isError: true,
      error: { kind: "tool_error", message: "Tool execution failed" },
    });
  });

  it("canonicalizes caught Error values with context", () => {
    const result = handleToolError(new Error("boom"), { path: "src/file.ts" });

    expect(text(result)).toBe('{"error":"boom","path":"src/file.ts"}');
    expect(result).toMatchObject({
      data: { error: "boom", path: "src/file.ts" },
      isError: true,
      error: { kind: "tool_error", message: "boom" },
    });
  });
});
