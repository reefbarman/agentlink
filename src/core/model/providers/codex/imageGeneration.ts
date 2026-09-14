import { randomUUID } from "crypto";

import { PNG } from "pngjs";

import {
  CODEX_DEFAULT_MODEL,
  getCodexEndpointConfig,
  remapToChatgptBackendModel,
  type CodexResolvedAuthForClient,
} from "@agentlink/core/codex";

export const CODEX_IMAGE_GENERATION_MAX_COUNT = 4;
export const CODEX_IMAGE_GENERATION_MAX_REFERENCE_IMAGES = 8;
export const CODEX_IMAGE_GENERATION_DEFAULT_TIMEOUT_MS = 300_000;
export const CODEX_IMAGE_GENERATION_MODELS = [
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
] as const;
export type CodexImageGenerationModel =
  (typeof CODEX_IMAGE_GENERATION_MODELS)[number];
export const CODEX_IMAGE_GENERATION_DEFAULT_MODEL: CodexImageGenerationModel =
  "gpt-image-2.5-flare";

export const CODEX_IMAGE_GENERATION_QUALITIES = [
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type CodexImageGenerationQuality =
  (typeof CODEX_IMAGE_GENERATION_QUALITIES)[number];
export const CODEX_IMAGE_GENERATION_BACKGROUNDS = [
  "auto",
  "opaque",
  "transparent",
] as const;
export type CodexImageGenerationBackground =
  (typeof CODEX_IMAGE_GENERATION_BACKGROUNDS)[number];
export const CODEX_IMAGE_GENERATION_OUTPUT_FORMATS = [
  "png",
  "jpeg",
  "webp",
] as const;
export type CodexImageGenerationOutputFormat =
  (typeof CODEX_IMAGE_GENERATION_OUTPUT_FORMATS)[number];
export const CODEX_IMAGE_GENERATION_ACTIONS = [
  "auto",
  "generate",
  "edit",
] as const;
export type CodexImageGenerationAction =
  (typeof CODEX_IMAGE_GENERATION_ACTIONS)[number];
export const CODEX_IMAGE_GENERATION_INPUT_FIDELITIES = ["low", "high"] as const;
export type CodexImageGenerationInputFidelity =
  (typeof CODEX_IMAGE_GENERATION_INPUT_FIDELITIES)[number];

export interface CodexImageGenerationOptions {
  outputSize?: string;
  quality?: CodexImageGenerationQuality;
  background?: CodexImageGenerationBackground;
  outputFormat?: CodexImageGenerationOutputFormat;
  outputCompression?: number;
  action?: CodexImageGenerationAction;
  inputFidelity?: CodexImageGenerationInputFidelity;
  maskImage?: CodexImageReferenceImage;
}

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

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    bytes.byteLength < 24 ||
    !bytes.subarray(0, signature.byteLength).equals(signature) ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw new Error("Edit target and mask must be valid PNG images");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function validateCodexMaskedEdit(params: {
  editImage: CodexImageReferenceImage | undefined;
  maskImage: CodexImageReferenceImage | undefined;
}): void {
  if (!params.maskImage) return;
  if (!params.editImage)
    throw new Error("A mask requires an explicit edit image");
  if (
    params.editImage.mimeType !== "image/png" ||
    params.maskImage.mimeType !== "image/png"
  ) {
    throw new Error(
      "Masked edits currently require PNG target and mask images",
    );
  }
  const maxBytes = 50 * 1024 * 1024;
  const editBytes = Buffer.from(params.editImage.base64, "base64");
  const maskBytes = Buffer.from(params.maskImage.base64, "base64");
  if (editBytes.byteLength >= maxBytes || maskBytes.byteLength >= maxBytes) {
    throw new Error("Edit target and mask must each be smaller than 50 MB");
  }
  const editDimensions = pngDimensions(editBytes);
  const maskDimensions = pngDimensions(maskBytes);
  const maxPixels = 8_294_400;
  if (
    editDimensions.width * editDimensions.height > maxPixels ||
    maskDimensions.width * maskDimensions.height > maxPixels
  ) {
    throw new Error("Edit target and mask must each be no larger than 4K");
  }
  if (
    editDimensions.width !== maskDimensions.width ||
    editDimensions.height !== maskDimensions.height
  ) {
    throw new Error("edit target and mask must have matching dimensions");
  }
  let maskMetadata: ReturnType<typeof PNG.sync.read>;
  try {
    PNG.sync.read(editBytes);
    maskMetadata = PNG.sync.read(maskBytes);
  } catch {
    throw new Error("Edit target and mask must be valid PNG images");
  }
  if (!maskMetadata.alpha) {
    throw new Error("mask image must contain an alpha channel");
  }
}

export interface CodexGeneratedImage {
  bytes: number;
  mimeType: string;
  base64: string;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: string;
  provider_id?: string;
  revised_prompt?: string;
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
  kind: "partial" | "final";
  identity?: string;
  outputIndex?: number;
  partialImageIndex?: number;
  size?: string;
  quality?: string;
  background?: string;
  outputFormat?: string;
  revisedPrompt?: string;
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
  partialImages: CodexGeneratedImage[];
  eventTypes: string[];
  responseId?: string;
  usage?: Record<string, unknown>;
  terminalFailure?: Omit<CodexImageGenerationFailure, "eventTypes">;
}

export class CodexImageGenerationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly failure?: CodexImageGenerationFailure,
    readonly partialImages: CodexGeneratedImage[] = [],
  ) {
    super(message);
    this.name = "CodexImageGenerationError";
  }
}

