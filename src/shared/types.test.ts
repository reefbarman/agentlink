import { describe, expect, expectTypeOf, it } from "vitest";
import {
  errorResult,
  handleToolError,
  jsonResult,
  successResult,
  type BackgroundCompletionResult,
  type BgSessionInfo,
  type BrowserGatewayThemeSnapshot,
  type InFlightAssistantBlock,
  type InlineApprovalChoice,
  type InlineApprovalDecision,
  type InlineApprovalFileWrite,
  type InlineApprovalKind,
  type InlineApprovalRequest,
  type InlineApprovalResult,
  type MemoryScope,
  type MemoryTier,
  type OnApprovalRequest,
  type McpApprovalPromotionMeta,
  type McpContentAnnotations,
  type McpResultContentMeta,
  type CondenseForensicMetadata,
  type CondenseMetadata,
  type ContextBreakdownItem,
  type McpServerToolBreakdown,
  type McpToolResultMeta,
  type PostCondenseProjection,
  type RequestContextBreakdown,
  type RevertRecoveryNotice,
  type SkillCatalogContextBreakdown,
  type ToolContextBreakdown,
  type ToolResult,
  type ToolResultContextAttribution,
} from "./types.js";

it("preserves extracted types through the mixed compatibility module", () => {
  expectTypeOf<BgSessionInfo>().toEqualTypeOf<
    import("@agentlink/protocol/background-result").BgSessionInfo
  >();
  expectTypeOf<BrowserGatewayThemeSnapshot>().toEqualTypeOf<
    import("@agentlink/protocol/browser-gateway-theme").BrowserGatewayThemeSnapshot
  >();
  expectTypeOf<BackgroundCompletionResult>().toEqualTypeOf<
    import("@agentlink/protocol/session-hydration").BackgroundCompletionResult
  >();
  expectTypeOf<InFlightAssistantBlock>().toEqualTypeOf<
    import("@agentlink/protocol/session-hydration").InFlightAssistantBlock
  >();
  expectTypeOf<RevertRecoveryNotice>().toEqualTypeOf<
    import("@agentlink/protocol/session-hydration").RevertRecoveryNotice
  >();
  expectTypeOf<InlineApprovalKind>().toEqualTypeOf<
    import("@agentlink/protocol/inline-approval").InlineApprovalKind
  >();
  expectTypeOf<InlineApprovalChoice>().toEqualTypeOf<
    import("@agentlink/protocol/inline-approval").InlineApprovalChoice
  >();
  expectTypeOf<InlineApprovalFileWrite>().toEqualTypeOf<
    import("@agentlink/protocol/inline-approval").InlineApprovalFileWrite
  >();
  expectTypeOf<InlineApprovalRequest>().toEqualTypeOf<
    import("@agentlink/protocol/inline-approval").InlineApprovalRequest
  >();
  expectTypeOf<InlineApprovalDecision>().toEqualTypeOf<
    import("@agentlink/protocol/inline-approval").InlineApprovalDecision
  >();
  expectTypeOf<InlineApprovalResult>().toEqualTypeOf<
    import("@agentlink/protocol/inline-approval").InlineApprovalResult
  >();
  expectTypeOf<MemoryTier>().toEqualTypeOf<
    import("@agentlink/protocol/inline-approval").MemoryTier
  >();
  expectTypeOf<MemoryScope>().toEqualTypeOf<
    import("@agentlink/protocol/inline-approval").MemoryScope
  >();
  expectTypeOf<OnApprovalRequest>().toEqualTypeOf<
    import("@agentlink/protocol/inline-approval").OnApprovalRequest
  >();
  expectTypeOf<McpApprovalPromotionMeta>().toEqualTypeOf<
    import("@agentlink/protocol/tool-result").McpApprovalPromotionMeta
  >();
  expectTypeOf<McpContentAnnotations>().toEqualTypeOf<
    import("@agentlink/protocol/tool-result").McpContentAnnotations
  >();
  expectTypeOf<McpResultContentMeta>().toEqualTypeOf<
    import("@agentlink/protocol/tool-result").McpResultContentMeta
  >();
  expectTypeOf<McpToolResultMeta>().toEqualTypeOf<
    import("@agentlink/protocol/tool-result").McpToolResultMeta
  >();
  expectTypeOf<ToolResult>().toEqualTypeOf<
    import("@agentlink/protocol/tool-result").ToolResult
  >();
  expectTypeOf<ContextBreakdownItem>().toEqualTypeOf<
    import("@agentlink/protocol/context-diagnostics").ContextBreakdownItem
  >();
  expectTypeOf<ToolResultContextAttribution>().toEqualTypeOf<
    import("@agentlink/protocol/context-diagnostics").ToolResultContextAttribution
  >();
  expectTypeOf<McpServerToolBreakdown>().toEqualTypeOf<
    import("@agentlink/protocol/context-diagnostics").McpServerToolBreakdown
  >();
  expectTypeOf<ToolContextBreakdown>().toEqualTypeOf<
    import("@agentlink/protocol/context-diagnostics").ToolContextBreakdown
  >();
  expectTypeOf<SkillCatalogContextBreakdown>().toEqualTypeOf<
    import("@agentlink/protocol/context-diagnostics").SkillCatalogContextBreakdown
  >();
  expectTypeOf<RequestContextBreakdown>().toEqualTypeOf<
    import("@agentlink/protocol/context-diagnostics").RequestContextBreakdown
  >();
  expectTypeOf<PostCondenseProjection>().toEqualTypeOf<
    import("@agentlink/protocol/context-diagnostics").PostCondenseProjection
  >();
  expectTypeOf<CondenseForensicMetadata>().toEqualTypeOf<
    import("@agentlink/protocol/context-diagnostics").CondenseForensicMetadata
  >();
  expectTypeOf<CondenseMetadata>().toEqualTypeOf<
    import("@agentlink/protocol/context-diagnostics").CondenseMetadata
  >();
});

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
