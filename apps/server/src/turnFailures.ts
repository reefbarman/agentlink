/**
 * Why a turn failed, in words. Turn events carry only a safe public error
 * (often just `turn_execution_failed`); the workspace host reports the
 * original error privately, and this keeps a bounded, redacted description
 * of it per chat so a job run and its Inbox entry can say what went wrong.
 *
 * Only the server's owner sees these (run records, the Inbox, the server
 * log). They are still redacted: provider errors can echo request URLs,
 * headers or keys.
 */

export const MAX_FAILURE_DETAIL_LENGTH = 500;
const MAX_CAUSE_DEPTH = 3;
const MAX_REMEMBERED = 200;

/** Generic wording that says nothing beyond the public code. */
const UNINFORMATIVE = new Set(["", "turn execution failed", "error"]);

/**
 * A one-line description of an error and its causes, or undefined when it
 * says nothing useful.
 */
export function describeTurnFailure(error: unknown): string | undefined {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current; depth += 1) {
    const part = describeOne(current);
    if (part && !parts.some((seen) => seen.includes(part))) parts.push(part);
    current =
      current && typeof current === "object"
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  const text = redact(parts.join(": ").replace(/\s+/gu, " ").trim());
  if (UNINFORMATIVE.has(text.toLowerCase())) return undefined;
  return text.length > MAX_FAILURE_DETAIL_LENGTH
    ? `${text.slice(0, MAX_FAILURE_DETAIL_LENGTH - 1)}…`
    : text;
}

function describeOne(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as {
    readonly message?: unknown;
    readonly status?: unknown;
    readonly code?: unknown;
  };
  const message =
    typeof candidate.message === "string" ? candidate.message.trim() : "";
  const status =
    typeof candidate.status === "number" ? `HTTP ${candidate.status}` : "";
  const code =
    typeof candidate.code === "string" &&
    /^[A-Z][A-Z0-9_]+$/u.test(candidate.code)
      ? candidate.code
      : "";
  const labels = [status, code].filter(
    (label) => label && !message.includes(label),
  );
  if (!message && labels.length === 0) return undefined;
  return labels.length > 0
    ? `${message}${message ? " " : ""}(${labels.join(", ")})`
    : message;
}

/** Remove things that look like credentials or private request detail. */
export function redact(text: string): string {
  return (
    text
      .replace(/\bBearer\s+[^\s"',;]+/giu, "Bearer [redacted]")
      // JSON Web Tokens.
      .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/gu, "[redacted]")
      // Common API key shapes.
      .replace(
        /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][\w-]{8,}/gu,
        "[redacted]",
      )
      // key=value / "key": "value" for secret-looking names.
      .replace(
        /\b([\w-]*(?:token|secret|password|passwd|api[-_]?key|apikey|signature|authorization|cookie|session)[\w-]*)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/giu,
        "$1$2[redacted]",
      )
      // Query strings can carry codes and keys.
      .replace(/(https?:\/\/[^\s?#"']+)\?[^\s"']*/giu, "$1?…")
      // Long opaque strings.
      .replace(/[A-Za-z0-9+/_=-]{48,}/gu, "[redacted]")
  );
}

export interface TurnFailureLog {
  record(projectId: string, sessionId: string, detail: string): void;
  /** The latest failure of a chat, removed once read. */
  take(projectId: string, sessionId: string): string | undefined;
}

/** The latest failure per chat, the most recent few hundred chats only. */
export function createTurnFailureLog(): TurnFailureLog {
  const failures = new Map<string, string>();
  const key = (projectId: string, sessionId: string) =>
    `${projectId}\u0000${sessionId}`;
  return {
    record(projectId, sessionId, detail) {
      const id = key(projectId, sessionId);
      failures.delete(id);
      failures.set(id, detail);
      while (failures.size > MAX_REMEMBERED) {
        const oldest = failures.keys().next().value;
        if (oldest === undefined) break;
        failures.delete(oldest);
      }
    },
    take(projectId, sessionId) {
      const id = key(projectId, sessionId);
      const detail = failures.get(id);
      failures.delete(id);
      return detail;
    },
  };
}