export function normalizeCodexImageGenerationModel(
  value: unknown,
): CodexImageGenerationModel {
  if (value == null) return CODEX_IMAGE_GENERATION_DEFAULT_MODEL;
  if (
    typeof value === "string" &&
    CODEX_IMAGE_GENERATION_MODELS.includes(value as CodexImageGenerationModel)
  ) {
    return value as CodexImageGenerationModel;
  }
  throw new Error(
    `image_model must be one of: ${CODEX_IMAGE_GENERATION_MODELS.join(", ")}`,
  );
}

export function getCodexImageGenerationModel(
  auth: CodexImageGenerationAuth,
): string {
  return auth.method === "oauth"
    ? remapToChatgptBackendModel(CODEX_DEFAULT_MODEL)
    : CODEX_DEFAULT_MODEL;
}

export function assertCodexImageGenerationOptionsSupported(
  auth: CodexImageGenerationAuth,
  options: CodexImageGenerationOptions,
): void {
  if (auth.method !== "oauth") return;
  const unsupported = [
    options.outputSize ? "output_size" : undefined,
    options.quality ? "quality" : undefined,
    options.background ? "background" : undefined,
    options.outputFormat ? "output_format" : undefined,
    options.outputCompression !== undefined ? "output_compression" : undefined,
    options.action ? "action" : undefined,
    options.inputFidelity ? "input_fidelity" : undefined,
    options.maskImage ? "mask_image" : undefined,
  ].filter((value): value is string => Boolean(value));
  if (unsupported.length > 0) {
    throw new Error(
      `Codex OAuth support is not yet verified for image option${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}. Use the existing defaults, or configure an OpenAI API key with model access.`,
    );
  }
}

