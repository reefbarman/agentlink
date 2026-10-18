import type { ComposeTrace } from "./compose.js";
import type { HumanQuestionAnswer } from "./structuredQuestion.js";
import type { McpConfigMutationTarget } from "./mcpManager.js";

/** Durable MCP approval authority retained across transcript and UI round trips. */
export interface McpApprovalPromotionMeta {
  serverName: string;
  bareToolName: string;
  mutationTarget?: McpConfigMutationTarget;
  scopes: Array<"session" | "project" | "global">;
}

export interface McpContentAnnotations {
  audience?: Array<"user" | "assistant">;
  priority?: number;
  lastModified?: string;
}

export interface McpResultContentMeta {
  type: string;
  annotations?: McpContentAnnotations;
  meta?: Record<string, unknown>;
  resourceLink?: {
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
  };
  resource?: {
    uri: string;
    mimeType?: string;
    meta?: Record<string, unknown>;
  };
}

export interface McpToolResultMeta {
  resultMeta?: Record<string, unknown>;
  content: McpResultContentMeta[];
}

/**
 * Host-observed provenance for an image retrieved from the public web.
 * URLs are sanitised for publication (no credentials, query or fragment).
 * Creator and licence values are publisher-supplied and unverified.
 */
export interface ImageAttribution {
  origin: "web_page" | "web_url";
  /** Sanitised source-page URL where the image was discovered. */
  sourceUrl?: string;
  /** Sanitised URL of the retrieved image resource. */
  imageUrl?: string;
  /** True when sanitisation removed parts that may identify the exact page. */
  sanitized?: boolean;
  title?: string;
  alt?: string;
  creator?: string;
  license?: string;
  extraction?:
    | "json_ld"
    | "open_graph"
    | "twitter"
    | "html_image"
    | "direct_url";
  width?: number;
  height?: number;
  /** ISO-8601 retrieval time. */
  retrievedAt?: string;
}

/** Host-owned approval evidence. Never populate from tool arguments or MCP JSON. */
export interface AuthorizationDecision {
  family: "mcp" | "managed-network";
  basis:
    | "existing-grant"
    | "rule"
    | "human"
    | "first-pass"
    | "guardian"
    | "host-policy"
    | "unknown";
  decision: "allow" | "deny";
  status:
    | "authorized"
    | "rejected"
    | "reviewed"
    | "invalid"
    | "unavailable"
    | "timed_out"
    | "cancelled"
    | "invalidated";
  reviewer?: "first-pass" | "guardian";
  model?: string;
  risk?: "low" | "medium" | "high" | "critical";
  userAuthorization?: "unknown" | "low" | "medium" | "high";
}

export interface AuthorizationAudit {
  decisions: AuthorizationDecision[];
  omittedCount: number;
}

export const MAX_AUTHORIZATION_DECISIONS = 20;

