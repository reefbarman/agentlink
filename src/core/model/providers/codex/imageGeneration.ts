import { randomUUID } from "crypto";

import {
  type CodexResolvedAuthForClient,
  getCodexEndpointConfig,
} from "./openaiClient.js";
import { CODEX_DEFAULT_MODEL, remapToChatgptBackendModel } from "./models.js";

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
  size?: string;
  quality?: string;
  background?: string;
  output_format?: string;
}

export class CodexImageGenerationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
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
}): Promise<{ images: CodexGeneratedImage[]; eventTypes: string[] }> {
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
    if (
      event.type !== "response.image_generation_call.partial_image" ||
      typeof event.partial_image_b64 !== "string"
    ) {
      return;
    }

    const eventWithIdentity = event as StreamImageEvent & {
      item_id?: string;
      output_index?: number;
      partial_image_index?: number;
    };
    const identity =
      eventWithIdentity.item_id ??
      (typeof eventWithIdentity.output_index === "number"
        ? `output:${eventWithIdentity.output_index}`
        : typeof eventWithIdentity.partial_image_index === "number"
          ? `partial:${eventWithIdentity.partial_image_index}`
          : `fallback:${fallbackImageEventIndex++}`);
    let slot = imageSlots.get(identity);
    if (slot === undefined) {
      if (imageSlots.size >= params.maxImages) return;
      slot = imageSlots.size;
      imageSlots.set(identity, slot);
    }

    const bytes = Buffer.from(event.partial_image_b64, "base64");
    images[slot] = {
      bytes: bytes.byteLength,
      mimeType: "image/png",
      base64: event.partial_image_b64,
      size: event.size,
      quality: event.quality,
      background: event.background,
      output_format: event.output_format,
      event_type: event.type,
    };
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
  return { images, eventTypes };
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
    if (parsed.images.length === 0) {
      throw new Error(
        "Codex image generation completed without an image payload",
      );
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