export function buildCodexImageGenerationRequestBody(params: {
  prompt: string;
  count: number;
  model: string;
  imageModel: CodexImageGenerationModel;
  size?: string;
  options?: CodexImageGenerationOptions;
  referenceImages?: CodexImageReferenceImage[];
}): Record<string, unknown> {
  const options = params.options ?? {};
  const formatLabel = options.outputFormat?.toUpperCase() ?? "PNG";
  const countInstruction =
    params.count === 1
      ? `Create exactly one ${formatLabel} image.`
      : `Create exactly ${params.count} distinct ${formatLabel} images.`;
  const sizeInstruction = params.size ? ` Requested size: ${params.size}.` : "";
  const referenceImages = params.referenceImages ?? [];
  const imageTool = {
    type: "image_generation",
    model: params.imageModel,
    ...(options.outputSize ? { size: options.outputSize } : {}),
    ...(options.quality ? { quality: options.quality } : {}),
    ...(options.background ? { background: options.background } : {}),
    ...(options.outputFormat ? { output_format: options.outputFormat } : {}),
    ...(options.outputCompression !== undefined
      ? { output_compression: options.outputCompression }
      : {}),
    ...(options.action ? { action: options.action } : {}),
    ...(options.inputFidelity ? { input_fidelity: options.inputFidelity } : {}),
    ...(options.maskImage
      ? {
          input_image_mask: {
            image_url: `data:${options.maskImage.mimeType};base64,${options.maskImage.base64}`,
          },
        }
      : {}),
  };
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
    tools: [imageTool],
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
  outputFormat?: CodexImageGenerationOutputFormat;
  generatedImages?: CodexGeneratedImage[];
  partialImages?: CodexGeneratedImage[];
}): Promise<CodexImageGenerationSseResult> {
  if (!params.response.body) {
    throw new Error(
      "Codex image generation response did not include a stream body",
    );
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const finalSlots = new Map<string, number>();
  const partialSlots = new Map<string, number>();
  const images = params.generatedImages ?? [];
  const partialImages = params.partialImages ?? [];
  const eventTypes: string[] = [];
  let terminalFailure:
    | Omit<CodexImageGenerationFailure, "eventTypes">
    | undefined;
  let observedQuotaConsumed: boolean | "unknown" = "unknown";
  let responseId: string | undefined;
  let usage: Record<string, unknown> | undefined;
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
    responseId = firstString(response?.id) ?? responseId;
    usage = isRecord(response?.usage) ? response.usage : usage;
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
            (payload.kind === "partial"
              ? "partial:fallback"
              : `fallback:${fallbackImageEventIndex++}`));
      const slots = payload.kind === "final" ? finalSlots : partialSlots;
      const destination = payload.kind === "final" ? images : partialImages;
      let slot = slots.get(identity);
      if (slot === undefined) {
        if (slots.size >= params.maxImages) continue;
        slot = slots.size;
        slots.set(identity, slot);
      }

      const prior =
        payload.kind === "final"
          ? partialImages[partialSlots.get(identity) ?? -1]
          : undefined;
      const bytes = Buffer.from(payload.base64, "base64");
      const outputFormat =
        detectOutputFormat(bytes) ??
        normalizeReturnedOutputFormat(payload.outputFormat) ??
        params.outputFormat;
      destination[slot] = {
        ...prior,
        ...destination[slot],
        bytes: bytes.byteLength,
        mimeType: outputFormatToMimeType(outputFormat),
        base64: payload.base64,
        ...(payload.size ? { size: payload.size } : {}),
        ...(payload.quality ? { quality: payload.quality } : {}),
        ...(payload.background ? { background: payload.background } : {}),
        ...(outputFormat ? { output_format: outputFormat } : {}),
        ...(payload.identity ? { provider_id: payload.identity } : {}),
        ...(payload.revisedPrompt
          ? { revised_prompt: payload.revisedPrompt }
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
    partialImages,
    eventTypes,
    ...(responseId ? { responseId } : {}),
    ...(usage ? { usage } : {}),
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
      ? `ended with ${failure.category} after completed image output`
      : result.partialImages.length > 0
        ? `ended with ${failure.category} after partial image output`
        : `returned no image (${failure.category})`;
  return new CodexImageGenerationError(
    `Codex image generation ${outcome}${detail}`,
    undefined,
    failure,
    result.partialImages,
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
    payloads.push(
      imagePayloadFromRecord(event, event.partial_image_b64, "partial"),
    );
  }
  if (
    event.type === "response.image_generation_call.completed" &&
    typeof event.result === "string"
  ) {
    payloads.push(imagePayloadFromRecord(event, event.result, "final"));
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
        "final",
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
      payloads.push(
        imagePayloadFromRecord(output, output.result, "final", outputIndex),
      );
    }
  }
  return payloads;
}

function imagePayloadFromRecord(
  record: Record<string, unknown>,
  base64: string,
  kind: "partial" | "final",
  fallbackOutputIndex?: number,
): StreamImagePayload {
  return {
    base64,
    kind,
    identity: firstString(record.item_id, record.id),
    outputIndex: numericValue(record.output_index) ?? fallbackOutputIndex,
    partialImageIndex: numericValue(record.partial_image_index),
    size: firstString(record.size),
    quality: firstString(record.quality),
    background: firstString(record.background),
    outputFormat: firstString(record.output_format),
    revisedPrompt: firstString(record.revised_prompt),
  };
}

function detectOutputFormat(
  bytes: Buffer,
): CodexImageGenerationOutputFormat | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "png";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  return undefined;
}

