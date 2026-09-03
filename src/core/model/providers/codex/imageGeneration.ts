import { randomUUID } from "crypto";

import {
  CODEX_DEFAULT_MODEL,
  getCodexEndpointConfig,
  remapToChatgptBackendModel,
  type CodexResolvedAuthForClient,
} from "@agentlink/core/codex";

export const CODEX_IMAGE_GENERATION_MAX_COUNT = 4;
export const CODEX_IMAGE_GENERATION_DEFAULT_TIMEOUT_MS = 300_000;

const TRANSIENT_RETRIES = 2;

export interface CodexImageGenerationAuth extends CodexResolvedAuthForClient {
  accountLabel?: string;
}

export interface CodexImageReferenceImage {
  id: string;
  label: string;
  mimeType: string;
  base64: string;
  source: "file" | "session";
}

export interface CodexGeneratedImage {
  bytes: number;
  mimeType: string;
  base64: string;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: string;
  event_type: string;
}

interface StreamImageEvent {
  type?: string;
  partial_image_b64?: string;
  result?: string;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: string;
  [key: string]: unknown;
}

interface StreamImagePayload {
  base64: string;
  identity?: string;
  outputIndex?: number;
  partialImageIndex?: number;
  size?: string;
  quality?: string;
  background?: string;
  outputFormat?: string;
}

export type CodexImageGenerationFailureCategory =
  | "refusal"
  | "provider_error"
  | "incomplete"
  | "no_image";

export interface CodexImageGenerationFailure {
  category: CodexImageGenerationFailureCategory;
  eventType?: string;
  code?: string;
  message?: string;
  retryable: boolean;
  quotaConsumed: boolean | "unknown";
  eventTypes: string[];
}

export interface CodexImageGenerationSseResult {
  images: CodexGeneratedImage[];
  eventTypes: string[];
  terminalFailure?: Omit<CodexImageGenerationFailure, "eventTypes">;
}

export class CodexImageGenerationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly failure?: CodexImageGenerationFailure,
  ) {
    super(message);
    this.name = "CodexImageGenerationError";
  }
}

export function getCodexImageGenerationModel(
  auth: CodexImageGenerationAuth,
): string {
  return auth.method === "oauth"
    ? remapToChatgptBackendModel(CODEX_DEFAULT_MODEL)
    : CODEX_DEFAULT_MODEL;
}

