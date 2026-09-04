import { summarizeHtmlErrorText } from "@agentlink/protocol/agent-error-presentation";

export interface CodexErrorActions {
  signIn?: boolean;
  signInAnotherAccount?: boolean;
  condense?: boolean;
}

export interface CodexErrorShape {
  status?: number;
  headers?: unknown;
  message?: string;
  rawMessage?: string;
  rawCode?: string;
  body?: unknown;
  requestID?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CodexProviderDiagnostics {
  requestId?: string;
  cfRay?: string;
}

export interface CodexErrorDetails extends CodexErrorShape {
  message: string;
  code?: string;
  retryable?: boolean;
  actions?: CodexErrorActions;
  metadata?: Record<string, unknown>;
}

export class CodexRequestError extends Error implements CodexErrorDetails {
  readonly status?: number;
  readonly headers?: unknown;
  readonly rawMessage?: string;
  readonly rawCode?: string;
  readonly body?: unknown;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly actions?: CodexErrorActions;
  readonly metadata?: Record<string, unknown>;

  constructor(details: CodexErrorDetails) {
    super(details.message);
    this.name = "CodexRequestError";
    this.status = details.status;
    this.headers = details.headers;
    this.rawMessage = details.rawMessage;
    this.rawCode = details.rawCode;
    this.body = details.body;
    this.code = details.code;
    this.retryable = details.retryable;
    this.actions = details.actions;
    this.metadata = details.metadata;
  }
}

export function createCodexRequestError(
  details: CodexErrorDetails,
): CodexRequestError {
  return new CodexRequestError(details);
}

export function toCodexRequestError(error: unknown): Error & CodexErrorShape {
  if (error instanceof CodexRequestError) {
    return error;
  }

  if (error instanceof Error) {
    const shaped = error as Error &
      CodexErrorShape & { code?: unknown; error?: unknown };
    if (shaped.name === "CodexStreamError") {
      return createCodexRequestError({
        message: shaped.message,
        rawMessage: shaped.rawMessage,
        body: shaped.body,
      });
    }
    if (
      typeof shaped.status === "number" ||
      shaped.rawMessage ||
      shaped.rawCode ||
      shaped.body
    ) {
      return createCodexRequestError({
        ...buildCodexApiErrorDetails({
          status: shaped.status,
          message: shaped.message || "Unknown OpenAI error",
          rawCode:
            typeof shaped.rawCode === "string"
              ? shaped.rawCode
              : typeof shaped.code === "string"
                ? shaped.code
                : undefined,
          body: shaped.body ?? shaped.error,
        }),
        headers: shaped.headers,
        metadata: diagnosticsMetadata(shaped),
      });
    }
    return shaped;
  }

  if (error && typeof error === "object") {
    const shaped = error as CodexErrorShape & {
      code?: unknown;
      error?: unknown;
    };
    if (
      typeof shaped.status === "number" ||
      shaped.message ||
      shaped.rawMessage ||
      shaped.rawCode ||
      shaped.body ||
      shaped.error
    ) {
      const body = shaped.body ?? shaped.error;
      return createCodexRequestError({
        ...buildCodexApiErrorDetails({
          status: shaped.status,
          message:
            shaped.message || shaped.rawMessage || "Unknown OpenAI error",
          rawCode:
            typeof shaped.rawCode === "string"
              ? shaped.rawCode
              : typeof shaped.code === "string"
                ? shaped.code
                : undefined,
          body,
        }),
        headers: shaped.headers,
        metadata: diagnosticsMetadata(shaped),
      });
    }
  }

  return new Error(String(error)) as Error & CodexErrorShape;
}

export type CodexErrorHandlingAction =
  | "refresh_oauth_auth"
  | "handle_oauth_usage_limit"
  | "throw_context_window_exceeded"
  | "throw_original";

export interface CodexAuthRetryState {
  method: "oauth" | "apiKey";
  canRefresh?: boolean;
  oauthAccountPoolId?: string;
}

export function getCodexProviderDiagnostics(
  error: CodexErrorShape,
): CodexProviderDiagnostics {
  const metadata = error.metadata;
  const requestId = firstNonEmptyString(
    error.requestID,
    error.requestId,
    metadata?.requestId,
    getHeader(error.headers, "x-request-id"),
    getHeader(error.headers, "request-id"),
  );
  const cfRay = firstNonEmptyString(
    metadata?.cfRay,
    getHeader(error.headers, "cf-ray"),
  );
  return {
    ...(requestId ? { requestId } : {}),
    ...(cfRay ? { cfRay } : {}),
  };
}

export function isCodexBodylessBadRequest(error: CodexErrorShape): boolean {
  if (error.status !== 400) return false;
  if (error.body !== undefined && error.body !== null) return false;
  return /\bno body\b/i.test(extractCodexErrorText(error));
}

export function buildCodexAstraOAuthBodylessError(
  sourceError: CodexErrorShape,
): CodexErrorDetails {
  const diagnostics = getCodexProviderDiagnostics(sourceError);
  const diagnosticSuffix = [
    diagnostics.requestId ? `Request ID: ${diagnostics.requestId}.` : "",
    diagnostics.cfRay ? `Cloudflare Ray: ${diagnostics.cfRay}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    message: [
      "Codex rejected GPT-6 Astra for this ChatGPT account (HTTP 400 with no response body).",
      "AgentLink sent the required Responses Lite request, but the server returned no exact reason.",
      "Astra access may not have reached this account yet; try again later or use an OpenAI API key/project with Astra access.",
      diagnosticSuffix,
    ]
      .filter(Boolean)
      .join(" "),
    status: sourceError.status,
    headers: sourceError.headers,
    rawMessage: sourceError.rawMessage,
    rawCode: sourceError.rawCode,
    body: sourceError.body,
    code: "astra_oauth_bodyless_400",
    retryable: false,
    metadata: {
      model: "gpt-6-astra",
      authMethod: "oauth",
      transport: "responses_lite",
      providerReturnedBody: false,
      ...diagnostics,
    },
  };
}

export function extractCodexErrorText(error: CodexErrorShape): string {
  return [error.rawMessage, error.message]
    .filter((value): value is string => !!value)
    .join(" ")
    .toLowerCase();
}

export function isCodexAuthError(error: unknown): boolean {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 401) {
      return true;
    }
    // A structured server-side status is authoritative: 5xx bodies (e.g.
    // Cloudflare HTML pages) must not be message-sniffed into auth errors.
    if (typeof status === "number" && status >= 500) {
      return false;
    }
  }

  const msg =
    error && typeof error === "object"
      ? extractCodexErrorText(error as CodexErrorShape)
      : error instanceof Error
        ? error.message
        : String(error);
  return /unauthorized|invalid token|\b401\b|authentication/i.test(msg);
}

export function buildCodexAuthRequiredError(): CodexErrorDetails {
  return {
    message:
      "OpenAI/Codex authentication is required. Sign in with ChatGPT/Codex or configure an OpenAI API key to use models, semantic search, and indexing.",
    code: "auth_required",
    retryable: true,
    actions: { signIn: true },
  };
}

export function buildCodexApiErrorDetails(params: {
  status?: number;
  message?: string;
  rawCode?: string;
  body?: unknown;
}): CodexErrorDetails {
  const message = summarizeHtmlErrorText(
    params.message || "Unknown OpenAI error",
  );
  return {
    message: `Codex API error ${params.status ?? "unknown"}: ${message}`,
    status: params.status,
    rawMessage: message,
    rawCode: params.rawCode,
    body: params.body,
  };
}

export function getCodexErrorHandlingAction(params: {
  auth: CodexAuthRetryState;
  error: CodexErrorShape;
}): CodexErrorHandlingAction {
  if (
    params.auth.method === "oauth" &&
    params.auth.canRefresh &&
    isCodexAuthError(params.error)
  ) {
    return "refresh_oauth_auth";
  }

  if (
    params.auth.method === "oauth" &&
    params.auth.oauthAccountPoolId &&
    isCodexUsageLimitError(params.error)
  ) {
    return "handle_oauth_usage_limit";
  }

  if (isCodexContextWindowExceeded(params.error)) {
    return "throw_context_window_exceeded";
  }

  return "throw_original";
}

export function isCodexUsageLimitError(error: CodexErrorShape): boolean {
  if (error.status !== 429) return false;

  const text = extractCodexErrorText(error);
  if (text.includes("usage limit has been reached")) {
    return true;
  }

  if (error.rawCode && /usage.*limit|insufficient_quota/i.test(error.rawCode)) {
    return true;
  }

  if (error.body && typeof error.body === "object") {
    const bodyText = JSON.stringify(error.body).toLowerCase();
    if (
      bodyText.includes("usage limit") ||
      bodyText.includes("insufficient_quota")
    ) {
      return true;
    }
  }

  return false;
}

export function isCodexModelNotFoundError(error: CodexErrorShape): boolean {
  if (error.status !== 404) return false;
  return /model not found|model_not_found|does not exist|not have access/i.test(
    extractCodexErrorText(error),
  );
}

/**
 * True when the endpoint rejected the request because it does not accept the
 * `text.verbosity` parameter (expected shape: 400 invalid_request_error with
 * param "text.verbosity" or a message naming it). Callers should retry once
 * without the parameter.
 */
export function isCodexTextVerbosityRejectionError(
  error: CodexErrorShape,
): boolean {
  if (error.status !== 400) return false;
  return /verbosity|(?:unknown|unsupported|unexpected|invalid) (?:parameter|field|property|value)[^A-Za-z]*'?"?text\b/i.test(
    extractCodexErrorText(error),
  );
}

export function buildCodexUsageLimitExhaustedError(params: {
  attemptedOAuthAccountIds: Iterable<string>;
  sourceError: CodexErrorShape;
}): CodexErrorDetails {
  return {
    message:
      params.sourceError.message ||
      "Codex API error 429: The usage limit has been reached on all signed-in accounts.",
    status: params.sourceError.status,
    rawMessage: params.sourceError.rawMessage,
    rawCode: params.sourceError.rawCode,
    body: params.sourceError.body,
    code: "oauth_usage_limit_exhausted",
    retryable: true,
    actions: { signInAnotherAccount: true },
    metadata: {
      attemptedOAuthAccountIds: [...params.attemptedOAuthAccountIds],
    },
  };
}

function diagnosticsMetadata(
  error: CodexErrorShape,
): Record<string, unknown> | undefined {
  const { requestId, cfRay } = getCodexProviderDiagnostics(error);
  return requestId || cfRay
    ? {
        ...(requestId ? { requestId } : {}),
        ...(cfRay ? { cfRay } : {}),
      }
    : undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function getHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const getter = (headers as { get?: unknown }).get;
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

export function isCodexContextWindowExceeded(error: CodexErrorShape): boolean {
  const text = extractCodexErrorText(error);
  if (
    text.includes("exceeds the context window") ||
    text.includes("exceeded the context window") ||
    text.includes("context length exceeded") ||
    text.includes("maximum context length")
  ) {
    return true;
  }

  if (
    error.rawCode &&
    /context_length_exceeded|context_window_exceeded/i.test(error.rawCode)
  ) {
    return true;
  }

  if (error.body && typeof error.body === "object") {
    const bodyText = JSON.stringify(error.body).toLowerCase();
    if (
      bodyText.includes("context window") ||
      bodyText.includes("context length exceeded")
    ) {
      return true;
    }
  }

  return false;
}

export function buildCodexContextWindowExceededError(
  sourceError: CodexErrorShape,
): CodexErrorDetails {
  return {
    message: sourceError.message || "Codex context window exceeded.",
    status: sourceError.status,
    rawMessage: sourceError.rawMessage,
    rawCode: sourceError.rawCode,
    body: sourceError.body,
    code: "context_window_exceeded",
    retryable: true,
    actions: { condense: true },
  };
}
