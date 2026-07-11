import { describe, expect, it } from "vitest";
import { errorResult, jsonResult, successResult } from "./types.js";

function text(result: ReturnType<typeof jsonResult>): string {
  const item = result.content[0];
  if (item?.type !== "text") throw new Error("Expected text result");
  return item.text;
}

describe("ToolResult JSON helpers", () => {
  it("preserves compact and pretty serialization", () => {
    expect(text(jsonResult({ status: "ok", count: 2 }))).toBe(
      '{"status":"ok","count":2}',
    );
    expect(text(jsonResult({ status: "ok", count: 2 }, true))).toBe(
      '{\n  "status": "ok",\n  "count": 2\n}',
    );
  });

  it("preserves success and error result formatting", () => {
    expect(text(successResult({ status: "ok" }))).toBe(
      '{\n  "status": "ok"\n}',
    );
    expect(text(errorResult("missing", { path: "src/file.ts" }))).toBe(
      '{"error":"missing","path":"src/file.ts"}',
    );
  });
});
