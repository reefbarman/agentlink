/**
 * Narrow model-visibility policy for MCP tool results: hide sign-in callback
 * secrets that tools such as browser page listings can surface incidentally.
 *
 * Only reviewed exact callback endpoints are recognised, and only their
 * `code` and `state` query/fragment values are replaced. Host, path, other
 * parameters and every other URL are preserved. This is not a general secret
 * scanner, and it never touches tool arguments, navigation or auth handling.
 */

export const REDACTED_AUTH_CALLBACK_VALUE = "REDACTED";

/** Reviewed callback endpoints (scheme + host + exact path). */
const AUTH_CALLBACK_ENDPOINTS = [
  // OpenAI / ChatGPT device-code sign-in callback.
  { host: "auth.openai.com", path: "/deviceauth/callback" },
] as const;

const REDACTED_PARAMETERS = new Set(["code", "state"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

const CALLBACK_URL_PATTERN = new RegExp(
  `https://(?:${AUTH_CALLBACK_ENDPOINTS.map(
    ({ host, path }) => `${escapeRegExp(host)}${escapeRegExp(path)}`,
  ).join("|")})(?=[?#])([?#][^\\s"'<>\`\\\\]*)`,
  "gi",
);

const QUICK_CHECK = new RegExp(
  AUTH_CALLBACK_ENDPOINTS.map(({ path }) => escapeRegExp(path)).join("|"),
  "i",
);

function redactCallbackTail(tail: string): string {
  // Keep sentence punctuation that follows the URL outside the value.
  const trailing = /[.,;:!?)\]]+$/.exec(tail)?.[0] ?? "";
  const body = trailing ? tail.slice(0, -trailing.length) : tail;
  const redacted = body.replace(
    /([?&#;])([^=&#;]+)=([^&#;]*)/g,
    (match, separator: string, key: string, value: string) => {
      let decodedKey = key;
      try {
        decodedKey = decodeURIComponent(key);
      } catch {
        // Malformed escapes: compare the raw key.
      }
      return value && REDACTED_PARAMETERS.has(decodedKey.trim().toLowerCase())
        ? `${separator}${key}=${REDACTED_AUTH_CALLBACK_VALUE}`
        : match;
    },
  );
  return `${redacted}${trailing}`;
}

/** Redact recognised callback secrets in one string. Idempotent. */
export function redactAuthCallbackSecrets(text: string): string {
  if (!QUICK_CHECK.test(text)) return text;
  return text.replace(
    CALLBACK_URL_PATTERN,
    (match, tail: string) =>
      match.slice(0, match.length - tail.length) + redactCallbackTail(tail),
  );
}

/**
 * Apply {@link redactAuthCallbackSecrets} to every string inside a JSON-like
 * value. Returns the original reference when nothing changed. Cyclic values
 * (which cannot be serialized for the model anyway) are returned unchanged
 * at the point of recursion.
 */
export function redactAuthCallbackSecretsDeep<T>(value: T): T {
  return redactDeep(value, new WeakSet());
}

function redactDeep<T>(value: T, active: WeakSet<object>): T {
  if (typeof value === "string") {
    return redactAuthCallbackSecrets(value) as T;
  }
  if (!value || typeof value !== "object" || active.has(value)) return value;
  active.add(value);
  try {
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const redacted = redactDeep(item, active);
        if (redacted !== item) changed = true;
        return redacted;
      });
      return (changed ? next : value) as T;
    }
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const redacted = redactDeep(item, active);
      if (redacted !== item) changed = true;
      next[key] = redacted;
    }
    return (changed ? next : value) as T;
  } finally {
    active.delete(value);
  }
}
