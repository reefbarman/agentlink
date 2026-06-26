export interface CodexErrorActions {
  signIn?: boolean;
  signInAnotherAccount?: boolean;
  condense?: boolean;
}

export interface CodexErrorShape {
  status?: number;
  message?: string;
  rawMessage?: string;
  rawCode?: string;
  body?: unknown;
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
    const shaped = error as Error & CodexErrorShape & { code?: unknown };
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
      return createCodexRequestError(
        buildCodexApiErrorDetails({
          status: shaped.status,
          message: shaped.message || "Unknown OpenAI error",
          rawCode:
            typeof shaped.rawCode === "string"
              ? shaped.rawCode
              : typeof shaped.code === "string"
                ? shaped.code
                : undefined,
          body: shaped.body,
        }),
      );
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
      return createCodexRequestError(
        buildCodexApiErrorDetails({
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
      );
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
  }

  const msg =
    error && typeof error === "object"
      ? extractCodexErrorText(error as CodexErrorShape)
      : error instanceof Error
        ? error.message
        : String(error);
  return /unauthorized|invalid token|401|authentication/i.test(msg);
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
  const message = params.message || "Unknown OpenAI error";
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
