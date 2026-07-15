export interface AgentErrorActions {
  signIn?: boolean;
  signInAnotherAccount?: boolean;
  condense?: boolean;
}

export interface AgentRuntimeErrorPresentation {
  message: string;
  retryable: boolean;
  code?: string;
  actions?: AgentErrorActions;
}

export type AgentRetryCategory =
  | "rate_limit"
  | "overloaded"
  | "server"
  | "timeout"
  | "network"
  | "unknown";

export interface AgentRetryDecision {
  retryable: boolean;
  category: AgentRetryCategory;
  retryAfterMs?: number;
  status?: number;
}

/** Walk the error cause chain and join unique messages into one string. */
export function buildAgentErrorMessage(err: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let e: unknown = err;
  while (e instanceof Error && !seen.has(e)) {
    seen.add(e);
    if (e.message) parts.push(e.message);
    e = (e as { cause?: unknown }).cause;
  }
  return [...new Set(parts)].join(": ");
}

/** Returns true for transient errors that are safe to retry. */
export function isAgentRetryableErrorMessage(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("rate_limit") ||
    lower.includes("overloaded") ||
    lower.includes("503") ||
    lower.includes("529") ||
    lower.includes("connection error") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("eaddrnotavail") ||
    lower.includes("eai_again") ||
    lower.includes("enotfound") ||
    lower.includes("epipe") ||
    lower.includes("etimedout") ||
    lower.includes("und_err_connect_timeout") ||
    lower.includes("timed out") ||
    lower.includes("fetch failed") ||
    lower.includes("other side closed") ||
    lower.includes("terminated") ||
    lower.includes("termination") ||
    lower.includes("an error occurred while processing your request") ||
    lower.includes("please include the request id")
  );
}

/**
 * Prefer structured SDK error metadata, falling back to the legacy message
 * classifier for low-level Node/Undici failures whose useful errno is often
 * only present in the cause string.
 */
export function getAgentRetryDecision(err: unknown): AgentRetryDecision {
  const chain = getErrorChain(err);
  const message = buildAgentErrorMessage(err);
  const lower = message.toLowerCase();
  const status = firstNumberProperty(chain, ["status", "statusCode"]);
  const headers = chain
    .map((value) => getObjectProperty(value, "headers"))
    .find((value) => value !== undefined);
  const shouldRetry = getHeader(headers, "x-should-retry")?.toLowerCase();
  const retryAfterMs = parseRetryAfterMs(headers);

  if (shouldRetry === "false") {
    return { retryable: false, category: "unknown", status };
  }

  let category: AgentRetryCategory = "unknown";
  if (status === 429 || lower.includes("rate_limit")) {
    category = "rate_limit";
  } else if (
    status === 529 ||
    lower.includes("overloaded") ||
    lower.includes("529")
  ) {
    category = "overloaded";
  } else if ((status !== undefined && status >= 500) || lower.includes("503")) {
    category = "server";
  } else if (
    status === 408 ||
    lower.includes("timed out") ||
    lower.includes("timeout")
  ) {
    category = "timeout";
  } else if (
    lower.includes("connection error") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("eaddrnotavail") ||
    lower.includes("eai_again") ||
    lower.includes("enotfound") ||
    lower.includes("epipe") ||
    lower.includes("fetch failed") ||
    lower.includes("other side closed") ||
    lower.includes("terminated") ||
    lower.includes("termination")
  ) {
    category = "network";
  }

  const retryableStatus =
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status !== undefined && status >= 500);
  return {
    retryable:
      shouldRetry === "true" ||
      retryableStatus ||
      isAgentRetryableErrorMessage(message),
    category,
    retryAfterMs,
    status,
  };
}

function getErrorChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = err;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = getObjectProperty(current, "cause");
  }
  return chain;
}

function getObjectProperty(value: unknown, key: string): unknown {
  return value && typeof value === "object" && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function firstNumberProperty(
  chain: unknown[],
  keys: string[],
): number | undefined {
  for (const value of chain) {
    for (const key of keys) {
      const candidate = getObjectProperty(value, key);
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function getHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const getter = getObjectProperty(headers, "get");
  if (typeof getter === "function") {
    const value = getter.call(headers, name);
    return typeof value === "string" ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name.toLowerCase()) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.join(", ");
  }
  return undefined;
}

function parseRetryAfterMs(headers: unknown): number | undefined {
  const milliseconds = getHeader(headers, "retry-after-ms");
  if (milliseconds !== undefined) {
    const parsed = Number.parseFloat(milliseconds);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }

  const retryAfter = getHeader(headers, "retry-after");
  if (retryAfter === undefined) return undefined;
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** Returns true for authentication errors (expired token, invalid key). */
export function isAgentAuthErrorMessage(msg: string): boolean {
  return (
    msg.includes("authentication_error") ||
    msg.includes("invalid x-api-key") ||
    msg.includes("invalid api key") ||
    (msg.includes("401") && !msg.includes("tool"))
  );
}

export function getAgentErrorCode(err: unknown): string | undefined {
  return err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string"
    ? ((err as { code: string }).code as string)
    : undefined;
}

export function getAgentErrorActions(
  err: unknown,
): AgentErrorActions | undefined {
  if (
    !err ||
    typeof err !== "object" ||
    !("actions" in err) ||
    !(err as { actions?: unknown }).actions ||
    typeof (err as { actions?: unknown }).actions !== "object"
  ) {
    return undefined;
  }
  return (err as { actions: AgentErrorActions }).actions;
}

export function hasAgentRetryableErrorFlag(err: unknown): boolean {
  return !!(
    err &&
    typeof err === "object" &&
    "retryable" in err &&
    (err as { retryable?: boolean }).retryable
  );
}
