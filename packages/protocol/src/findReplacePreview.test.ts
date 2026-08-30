import type {
  FindReplaceFileGroup,
  FindReplaceMatch,
  FindReplacePreviewData,
  PreviewExtensionMessage,
  PreviewWebviewMessage,
} from "./findReplacePreview.js";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("find/replace preview protocol", () => {
  it("keeps preview data serializable across host and browser surfaces", () => {
    const match: FindReplaceMatch = {
      id: "0:0",
      line: 4,
      columnStart: 2,
      columnEnd: 7,
      matchText: "before",
      replaceText: "after",
      contextBefore: [{ lineNumber: 3, text: "context before" }],
      matchLine: { lineNumber: 4, text: "  before" },
      contextAfter: [{ lineNumber: 5, text: "context after" }],
    };
    const group: FindReplaceFileGroup = {
      path: "src/example.ts",
      matches: [match],
    };
    const data: FindReplacePreviewData = {
      findText: "before",
      replaceText: "after",
      isRegex: false,
      fileGroups: [group],
      totalMatches: 1,
    };
    const message: PreviewExtensionMessage = { type: "showPreview", data };

    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
  });

  it("pins the complete preview DTO closure", () => {
    type ContextLine = { lineNumber: number; text: string };
    expectTypeOf<FindReplaceMatch>().toEqualTypeOf<{
      id: string;
      line: number;
      columnStart: number;
      columnEnd: number;
      matchText: string;
      replaceText: string;
      contextBefore: ContextLine[];
      matchLine: ContextLine;
      contextAfter: ContextLine[];
    }>();
    expectTypeOf<FindReplaceFileGroup>().toEqualTypeOf<{
      path: string;
      matches: FindReplaceMatch[];
    }>();
    expectTypeOf<FindReplacePreviewData>().toEqualTypeOf<{
      findText: string;
      replaceText: string;
      isRegex: boolean;
      fileGroups: FindReplaceFileGroup[];
      totalMatches: number;
    }>();
    expectTypeOf<PreviewExtensionMessage>().toEqualTypeOf<
      | { type: "showPreview"; data: FindReplacePreviewData }
      | { type: "dispose" }
    >();
    expectTypeOf<PreviewWebviewMessage>().toEqualTypeOf<
      | { type: "ready" }
      | { type: "toggleMatch"; matchId: string; accepted: boolean }
      | { type: "toggleFile"; filePath: string; accepted: boolean }
      | { type: "toggleAll"; accepted: boolean }
    >();
  });
});