export function buildCodexImageGenerationRequestBody(params: {
  prompt: string;
  count: number;
  model: string;
  size?: string;
  referenceImages?: CodexImageReferenceImage[];
}): Record<string, unknown> {
  const countInstruction =
    params.count === 1
      ? "Create exactly one PNG image."
      : `Create exactly ${params.count} distinct PNG images.`;
  const sizeInstruction = params.size ? ` Requested size: ${params.size}.` : "";
  const referenceImages = params.referenceImages ?? [];
  return {
    model: params.model,
    stream: true,
    store: false,
    instructions: `You are an image generation helper. Use the image_generation tool. ${countInstruction}${sizeInstruction} Do not add commentary.`,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Use image generation. ${params.prompt}`,
          },
          ...referenceImages.map((image) => ({
            type: "input_image",
            image_url: `data:${image.mimeType};base64,${image.base64}`,
            detail: "auto",
          })),
        ],
      },
    ],
    tools: [{ type: "image_generation" }],
    tool_choice: { type: "image_generation" },
  };
}

function buildImageGenerationHeaders(params: {
  auth: CodexImageGenerationAuth;
  sessionId: string;
}): Record<string, string> {
  const endpoint = getCodexEndpointConfig(params.auth, params.sessionId);
  return {
    ...endpoint.defaultHeaders,
    authorization: `Bearer ${params.auth.bearerToken}`,
    "content-type": "application/json",
    accept: "text/event-stream",
  };
}

export async function parseCodexImageGenerationSse(params: {
  response: Response;
  maxImages: number;
  generatedImages?: CodexGeneratedImage[];
}): Promise<CodexImageGenerationSseResult> {
  if (!params.response.body) {
    throw new Error(
      "Codex image generation response did not include a stream body",
    );
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const imageSlots = new Map<string, number>();
  const images = params.generatedImages ?? [];
  const eventTypes: string[] = [];
  let terminalFailure:
    | Omit<CodexImageGenerationFailure, "eventTypes">
    | undefined;
  let observedQuotaConsumed: boolean | "unknown" = "unknown";
  let fallbackImageEventIndex = 0;

  function handleLine(line: string): void {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") return;

    let event: StreamImageEvent;
    try {
      event = JSON.parse(data) as StreamImageEvent;
    } catch {
      return;
    }

    if (event.type) eventTypes.push(event.type);
    const response = isRecord(event.response) ? event.response : undefined;
    const explicitQuota = explicitQuotaConsumed(event, response);
    if (explicitQuota !== "unknown") observedQuotaConsumed = explicitQuota;
    const classifiedFailure = classifyImageGenerationTerminalEvent(event);
    if (
      classifiedFailure &&
      (terminalFailure?.category !== "refusal" ||
        classifiedFailure.category === "refusal")
    ) {
      terminalFailure = classifiedFailure;
    }
    for (const payload of extractImageGenerationPayloads(event)) {
      const identity =
        typeof payload.outputIndex === "number"
          ? `output:${payload.outputIndex}`
          : (payload.identity ??
            (typeof payload.partialImageIndex === "number"
              ? `partial:${payload.partialImageIndex}`
              : `fallback:${fallbackImageEventIndex++}`));
      let slot = imageSlots.get(identity);
      if (slot === undefined) {
        if (imageSlots.size >= params.maxImages) continue;
        slot = imageSlots.size;
        imageSlots.set(identity, slot);
      }

      const bytes = Buffer.from(payload.base64, "base64");
      images[slot] = {
        ...images[slot],
        bytes: bytes.byteLength,
        mimeType: "image/png",
        base64: payload.base64,
        ...(payload.size ? { size: payload.size } : {}),
        ...(payload.quality ? { quality: payload.quality } : {}),
        ...(payload.background ? { background: payload.background } : {}),
        ...(payload.outputFormat
          ? { output_format: payload.outputFormat }
          : {}),
        event_type: event.type ?? "image_generation_call",
      };
    }
  }

  const reader = params.response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      handleLine(line);
    }
  }
  if (buffer.trim()) handleLine(buffer.trim());
  return {
    images,
    eventTypes,
    terminalFailure:
      terminalFailure && observedQuotaConsumed !== "unknown"
        ? { ...terminalFailure, quotaConsumed: observedQuotaConsumed }
        : terminalFailure,
  };
}

export function createCodexImageGenerationResultError(
  result: CodexImageGenerationSseResult,
): CodexImageGenerationError {
  const terminal = result.terminalFailure ?? {
    category: "no_image" as const,
    retryable: false,
    quotaConsumed: "unknown" as const,
  };
  const failure: CodexImageGenerationFailure = {
    ...terminal,
    eventTypes: Array.from(new Set(result.eventTypes)),
  };
  const detail = failure.message ? `: ${failure.message}` : "";
  const outcome =
    result.images.length > 0
      ? `ended with ${failure.category} after partial image output`
      : `returned no image (${failure.category})`;
  return new CodexImageGenerationError(
    `Codex image generation ${outcome}${detail}`,
    undefined,
    failure,
  );
}

export function codexImageGenerationErrorMetadata(
  error: unknown,
): Record<string, unknown> | undefined {
  if (!(error instanceof CodexImageGenerationError) || !error.failure) {
    return undefined;
  }
  return {
    failure_category: error.failure.category,
    retryable: error.failure.retryable,
    quota_consumed: error.failure.quotaConsumed,
    generated_count: 0,
    event_types: error.failure.eventTypes,
    ...(error.failure.eventType
      ? { provider_event_type: error.failure.eventType }
      : {}),
    ...(error.failure.code ? { provider_code: error.failure.code } : {}),
    ...(error.failure.message
      ? { provider_message: error.failure.message }
      : {}),
  };
}

function classifyImageGenerationTerminalEvent(
  event: StreamImageEvent,
): Omit<CodexImageGenerationFailure, "eventTypes"> | undefined {
  const eventType = event.type;
  if (!eventType) return undefined;

  const response = isRecord(event.response) ? event.response : undefined;
  const error = isRecord(event.error)
    ? event.error
    : isRecord(response?.error)
      ? response.error
      : undefined;
  const quotaConsumed = explicitQuotaConsumed(event, response);

  if (eventType.includes("refusal")) {
    return {
      category: "refusal",
      eventType,
      message: firstString(event.delta, event.refusal, event.message),
      retryable: false,
      quotaConsumed,
    };
  }

  const outputRefusal = findResponseRefusal(response?.output);
  if (outputRefusal) {
    return {
      category: "refusal",
      eventType,
      message: outputRefusal,
      retryable: false,
      quotaConsumed,
    };
  }

  if (eventType === "response.error" || eventType === "error") {
    const code = firstString(error?.code, error?.type, event.code);
    return {
      category: "provider_error",
      eventType,
      code,
      message: firstString(error?.message, event.message),
      retryable: isRetryableProviderCode(code),
      quotaConsumed,
    };
  }

  if (eventType === "response.failed") {
    const code = firstString(error?.code, error?.type, response?.status);
    return {
      category: "provider_error",
      eventType,
      code,
      message: firstString(error?.message, event.message),
      retryable: isRetryableProviderCode(code),
      quotaConsumed,
    };
  }

  if (
    eventType === "response.incomplete" ||
    response?.status === "incomplete"
  ) {
    const details = isRecord(response?.incomplete_details)
      ? response.incomplete_details
      : undefined;
    return {
      category: "incomplete",
      eventType,
      code: firstString(details?.reason, response?.status),
      message: firstString(details?.message, event.message),
      retryable: true,
      quotaConsumed,
    };
  }

  return undefined;
}

function extractImageGenerationPayloads(
  event: StreamImageEvent,
): StreamImagePayload[] {
  const payloads: StreamImagePayload[] = [];
  if (
    event.type === "response.image_generation_call.partial_image" &&
    typeof event.partial_image_b64 === "string"
  ) {
    payloads.push(imagePayloadFromRecord(event, event.partial_image_b64));
  }
  if (
    event.type === "response.image_generation_call.completed" &&
    typeof event.result === "string"
  ) {
    payloads.push(imagePayloadFromRecord(event, event.result));
  }

  const item = isRecord(event.item) ? event.item : undefined;
  if (
    item?.type === "image_generation_call" &&
    typeof item.result === "string"
  ) {
    payloads.push(
      imagePayloadFromRecord(
        item,
        item.result,
        numericValue(event.output_index),
      ),
    );
  }

  const response = isRecord(event.response) ? event.response : undefined;
  if (Array.isArray(response?.output)) {
    for (const [outputIndex, output] of response.output.entries()) {
      if (
        !isRecord(output) ||
        output.type !== "image_generation_call" ||
        typeof output.result !== "string"
      ) {
        continue;
      }
      payloads.push(imagePayloadFromRecord(output, output.result, outputIndex));
    }
  }
  return payloads;
}

function imagePayloadFromRecord(
  record: Record<string, unknown>,
  base64: string,
  fallbackOutputIndex?: number,
): StreamImagePayload {
  return {
    base64,
    identity: firstString(record.item_id, record.id),
    outputIndex: numericValue(record.output_index) ?? fallbackOutputIndex,
    partialImageIndex: numericValue(record.partial_image_index),
    size: firstString(record.size),
    quality: firstString(record.quality),
    background: firstString(record.background),
    outputFormat: firstString(record.output_format),
  };
}

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function explicitQuotaConsumed(
  event: StreamImageEvent,
  response?: Record<string, unknown>,
): boolean | "unknown" {
  const explicit =
    typeof event.quota_consumed === "boolean"
      ? event.quota_consumed
      : typeof response?.quota_consumed === "boolean"
        ? response.quota_consumed
        : undefined;
  return explicit ?? "unknown";
}

function findResponseRefusal(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content) || content.type !== "refusal") continue;
      return firstString(content.refusal, content.text) ?? "Provider refused";
    }
  }
  return undefined;
}

function isRetryableProviderCode(code: string | undefined): boolean {
  return Boolean(
    code &&
    /rate|limit|quota|timeout|overload|server|unavailable|internal|network/i.test(
      code,
    ),
  );
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 500);
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function callCodexImageGeneration(params: {
  auth: CodexImageGenerationAuth;
  prompt: string;
  count: number;
  size?: string;
  referenceImages: CodexImageReferenceImage[];
  deadlineMs: number;
  generatedImages: CodexGeneratedImage[];
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<{
  images: CodexGeneratedImage[];
  eventTypes: string[];
  model: string;
}> {
  const model = getCodexImageGenerationModel(params.auth);
  const remainingMs = params.deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new CodexImageGenerationError("Codex image generation timed out");
  }

  const requestSessionId = params.sessionId ?? randomUUID();
  const endpoint = getCodexEndpointConfig(params.auth, requestSessionId);
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), remainingMs);
  const signal = params.signal
    ? AbortSignal.any([params.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const response = await fetch(`${endpoint.baseURL}/responses`, {
      method: "POST",
      headers: buildImageGenerationHeaders({
        auth: params.auth,
        sessionId: requestSessionId,
      }),
      body: JSON.stringify(
        buildCodexImageGenerationRequestBody({
          prompt: params.prompt,
          count: params.count,
          model,
          size: params.size,
          referenceImages: params.referenceImages,
        }),
      ),
      signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const detail = body ? `: ${body.slice(0, 500)}` : "";
      throw new CodexImageGenerationError(
        `Codex image generation failed (${response.status})${detail}`,
        response.status,
      );
    }

    const parsed = await parseCodexImageGenerationSse({
      response,
      maxImages: params.count,
      generatedImages: params.generatedImages,
    });
    if (parsed.terminalFailure || parsed.images.length === 0) {
      throw createCodexImageGenerationResultError(parsed);
    }
    return { ...parsed, model };
  } finally {
    clearTimeout(timeout);
  }
}

function isTransientError(error: unknown): boolean {
  if (error instanceof CodexImageGenerationError) {
    return error.status
      ? [408, 409, 429, 500, 502, 503, 504].includes(error.status)
      : false;
  }
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return false;
  return /network|socket|terminated/i.test(error.message);
}

export async function generateCodexImages(params: {
  auth: CodexImageGenerationAuth;
  prompt: string;
  count: number;
  size?: string;
  referenceImages?: CodexImageReferenceImage[];
  timeoutMs: number;
  generatedImages?: CodexGeneratedImage[];
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<{
  images: CodexGeneratedImage[];
  eventTypes: string[];
  model: string;
}> {
  const deadlineMs = Date.now() + params.timeoutMs;
  const generatedImages = params.generatedImages ?? [];
  let lastError: unknown;
  for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt++) {
    try {
      return await callCodexImageGeneration({
        auth: params.auth,
        prompt: params.prompt,
        count: params.count,
        size: params.size,
        referenceImages: params.referenceImages ?? [],
        deadlineMs,
        generatedImages,
        sessionId: params.sessionId,
        signal: params.signal,
      });
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === TRANSIENT_RETRIES) break;
    }
  }
  throw lastError;
}

export function codexGeneratedImageMetadata(
  images: CodexGeneratedImage[],
): Array<Omit<CodexGeneratedImage, "base64">> {
  return images.map(({ base64: _base64, ...metadata }) => metadata);
}
