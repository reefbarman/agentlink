import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import {
  openAiCodexAuthManager,
  type OpenAiCodexResolvedAuth,
} from "../agent/providers/codex/OpenAiCodexAuthManager.js";
import {
  CODEX_API_BASE_URL,
  OPENAI_API_BASE_URL,
} from "../agent/providers/codex/openaiClient.js";
import {
  CODEX_DEFAULT_MODEL,
  remapToChatgptBackendModel,
} from "../agent/providers/codex/models.js";
import type { SessionImageReference } from "../agent/toolAdapter.js";
import { toSupportedImageMediaType } from "../agent/providers/types.js";
import {
  errorResult,
  type OnApprovalRequest,
  type ToolResult,
} from "../shared/types.js";
import { getRelativePath, resolveAndValidatePath } from "../util/paths.js";

const DEFAULT_OUTPUT_DIR = "generated-images";
const MAX_COUNT = 4;
const DEFAULT_TIMEOUT_MS = 300_000;
const TRANSIENT_RETRIES = 2;
const DEFAULT_RECENT_IMAGE_COUNT = 4;
const MAX_REFERENCE_IMAGES = 8;

class CodexImageGenerationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CodexImageGenerationError";
  }
}

type GenerateImageParams = {
  prompt?: unknown;
  output_path?: unknown;
  size?: unknown;
  count?: unknown;
  timeout_seconds?: unknown;
  reference_image_paths?: unknown;
  reference_image_ids?: unknown;
  use_recent_images?: unknown;
};

export type GenerateImageReferenceImage = {
  id: string;
  label: string;
  mimeType: string;
  base64: string;
  source: "file" | "session";
};

export type GeneratedImage = {
  path: string;
  bytes: number;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: string;
  event_type: string;
};

type StreamImageEvent = {
  type?: string;
  partial_image_b64?: string;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: string;
};

function normalizePrompt(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("prompt is required");
  }
  return value.trim();
}

function normalizeCount(value: unknown): number {
  const numeric = Number(value ?? 1);
  if (!Number.isFinite(numeric) || numeric < 1) return 1;
  return Math.min(Math.floor(numeric), MAX_COUNT);
}

function normalizeTimeoutMs(value: unknown): number {
  const numeric = Number(value ?? DEFAULT_TIMEOUT_MS / 1000);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(numeric * 1000), DEFAULT_TIMEOUT_MS);
}

function normalizeSize(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.trim();
}

function outputPathInput(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : DEFAULT_OUTPUT_DIR;
}