/** Explicit allowlist also protects diagnostics from malformed persisted metadata. */
export function sanitizeAuthorizationAudit(
  value: unknown,
): AuthorizationAudit | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.decisions)) return undefined;
  const decisions: AuthorizationDecision[] = [];
  for (const item of raw.decisions.slice(0, MAX_AUTHORIZATION_DECISIONS)) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (
      !(["mcp", "managed-network"] as unknown[]).includes(entry.family) ||
      !(
        [
          "existing-grant",
          "rule",
          "human",
          "first-pass",
          "guardian",
          "host-policy",
          "unknown",
        ] as unknown[]
      ).includes(entry.basis) ||
      !(["allow", "deny"] as unknown[]).includes(entry.decision) ||
      !(
        [
          "authorized",
          "rejected",
          "reviewed",
          "invalid",
          "unavailable",
          "timed_out",
          "cancelled",
          "invalidated",
        ] as unknown[]
      ).includes(entry.status)
    )
      continue;
    const decision: AuthorizationDecision = {
      family: entry.family as AuthorizationDecision["family"],
      basis: entry.basis as AuthorizationDecision["basis"],
      decision: entry.decision as AuthorizationDecision["decision"],
      status: entry.status as AuthorizationDecision["status"],
    };
    if (entry.reviewer === "first-pass" || entry.reviewer === "guardian")
      decision.reviewer = entry.reviewer;
    // Model identifiers only, never URLs, free text, credentials or rationale.
    if (
      typeof entry.model === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,95}$/.test(entry.model) &&
      !/(?:sk-|token|secret|password|credential)/i.test(entry.model)
    )
      decision.model = entry.model;
    if (
      (["low", "medium", "high", "critical"] as unknown[]).includes(entry.risk)
    )
      decision.risk = entry.risk as AuthorizationDecision["risk"];
    if (
      (["unknown", "low", "medium", "high"] as unknown[]).includes(
        entry.userAuthorization,
      )
    )
      decision.userAuthorization =
        entry.userAuthorization as AuthorizationDecision["userAuthorization"];
    decisions.push(decision);
  }
  const omittedCount =
    typeof raw.omittedCount === "number" &&
    Number.isSafeInteger(raw.omittedCount) &&
    raw.omittedCount >= 0
      ? raw.omittedCount
      : 0;
  return {
    decisions,
    omittedCount: Math.min(
      Number.MAX_SAFE_INTEGER,
      omittedCount +
        Math.max(0, raw.decisions.length - MAX_AUTHORIZATION_DECISIONS),
    ),
  };
}

export function appendAuthorizationDecision(
  audit: AuthorizationAudit,
  decision: AuthorizationDecision,
): void {
  const sanitized = sanitizeAuthorizationAudit({ decisions: [decision] });
  if (!sanitized?.decisions.length) return;
  if (audit.decisions.length < MAX_AUTHORIZATION_DECISIONS)
    audit.decisions.push(sanitized.decisions[0]!);
  else
    audit.omittedCount = Math.min(
      Number.MAX_SAFE_INTEGER,
      audit.omittedCount + 1,
    );
}

export interface ToolResult {
  /** Host metadata, separate from arbitrary tool/MCP result data. */
  humanQuestionAnswer?: HumanQuestionAnswer;
  data?: unknown;
  content: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        data: string;
        mimeType: string;
        attribution?: ImageAttribution;
      }
    | { type: "document"; data: string; mimeType: string; name: string }
  >;
  isError?: boolean;
  error?: {
    kind: string;
    message: string;
  };
  mcpMeta?: McpToolResultMeta;
  uiMeta?: {
    mcpApprovalPromotion?: McpApprovalPromotionMeta;
    composeTrace?: ComposeTrace;
    authorizationAudit?: AuthorizationAudit;
  };
}

const TOOL_ERROR_KIND = "tool_error";

/** Create a ToolResult containing a canonical JSON-serialized payload. */
export function jsonResult(payload: unknown, pretty = false): ToolResult {
  const serialized = JSON.stringify(payload, null, pretty ? 2 : undefined);
  if (serialized === undefined) {
    throw new TypeError("Tool result payload must be JSON-serializable");
  }
  return {
    data: JSON.parse(serialized) as unknown,
    content: [{ type: "text", text: serialized }],
    isError: false,
  };
}

/** Create a successful ToolResult from a JSON-serializable payload. */
export function successResult(payload: unknown): ToolResult {
  return jsonResult(payload, true);
}

/** Create an error ToolResult from a message string. */
export function errorResult(
  message: string,
  extra?: Record<string, unknown>,
): ToolResult {
  const payload = { error: message, ...extra };
  return {
    ...jsonResult(payload),
    isError: true,
    error: {
      kind: TOOL_ERROR_KIND,
      message: typeof payload.error === "string" ? payload.error : message,
    },
  };
}

/** Wrap a caught error into a ToolResult. */
export function handleToolError(
  err: unknown,
  context?: Record<string, unknown>,
): ToolResult {
  if (typeof err === "object" && err !== null && "content" in err) {
    const result = err as ToolResult;
    result.isError = true;
    result.error ??= {
      kind: TOOL_ERROR_KIND,
      message: "Tool execution failed",
    };
    return result;
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorResult(message, context);
}