function normalizeReturnedOutputFormat(
  value: string | undefined,
): CodexImageGenerationOutputFormat | undefined {
  return CODEX_IMAGE_GENERATION_OUTPUT_FORMATS.includes(
    value as CodexImageGenerationOutputFormat,
  )
    ? (value as CodexImageGenerationOutputFormat)
    : undefined;
}

function outputFormatToMimeType(
  outputFormat: CodexImageGenerationOutputFormat | undefined,
): string {
  switch (outputFormat) {
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
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
  options: CodexImageGenerationOptions;
  imageModel: CodexImageGenerationModel;
  referenceImages: CodexImageReferenceImage[];
  deadlineMs: number;
  generatedImages: CodexGeneratedImage[];
  partialImages: CodexGeneratedImage[];
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<{
  images: CodexGeneratedImage[];
  partialImages: CodexGeneratedImage[];
  eventTypes: string[];
  responseId?: string;
  usage?: Record<string, unknown>;
  model: string;
  imageModel: CodexImageGenerationModel;
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
          imageModel: params.imageModel,
          size: params.size,
          options: params.options,
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
      outputFormat: params.options.outputFormat,
      generatedImages: params.generatedImages,
      partialImages: params.partialImages,
    });
    if (parsed.terminalFailure || parsed.images.length === 0) {
      throw createCodexImageGenerationResultError(parsed);
    }
    return { ...parsed, model, imageModel: params.imageModel };
  } finally {
    clearTimeout(timeout);
  }
}

function isTransientError(error: unknown): boolean {
  if (error instanceof CodexImageGenerationError) {
    return error.status
      ? [408, 409, 429, 500, 502, 503, 504].includes(error.status)
      : error.failure?.retryable === true &&
          error.failure.quotaConsumed === false;
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
  options?: CodexImageGenerationOptions;
  imageModel: CodexImageGenerationModel;
  referenceImages?: CodexImageReferenceImage[];
  timeoutMs: number;
  generatedImages?: CodexGeneratedImage[];
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<{
  images: CodexGeneratedImage[];
  partialImages: CodexGeneratedImage[];
  eventTypes: string[];
  responseId?: string;
  usage?: Record<string, unknown>;
  model: string;
  imageModel: CodexImageGenerationModel;
}> {
  const deadlineMs = Date.now() + params.timeoutMs;
  const generatedImages = params.generatedImages ?? [];
  const partialImages: CodexGeneratedImage[] = [];
  const options = params.options ?? {};
  assertCodexImageGenerationOptionsSupported(params.auth, options);
  let lastError: unknown;
  for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt++) {
    try {
      return await callCodexImageGeneration({
        auth: params.auth,
        prompt: params.prompt,
        count: params.count,
        size: params.size,
        options,
        imageModel: params.imageModel,
        referenceImages: params.referenceImages ?? [],
        deadlineMs,
        generatedImages,
        partialImages,
        sessionId: params.sessionId,
        signal: params.signal,
      });
    } catch (error) {
      lastError = error;
      if (
        generatedImages.length > 0 ||
        partialImages.length > 0 ||
        !isTransientError(error) ||
        attempt === TRANSIENT_RETRIES
      ) {
        break;
      }
    }
  }
  throw lastError;
}

export function codexGeneratedImageMetadata(
  images: CodexGeneratedImage[],
): Array<Omit<CodexGeneratedImage, "base64">> {
  return images.map(({ base64: _base64, ...metadata }) => metadata);
}
