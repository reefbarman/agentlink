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
    lower.includes("enotfound") ||
    lower.includes("etimedout") ||
    lower.includes("timed out") ||
    lower.includes("fetch failed") ||
    lower.includes("other side closed") ||
    lower.includes("terminated") ||
    lower.includes("termination") ||
    lower.includes("an error occurred while processing your request") ||
    lower.includes("please include the request id")
  );
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
