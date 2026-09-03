export type EmbeddedAgentErrorCategory =
  | "validation"
  | "authentication"
  | "authorization"
  | "conflict"
  | "not_found"
  | "rate_limit"
  | "capacity"
  | "cancelled"
  | "provider"
  | "internal";

export type EmbeddedAgentToolEffect = "read" | "write" | "external" | "unknown";

/** Host-authored, display-safe metadata. It never implies execution authority. */
export interface EmbeddedAgentToolPresentation {
  readonly title?: string;
  readonly inputLabel?: string;
  readonly outputLabel?: string;
  readonly confirmationLabel?: string;
  readonly denialMessage?: string;
  readonly destructive?: boolean;
}

export function embeddedAgentErrorCategory(
  code: string,
): EmbeddedAgentErrorCategory {
  if (
    code === "invalid_request" ||
    code === "invalid_engine_configuration" ||
    code === "invalid_tool_resolution" ||
    code === "invalid_interaction_request" ||
    code === "tool_input_invalid" ||
    code === "model_capability_unsupported" ||
    code.endsWith("_invalid") ||
    code.endsWith("_scope_mismatch")
  ) {
    return "validation";
  }
  if (code.includes("authentication") || code === "unauthenticated") {
    return "authentication";
  }
  if (
    code.includes("authorization_denied") ||
    code === "tool_authorization_required" ||
    code === "forbidden"
  ) {
    return "authorization";
  }
  if (
    code.includes("revision_conflict") ||
    code === "session_already_exists" ||
    code === "session_busy" ||
    code === "turn_lease_held" ||
    code === "turn_lease_lost" ||
    code === "interaction_consumed" ||
    code === "interaction_already_exists"
  ) {
    return "conflict";
  }
  if (code.endsWith("_not_found") || code === "tool_not_found") {
    return "not_found";
  }
  if (code.includes("rate_limit")) return "rate_limit";
  if (code.includes("limit_reached") || code.includes("too_large")) {
    return "capacity";
  }
  if (code.includes("cancel")) return "cancelled";
  if (
    code.startsWith("model_") ||
    code.startsWith("provider_") ||
    code.includes("credential")
  ) {
    return "provider";
  }
  return "internal";
}

export function isEmbeddedAgentErrorCategory(
  value: unknown,
): value is EmbeddedAgentErrorCategory {
  return (
    value === "validation" ||
    value === "authentication" ||
    value === "authorization" ||
    value === "conflict" ||
    value === "not_found" ||
    value === "rate_limit" ||
    value === "capacity" ||
    value === "cancelled" ||
    value === "provider" ||
    value === "internal"
  );
}

export function isEmbeddedAgentToolPresentation(
  value: unknown,
): value is EmbeddedAgentToolPresentation {
  if (!isRecord(value)) return false;
  for (const key of [
    "title",
    "inputLabel",
    "outputLabel",
    "confirmationLabel",
    "denialMessage",
  ] as const) {
    if (value[key] !== undefined && !nonEmptyBoundedText(value[key]))
      return false;
  }
  return (
    value.destructive === undefined || typeof value.destructive === "boolean"
  );
}

function nonEmptyBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 300;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