function normalizeStringArray(value: unknown, fieldName: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings`);
  }
  return value
    .map((item) => {
      if (typeof item !== "string") {
        throw new Error(`${fieldName} must be an array of strings`);
      }
      return item.trim();
    })
    .filter((item) => item.length > 0);
}

function normalizeUseRecentImages(value: unknown): boolean | number {
  if (value == null || value === false) return false;
  if (value === true) return true;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return false;
  return Math.min(Math.floor(numeric), MAX_REFERENCE_IMAGES);
}

function extensionToMimeType(filePath: string): string | null {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

function normalizeReferenceMimeType(params: {
  mimeType: string;
  name: string;
}): string | null {
  const declared = toSupportedImageMediaType(params.mimeType);
  if (declared) return declared;
  const fromExtension = extensionToMimeType(params.name);
  return fromExtension ? toSupportedImageMediaType(fromExtension) : null;
}

function uniqueById(
  images: GenerateImageReferenceImage[],
): GenerateImageReferenceImage[] {
  const seen = new Set<string>();
  return images.filter((image) => {
    if (seen.has(image.id)) return false;
    seen.add(image.id);
    return true;
  });
}

function looksLikePngFile(inputPath: string): boolean {
  return path.extname(inputPath).toLowerCase() === ".png";
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveReferenceImageFiles(
  referenceImagePaths: string[],
): Promise<GenerateImageReferenceImage[]> {
  const images: GenerateImageReferenceImage[] = [];
  for (const inputPath of referenceImagePaths) {
    const { absolutePath, inWorkspace } = resolveAndValidatePath(inputPath);
    if (!inWorkspace) {
      throw new Error(
        `reference_image_paths entry must resolve inside the workspace: ${inputPath}`,
      );
    }
    const mimeType = extensionToMimeType(absolutePath);
    if (!mimeType || !toSupportedImageMediaType(mimeType)) {
      throw new Error(
        `reference image must be PNG, JPEG, GIF, or WebP: ${inputPath}`,
      );
    }
    const bytes = await fs.readFile(absolutePath);
    images.push({
      id: `file:${absolutePath}`,
      label: getRelativePath(absolutePath),
      mimeType,
      base64: bytes.toString("base64"),
      source: "file",
    });
  }
  return images;
}

function resolveSessionReferenceImages(params: {
  referenceImageIds: string[];
  useRecentImages: boolean | number;
  getSessionImages?: () => SessionImageReference[];
}): GenerateImageReferenceImage[] {
  const sessionImages = params.getSessionImages?.() ?? [];
  const byId = new Map(sessionImages.map((image) => [image.id, image]));
  const selected: SessionImageReference[] = [];

  for (const id of params.referenceImageIds) {
    const image = byId.get(id);
    if (!image) {
      const available = sessionImages.map((item) => item.id).join(", ");
      throw new Error(
        `No prior session image found for reference_image_ids entry "${id}"${available ? `. Available image IDs: ${available}` : ""}`,
      );
    }
    selected.push(image);
  }

  if (params.useRecentImages) {
    const recentCount =
      params.useRecentImages === true
        ? DEFAULT_RECENT_IMAGE_COUNT
        : params.useRecentImages;
    selected.push(...sessionImages.slice(-recentCount));
  }

  return selected.map((image) => {
    const mimeType = normalizeReferenceMimeType({
      mimeType: image.mimeType,
      name: image.name,
    });
    if (!mimeType) {
      throw new Error(
        `Prior session image "${image.id}" (${image.name}) has an unsupported MIME type: ${image.mimeType || "unknown"}`,
      );
    }
    return {
      id: `session:${image.id}`,
      label: `${image.id} (${image.name})`,
      mimeType,
      base64: image.base64,
      source: "session",
    };
  });
}

export async function resolveReferenceImagesForTest(params: {
  referenceImagePaths?: unknown;
  referenceImageIds?: unknown;
  useRecentImages?: unknown;
  getSessionImages?: () => SessionImageReference[];
}): Promise<GenerateImageReferenceImage[]> {
  const fileImages = await resolveReferenceImageFiles(
    normalizeStringArray(params.referenceImagePaths, "reference_image_paths"),
  );
  const sessionImages = resolveSessionReferenceImages({
    referenceImageIds: normalizeStringArray(
      params.referenceImageIds,
      "reference_image_ids",
    ),
    useRecentImages: normalizeUseRecentImages(params.useRecentImages),
    getSessionImages: params.getSessionImages,
  });
  const images = uniqueById([...fileImages, ...sessionImages]);
  if (images.length > MAX_REFERENCE_IMAGES) {
    throw new Error(
      `generate_image supports at most ${MAX_REFERENCE_IMAGES} reference images`,
    );
  }
  return images;
}

async function resolveOutputTargets(
  outputPath: string,
  count: number,
): Promise<Array<{ absolutePath: string; relPath: string }>> {
  const isFile = looksLikePngFile(outputPath);
  const baseInput = isFile ? outputPath : path.join(outputPath, "image.png");
  const { absolutePath, inWorkspace } = resolveAndValidatePath(baseInput);
  if (!inWorkspace) {
    throw new Error(
      "generate_image output_path must resolve inside the workspace",
    );
  }

  const directory = path.dirname(absolutePath);
  const ext = ".png";
  const basename = isFile
    ? path.basename(absolutePath, ext)
    : `image-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  const targets: Array<{ absolutePath: string; relPath: string }> = [];
  for (let index = 0; index < count; index++) {
    const suffix = count === 1 ? "" : `-${index + 1}`;
    let candidate = path.join(directory, `${basename}${suffix}${ext}`);
    let collision = 1;
    while (await pathExists(candidate)) {
      candidate = path.join(
        directory,
        `${basename}${suffix}-${collision}${ext}`,
      );
      collision += 1;
    }
    targets.push({
      absolutePath: candidate,
      relPath: getRelativePath(candidate),
    });
  }
  return targets;
}

