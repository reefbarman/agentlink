const DEFAULT_MAX_ERROR_BODY_BYTES = 16_384;
const DEFAULT_MAX_ERROR_MESSAGE_BYTES = 4_096;

export interface OpenAiCompatibleErrorDetails {
  message: string;
  status?: number;
  providerCode?: string;
  providerType?: string;
  retryAfterMs?: number;
  retryable: boolean;
  shouldRetry?: boolean;
  authentication: boolean;
  body?: unknown;
  cause?: unknown;
}

export class OpenAiCompatibleRequestError extends Error {
  readonly status?: number;
  readonly providerCode?: string;
  readonly providerType?: string;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly shouldRetry?: boolean;
  readonly authentication: boolean;
  readonly body?: unknown;
  override readonly cause?: unknown;

  constructor(details: OpenAiCompatibleErrorDetails) {
    super(details.message);
    this.name = "OpenAiCompatibleRequestError";
    this.status = details.status;
    this.providerCode = details.providerCode;
    this.providerType = details.providerType;
    this.retryAfterMs = details.retryAfterMs;
    this.retryable = details.retryable;
    this.shouldRetry = details.shouldRetry;
    this.authentication = details.authentication;
    this.body = details.body;
    this.cause = details.cause;
  }
}

export class OpenAiCompatibleAbortError extends Error {
  constructor(message = "OpenAI-compatible request aborted") {
    super(message);
    this.name = "OpenAiCompatibleAbortError";
  }
}

export class OpenAiCompatibleTimeoutError extends OpenAiCompatibleRequestError {
  constructor(timeoutMs: number) {
    super({
      message: `OpenAI-compatible request timed out after ${timeoutMs} ms`,
      providerCode: "timeout",
      retryable: true,
      authentication: false,
    });
    this.name = "OpenAiCompatibleTimeoutError";
  }
}

export async function createOpenAiCompatibleHttpError(
  response: Response,
  options: {
    maxBodyBytes?: number;
    now?: () => number;
    sensitiveValues?: readonly string[];
  } = {},
): Promise<OpenAiCompatibleRequestError> {
  const body = await readBoundedErrorBody(
    response,
    options.maxBodyBytes ?? DEFAULT_MAX_ERROR_BODY_BYTES,
  );
  const sanitizedValue = redactSensitiveValue(
    body.value,
    options.sensitiveValues,
  );
  const sanitizedText = redactSensitiveText(body.text, options.sensitiveValues);
  const extracted = extractProviderError(sanitizedValue);
  const status = response.status;
  const shouldRetry = parseShouldRetry(response.headers);
  const message = boundUtf8Text(
    extracted.message ||
      sanitizedText ||
      `OpenAI-compatible request failed with HTTP ${status}`,
    DEFAULT_MAX_ERROR_MESSAGE_BYTES,
  );
  return new OpenAiCompatibleRequestError({
    message,
    status,
    providerCode: extracted.code,
    providerType: extracted.type,
    retryAfterMs: parseRetryAfterMs(
      response.headers,
      options.now?.() ?? Date.now(),
    ),
    retryable: shouldRetry ?? isRetryableStatus(status),
    ...(shouldRetry !== undefined ? { shouldRetry } : {}),
    authentication: status === 401 || status === 403,
    body: boundJsonValue(sanitizedValue),
  });
}

export function createOpenAiCompatibleInBandError(
  value: unknown,
  options: { sensitiveValues?: readonly string[] } = {},
): OpenAiCompatibleRequestError {
  const sanitizedValue = redactSensitiveValue(value, options.sensitiveValues);
  const extracted = extractProviderError(sanitizedValue);
  return new OpenAiCompatibleRequestError({
    message: boundUtf8Text(
      extracted.message || "OpenAI-compatible provider returned a stream error",
      DEFAULT_MAX_ERROR_MESSAGE_BYTES,
    ),
    providerCode: extracted.code,
    providerType: extracted.type,
    retryable: isRetryableProviderCode(extracted.code),
    authentication: isAuthenticationProviderError(
      extracted.code,
      extracted.type,
    ),
    body: boundJsonValue(sanitizedValue),
  });
}

