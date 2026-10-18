import { describe, expect, expectTypeOf, it } from "vitest";

import {
  errorResult,
  handleToolError,
  jsonResult,
  successResult,
  appendAuthorizationDecision,
  sanitizeAuthorizationAudit,
  type AuthorizationAudit,
  type ImageAttribution,
  type McpApprovalPromotionMeta,
  type McpContentAnnotations,
  type McpResultContentMeta,
  type McpToolResultMeta,
  type ToolResult,
} from "./toolResult.js";

function text(result: ToolResult): string {
  const item = result.content[0];
  if (item?.type !== "text") throw new Error("Expected text result");
  return item.text;
}

describe("tool result protocol", () => {
  it("keeps the serializable tool and MCP metadata closure stable", () => {
    expectTypeOf<ToolResult["content"][number]>().toEqualTypeOf<
      | { type: "text"; text: string }
      | {
          type: "image";
          data: string;
          mimeType: string;
          attribution?: ImageAttribution;
        }
      | { type: "document"; data: string; mimeType: string; name: string }
    >();
    expectTypeOf<McpApprovalPromotionMeta["mutationTarget"]>().toEqualTypeOf<
      import("./mcpManager.js").McpConfigMutationTarget | undefined
    >();
    expectTypeOf<McpApprovalPromotionMeta["scopes"][number]>().toEqualTypeOf<
      "session" | "project" | "global"
    >();
    expectTypeOf<McpContentAnnotations["audience"]>().toEqualTypeOf<
      Array<"user" | "assistant"> | undefined
    >();
    expectTypeOf<McpResultContentMeta["resourceLink"]>().toEqualTypeOf<
      | {
          uri: string;
          name: string;
          title?: string;
          description?: string;
          mimeType?: string;
          size?: number;
          icons?: Array<{
            src: string;
            mimeType?: string;
            sizes?: string[];
            theme?: "light" | "dark";
          }>;
        }
      | undefined
    >();
    expectTypeOf<McpToolResultMeta["content"]>().toEqualTypeOf<
      McpResultContentMeta[]
    >();
    expectTypeOf<ToolResult["uiMeta"]>().toEqualTypeOf<
      | {
          mcpApprovalPromotion?: McpApprovalPromotionMeta;
          composeTrace?: import("./compose.js").ComposeTrace;
          authorizationAudit?: AuthorizationAudit;
        }
      | undefined
    >();
  });

  it("allowlists bounded authorization metadata without sensitive evidence", () => {
    const raw = {
      family: "mcp",
      basis: "first-pass",
      decision: "allow",
      status: "reviewed",
      reviewer: "first-pass",
      model: "jev-1.14.0",
      risk: "low",
      userAuthorization: "high",
      input: { token: "private-input" },
      host: "private.example",
      url: "https://private.example",
      rationale: "private rationale",
      credentials: "private-credential",
    };
    const sanitized = sanitizeAuthorizationAudit({
      decisions: Array(25).fill(raw),
      omittedCount: 3,
      secret: "private",
    })!;
    expect(sanitized.decisions).toHaveLength(20);
    expect(sanitized.omittedCount).toBe(8);
    expect(sanitized.decisions[0]).toEqual({
      family: "mcp",
      basis: "first-pass",
      decision: "allow",
      status: "reviewed",
      reviewer: "first-pass",
      model: "jev-1.14.0",
      risk: "low",
      userAuthorization: "high",
    });
    expect(JSON.stringify(sanitized)).not.toContain("private");
    for (const model of [
      "https://user:password@example.com",
      "sk-privatecredential",
      "model\nprivate",
      "x".repeat(97),
    ]) {
      expect(
        sanitizeAuthorizationAudit({ decisions: [{ ...raw, model }] })
          ?.decisions[0]?.model,
      ).toBeUndefined();
    }
    expect(
      sanitizeAuthorizationAudit({ decisions: [{ ...raw, basis: "private" }] })
        ?.decisions,
    ).toEqual([]);
  });

  it("caps retained decisions and counts omissions without unbounded storage", () => {
    const audit: AuthorizationAudit = { decisions: [], omittedCount: 0 };
    for (let n = 0; n < 100; n++)
      appendAuthorizationDecision(audit, {
        family: "managed-network",
        basis: "rule",
        decision: "deny",
        status: "rejected",
      });
    expect(audit.decisions).toHaveLength(20);
    expect(audit.omittedCount).toBe(80);
    expect(sanitizeAuthorizationAudit(audit)).toEqual(audit);
  });

  it("preserves compact and pretty canonical JSON results", () => {
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

  it("preserves success and error result semantics", () => {
    expect(successResult({ status: "ok" })).toMatchObject({
      data: { status: "ok" },
      content: [{ type: "text", text: '{\n  "status": "ok"\n}' }],
      isError: false,
    });
    expect(errorResult("missing", { path: "src/file.ts" })).toMatchObject({
      data: { error: "missing", path: "src/file.ts" },
      content: [
        { type: "text", text: '{"error":"missing","path":"src/file.ts"}' },
      ],
      isError: true,
      error: { kind: "tool_error", message: "missing" },
    });
  });

  it("marks thrown ToolResult values as errors without changing their content or metadata", () => {
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
    expect(result).toMatchObject({
      isError: true,
      error: { kind: "tool_error", message: "Tool execution failed" },
    });
  });

  it("canonicalizes caught Error values with context", () => {
    expect(
      handleToolError(new Error("boom"), { path: "src/file.ts" }),
    ).toMatchObject({
      data: { error: "boom", path: "src/file.ts" },
      isError: true,
      error: { kind: "tool_error", message: "boom" },
    });
  });
});