export function buildRequestBodyForTest(params: {
  prompt: string;
  count: number;
  model: string;
  size?: string;
  referenceImages?: GenerateImageReferenceImage[];
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

function buildHeaders(
  auth: OpenAiCodexResolvedAuth,
  sessionId: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${auth.bearerToken}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    "user-agent": `agentlink/1.0 (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`,
  };
  if (auth.method === "oauth") {
    headers.originator = "agentlink";
    headers.session_id = sessionId;
    if (auth.accountId) {
      headers["ChatGPT-Account-Id"] = auth.accountId;
    }
  }
  return headers;
}

function getBaseUrl(auth: OpenAiCodexResolvedAuth): string {
  return auth.method === "oauth" ? CODEX_API_BASE_URL : OPENAI_API_BASE_URL;
}

function getModel(auth: OpenAiCodexResolvedAuth): string {
  return auth.method === "oauth"
    ? remapToChatgptBackendModel(CODEX_DEFAULT_MODEL)
    : CODEX_DEFAULT_MODEL;
}

type ImageGenerationApprovalResult = {
  approved: boolean;
  followUp?: string;
  rejectionReason?: string;
};

export async function requestImageGenerationApprovalForTest(params: {
  approvalManager: ApprovalManager;
  sessionId: string;
  onApprovalRequest?: OnApprovalRequest;
  prompt: string;
  count: number;
  size?: string;
  targets: Array<{ relPath: string }>;
  referenceImages?: GenerateImageReferenceImage[];
  billing: string;
}): Promise<ImageGenerationApprovalResult> {
  const referenceImages = params.referenceImages ?? [];
  const detail = [
    `Generation prompt:\n${params.prompt}`,
    `Images: ${params.count}`,
    params.size ? `Requested size: ${params.size}` : undefined,
    referenceImages.length > 0
      ? `Reference images (${referenceImages.length}):`
      : undefined,
    ...referenceImages.map((image) => `- ${image.label}`),
    `Billing: ${params.billing}`,
    "Outputs:",
    ...params.targets.map((target) => `- ${target.relPath}`),
    "",
    "Image generation consumes ChatGPT/Codex image quota or OpenAI API-key billing before files are written.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  if (params.onApprovalRequest) {
    const raw = await params.onApprovalRequest(
      {
        kind: "write",
        title: `Generate ${params.count} image${params.count === 1 ? "" : "s"}?`,
        detail,
        choices: [
          { label: "Generate", value: "accept", isPrimary: true },
          { label: "Deny", value: "reject", isDanger: true },
        ],
      },
      params.sessionId,
    );
    const decision = typeof raw === "string" ? raw : raw.decision;
    return {
      approved: decision === "accept" || decision.startsWith("accept-"),
      followUp: typeof raw === "string" ? undefined : raw.followUp,
      rejectionReason:
        typeof raw === "string" ? undefined : raw.rejectionReason,
    };
  }

  return { approved: false };
}

export async function parseCodexImageSseForTest(params: {
  response: Response;
  targets: Array<{ absolutePath: string; relPath: string }>;
  maxImages: number;
  writtenImages: GeneratedImage[];
}): Promise<{ images: GeneratedImage[]; eventTypes: string[] }> {
  if (!params.response.body) {
    throw new Error(
      "Codex image generation response did not include a stream body",
    );
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const imageSlots = new Map<string, number>();
  const images = params.writtenImages;
  const eventTypes: string[] = [];

  async function handleLine(line: string): Promise<void> {
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
        : `fallback:${images.length}`);
    let slot = imageSlots.get(identity);
    if (slot === undefined) {
      if (imageSlots.size >= params.maxImages) return;
      slot = imageSlots.size;
      imageSlots.set(identity, slot);
    }

    const target = params.targets[slot];
    if (!target) return;
    const bytes = Buffer.from(event.partial_image_b64, "base64");
    await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
    await fs.writeFile(target.absolutePath, bytes);
    images[slot] = {
      path: target.relPath,
      bytes: bytes.byteLength,
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
      await handleLine(line);
    }
  }
  if (buffer.trim()) await handleLine(buffer.trim());
  return { images, eventTypes };
}

async function callCodexImageGeneration(params: {
  auth: OpenAiCodexResolvedAuth;
  prompt: string;
  count: number;
  size?: string;
  referenceImages: GenerateImageReferenceImage[];
  timeoutMs: number;
  targets: Array<{ absolutePath: string; relPath: string }>;
  deadlineMs: number;
  writtenImages: GeneratedImage[];
}): Promise<{ images: GeneratedImage[]; eventTypes: string[]; model: string }> {
  const model = getModel(params.auth);
  const remainingMs = params.deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new CodexImageGenerationError("Codex image generation timed out");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);
  try {
    const response = await fetch(`${getBaseUrl(params.auth)}/responses`, {
      method: "POST",
      headers: buildHeaders(params.auth, crypto.randomUUID()),
      body: JSON.stringify(
        buildRequestBodyForTest({
          prompt: params.prompt,
          count: params.count,
          model,
          size: params.size,
          referenceImages: params.referenceImages,
        }),
      ),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const detail = body ? `: ${body.slice(0, 500)}` : "";
      throw new CodexImageGenerationError(
        `Codex image generation failed (${response.status})${detail}`,
        response.status,
      );
    }

    const parsed = await parseCodexImageSseForTest({
      response,
      targets: params.targets,
      maxImages: params.count,
      writtenImages: params.writtenImages,
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

async function generateWithRetries(params: {
  auth: OpenAiCodexResolvedAuth;
  prompt: string;
  count: number;
  size?: string;
  referenceImages: GenerateImageReferenceImage[];
  timeoutMs: number;
  targets: Array<{ absolutePath: string; relPath: string }>;
  deadlineMs: number;
  writtenImages: GeneratedImage[];
}): Promise<{ images: GeneratedImage[]; eventTypes: string[]; model: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt++) {
    try {
      return await callCodexImageGeneration(params);
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === TRANSIENT_RETRIES) break;
    }
  }
  throw lastError;
}

export async function handleGenerateImage(
  params: GenerateImageParams,
  approvalManager: ApprovalManager,
  sessionId: string,
  onApprovalRequest?: OnApprovalRequest,
  getSessionImages?: () => SessionImageReference[],
): Promise<ToolResult> {
  try {
    const prompt = normalizePrompt(params.prompt);
    const count = normalizeCount(params.count);
    const size = normalizeSize(params.size);
    const timeoutMs = normalizeTimeoutMs(params.timeout_seconds);
    const referenceImages = await resolveReferenceImagesForTest({
      referenceImagePaths: params.reference_image_paths,
      referenceImageIds: params.reference_image_ids,
      useRecentImages: params.use_recent_images,
      getSessionImages,
    });
    const targets = await resolveOutputTargets(
      outputPathInput(params.output_path),
      count,
    );
    const writtenImages: GeneratedImage[] = [];

    let auth = await openAiCodexAuthManager.resolveModelAuth();
    if (!auth) {
      return errorResult(
        "OpenAI/Codex auth is not configured. Sign in with ChatGPT/Codex OAuth or add an OpenAI API key before using generate_image.",
      );
    }

    const billing =
      auth.method === "oauth"
        ? `ChatGPT/Codex OAuth quota (${auth.oauthAccountLabel ?? auth.oauthAccountEmail ?? "active account"})`
        : "OpenAI API key billing";

    const approval = await requestImageGenerationApprovalForTest({
      approvalManager,
      sessionId,
      onApprovalRequest,
      prompt,
      count,
      size,
      targets,
      referenceImages,
      billing,
    });
    if (!approval.approved) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "rejected_by_user",
              output_paths: targets.map((target) => target.relPath),
              ...(approval.rejectionReason
                ? { reason: approval.rejectionReason }
                : {}),
              ...(approval.followUp ? { follow_up: approval.followUp } : {}),
            }),
          },
        ],
      };
    }

    try {
      const result = await generateWithRetries({
        auth,
        prompt,
        count,
        size,
        referenceImages,
        timeoutMs,
        targets,
        deadlineMs: Date.now() + timeoutMs,
        writtenImages,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "accepted",
                model: result.model,
                billing,
                requested_count: count,
                generated_count: result.images.length,
                reference_images: referenceImages.map((image) => ({
                  source: image.source,
                  label: image.label,
                  mime_type: image.mimeType,
                })),
                images: result.images,
                event_types: Array.from(new Set(result.eventTypes)),
                ...(approval.followUp ? { follow_up: approval.followUp } : {}),
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      if (
        auth.method === "oauth" &&
        error instanceof CodexImageGenerationError &&
        error.status === 401
      ) {
        const refreshed = await openAiCodexAuthManager.forceRefreshModelAuth(
          auth.method,
          { oauthAccountPoolId: auth.oauthAccountPoolId },
        );
        if (!refreshed) {
          throw new Error("Codex OAuth refresh failed after 401 response");
        }
        auth = refreshed;
        const result = await generateWithRetries({
          auth,
          prompt,
          count,
          size,
          referenceImages,
          timeoutMs,
          targets,
          deadlineMs: Date.now() + timeoutMs,
          writtenImages,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "accepted",
                  model: result.model,
                  billing,
                  refreshed_auth: true,
                  requested_count: count,
                  generated_count: result.images.length,
                  reference_images: referenceImages.map((image) => ({
                    source: image.source,
                    label: image.label,
                    mime_type: image.mimeType,
                  })),
                  images: result.images,
                  event_types: Array.from(new Set(result.eventTypes)),
                  ...(approval.followUp
                    ? { follow_up: approval.followUp }
                    : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      if (writtenImages.length > 0 && error instanceof Error) {
        return errorResult(error.message, {
          partial_images: writtenImages,
          ...(approval.followUp ? { follow_up: approval.followUp } : {}),
        });
      }
      return errorResult(
        error instanceof Error ? error.message : String(error),
        approval.followUp ? { follow_up: approval.followUp } : undefined,
      );
    }
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}
