/** Error from the server: HTTP status plus its public error code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

let csrfToken: string | undefined;

export function setCsrfToken(token: string | undefined): void {
  csrfToken = token;
}

/**
 * Same-origin JSON request. The browser adds the session cookie and the
 * `Origin` header; unsafe methods also carry the CSRF token.
 */
export async function api<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET" && csrfToken) headers["x-agentlink-csrf"] = csrfToken;
  if (body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      ...(method !== "GET" && body !== undefined
        ? { body: JSON.stringify(body) }
        : {}),
    });
  } catch {
    throw new ApiError(0, "network_error");
  }
  if (response.status === 204) return undefined as T;
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    const code =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `http_${response.status}`;
    throw new ApiError(response.status, code);
  }
  return data as T;
}

const MESSAGES: Readonly<Record<string, string>> = {
  network_error: "The server could not be reached.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
  invalid_setup_credential:
    "That setup credential is wrong or expired. Restart the server to print a new one.",
  invalid_pairing_code: "That pairing code is wrong or expired.",
  invalid_recovery_credential:
    "That recovery code or passphrase is wrong, or the code expired.",
  invalid_passphrase: "That passphrase is wrong.",
  weak_passphrase: "Use a passphrase of at least 12 characters.",
  invalid_label: "Use a device name of up to 80 characters.",
  owner_exists: "The owner is already set up. Sign in instead.",
  pairing_limit_reached:
    "Too many unused pairing codes. Wait for them to expire.",
  session_busy: "The assistant is still working on this session.",
  interaction_pending: "Answer the pending approval first.",
  stale_interaction: "That approval changed. The latest one is shown now.",
  model_not_available: "That model is not available.",
  server_closing: "The server is restarting. Try again shortly.",
  authentication_required: "Your sign-in expired. Sign in again.",
  reauthentication_required: "Confirm your passphrase to continue.",
  agents_not_enabled: "Background agents are not enabled on this server.",
  agent_not_running: "That agent is no longer running.",
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return MESSAGES[error.code] ?? `Request failed (${error.code}).`;
  }
  return error instanceof Error ? error.message : String(error);
}