export function toOpenAiCompatibleRequestError(
  error: unknown,
  options: { sensitiveValues?: readonly string[] } = {},
): OpenAiCompatibleRequestError | OpenAiCompatibleAbortError {
  if (
    error instanceof OpenAiCompatibleRequestError ||
    error instanceof OpenAiCompatibleAbortError
  ) {
    return error;
  }
  if (isAbortLike(error)) return new OpenAiCompatibleAbortError();
  const message = redactSensitiveText(
    error instanceof Error ? error.message : String(error),
    options.sensitiveValues,
  );
  return new OpenAiCompatibleRequestError({
    message: boundUtf8Text(
      message || "OpenAI-compatible request failed",
      DEFAULT_MAX_ERROR_MESSAGE_BYTES,
    ),
    retryable: true,
    authentication: false,
  });
}

export function isOpenAiCompatibleRetryableError(error: unknown): boolean {
  return error instanceof OpenAiCompatibleRequestError && error.retryable;
}

export function parseShouldRetry(headers: Headers): boolean | undefined {
  const value = headers.get("x-should-retry")?.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function parseRetryAfterMs(
  headers: Headers,
  now = Date.now(),
): number | undefined {
  const milliseconds = headers.get("retry-after-ms");
  if (milliseconds !== null) {
    const parsed = Number.parseFloat(milliseconds);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isRetryableProviderCode(code: string | undefined): boolean {
  if (!code) return false;
  const numericCode = Number(code);
  return (
    (Number.isInteger(numericCode) && isRetryableStatus(numericCode)) ||
    /rate|limit|overload|timeout|temporar|unavailable/i.test(code)
  );
}

function isAuthenticationProviderError(
  code: string | undefined,
  type: string | undefined,
): boolean {
  return (
    code === "401" ||
    code === "403" ||
    /auth|api.?key|unauthor/i.test(`${code ?? ""} ${type ?? ""}`)
  );
}

function isAbortLike(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

async function readBoundedErrorBody(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; value: unknown }> {
  if (!response.body) return { text: "", value: undefined };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (bytes < maxBytes) {
    const result = await reader.read();
    if (result.done) break;
    const remaining = maxBytes - bytes;
    const chunk = result.value.slice(0, remaining);
    chunks.push(chunk);
    bytes += chunk.byteLength;
    if (bytes >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(combined).trim();
  try {
    return { text, value: text ? JSON.parse(text) : undefined };
  } catch {
    return { text, value: text };
  }
}

function extractProviderError(value: unknown): {
  message?: string;
  code?: string;
  type?: string;
} {
  const root = isRecord(value) && isRecord(value.error) ? value.error : value;
  if (!isRecord(root)) return {};
  return {
    message: typeof root.message === "string" ? root.message : undefined,
    code:
      typeof root.code === "string" || typeof root.code === "number"
        ? String(root.code)
        : undefined,
    type: typeof root.type === "string" ? root.type : undefined,
  };
}

function redactSensitiveValue(
  value: unknown,
  sensitiveValues: readonly string[] = [],
): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  const redacted = redactSensitiveText(serialized, sensitiveValues);
  try {
    return JSON.parse(redacted);
  } catch {
    return undefined;
  }
}

function redactSensitiveText(
  value: string,
  sensitiveValues: readonly string[] = [],
): string {
  let redacted = value;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue)
      redacted = redacted.split(sensitiveValue).join("[REDACTED]");
  }
  return redacted;
}

function boundJsonValue(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (
      new TextEncoder().encode(serialized).byteLength <=
      DEFAULT_MAX_ERROR_BODY_BYTES
    ) {
      return value;
    }
    return boundUtf8Text(serialized, DEFAULT_MAX_ERROR_BODY_BYTES);
  } catch {
    return undefined;
  }
}

function boundUtf8Text(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const ellipsis = "…";
  const contentLimit = Math.max(
    0,
    maxBytes - encoder.encode(ellipsis).byteLength,
  );
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > contentLimit) break;
    result += character;
    bytes += characterBytes;
  }
  return result + (maxBytes >= 3 ? ellipsis : "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
