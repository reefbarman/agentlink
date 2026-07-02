import * as fs from "fs/promises";
import * as path from "path";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import { openAiCodexAuthManager } from "../agent/providers/codex/OpenAiCodexAuthManager.js";
import {
  codexGeneratedImageMetadata,
  CODEX_IMAGE_GENERATION_DEFAULT_TIMEOUT_MS,
  CODEX_IMAGE_GENERATION_MAX_COUNT,
  CodexImageGenerationError,
  generateCodexImages,
  parseCodexImageGenerationSse,
  type CodexGeneratedImage,
  type CodexImageReferenceImage,
} from "../core/model/providers/codex/imageGeneration.js";
import type { SessionImageReference } from "../agent/toolAdapter.js";
import { toSupportedImageMediaType } from "../agent/providers/types.js";
import {
  errorResult,
  type OnApprovalRequest,
  type ToolResult,
} from "../shared/types.js";
import { getRelativePath, resolveAndValidatePath } from "../util/paths.js";

const MAX_COUNT = CODEX_IMAGE_GENERATION_MAX_COUNT;
const DEFAULT_TIMEOUT_MS = CODEX_IMAGE_GENERATION_DEFAULT_TIMEOUT_MS;
const DEFAULT_RECENT_IMAGE_COUNT = 4;
const MAX_REFERENCE_IMAGES = 8;

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

export type GenerateImageReferenceImage = CodexImageReferenceImage;

export type GeneratedImage = CodexGeneratedImage & {
  path?: string;
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

function outputPathInput(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
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

export { buildCodexImageGenerationRequestBody as buildRequestBodyForTest } from "../core/model/providers/codex/imageGeneration.js";

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
  targets?: Array<{ relPath: string }>;
  referenceImages?: GenerateImageReferenceImage[];
  billing: string;
}): Promise<ImageGenerationApprovalResult> {
  const referenceImages = params.referenceImages ?? [];
  const targets = params.targets ?? [];
  const detail = [
    `Generation prompt:\n${params.prompt}`,
    `Images: ${params.count}`,
    params.size ? `Requested size: ${params.size}` : undefined,
    referenceImages.length > 0
      ? `Reference images (${referenceImages.length}):`
      : undefined,
    ...referenceImages.map((image) => `- ${image.label}`),
    `Billing: ${params.billing}`,
    targets.length > 0
      ? "Outputs:"
      : "Output: chat display only (no files will be written)",
    ...targets.map((target) => `- ${target.relPath}`),
    "",
    targets.length > 0
      ? "Image generation consumes ChatGPT/Codex image quota or OpenAI API-key billing before files are written."
      : "Image generation consumes ChatGPT/Codex image quota or OpenAI API-key billing before images are returned to chat.",
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
  targets?: Array<{ absolutePath: string; relPath: string }>;
  maxImages: number;
  generatedImages: GeneratedImage[];
}): Promise<{ images: GeneratedImage[]; eventTypes: string[] }> {
  const parsed = await parseCodexImageGenerationSse({
    response: params.response,
    maxImages: params.maxImages,
    generatedImages: params.generatedImages,
  });
  const images = parsed.images as GeneratedImage[];
  for (const [index, image] of images.entries()) {
    const target = params.targets?.[index];
    if (!target) continue;
    await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
    await fs.writeFile(
      target.absolutePath,
      Buffer.from(image.base64, "base64"),
    );
    images[index] = { ...image, path: target.relPath };
  }
  return { images, eventTypes: parsed.eventTypes };
}

async function writeGeneratedImageTargets(params: {
  images: GeneratedImage[];
  targets?: Array<{ absolutePath: string; relPath: string }>;
}): Promise<GeneratedImage[]> {
  if (!params.targets?.length) return params.images;
  const images = [...params.images];
  for (const [index, image] of images.entries()) {
    const target = params.targets[index];
    if (!target) continue;
    await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
    await fs.writeFile(
      target.absolutePath,
      Buffer.from(image.base64, "base64"),
    );
    images[index] = { ...image, path: target.relPath };
  }
  return images;
}

function buildGenerateImageSuccessResult(params: {
  result: { images: GeneratedImage[]; eventTypes: string[]; model: string };
  billing: string;
  refreshedAuth?: boolean;
  requestedCount: number;
  referenceImages: GenerateImageReferenceImage[];
  followUp?: string;
}): ToolResult {
  const { result, referenceImages } = params;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            status: "accepted",
            model: result.model,
            billing: params.billing,
            ...(params.refreshedAuth ? { refreshed_auth: true } : {}),
            requested_count: params.requestedCount,
            generated_count: result.images.length,
            saved: result.images.some((image) => Boolean(image.path)),
            reference_images: referenceImages.map((image) => ({
              source: image.source,
              label: image.label,
              mime_type: image.mimeType,
            })),
            images: codexGeneratedImageMetadata(result.images),
            event_types: Array.from(new Set(result.eventTypes)),
            ...(params.followUp ? { follow_up: params.followUp } : {}),
          },
          null,
          2,
        ),
      },
      ...result.images.map((image) => ({
        type: "image" as const,
        data: image.base64,
        mimeType: image.mimeType,
      })),
    ],
  };
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
    const outputPath = outputPathInput(params.output_path);
    const targets = outputPath
      ? await resolveOutputTargets(outputPath, count)
      : undefined;
    const generatedImages: GeneratedImage[] = [];

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
              output_paths: targets?.map((target) => target.relPath) ?? [],
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
      const rawResult = await generateCodexImages({
        auth,
        prompt,
        count,
        size,
        referenceImages,
        timeoutMs,
        generatedImages,
        sessionId,
      });
      const result = {
        ...rawResult,
        images: await writeGeneratedImageTargets({
          images: rawResult.images,
          targets,
        }),
      };
      return buildGenerateImageSuccessResult({
        result,
        billing,
        requestedCount: count,
        referenceImages,
        followUp: approval.followUp,
      });
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
        const rawResult = await generateCodexImages({
          auth,
          prompt,
          count,
          size,
          referenceImages,
          timeoutMs,
          generatedImages,
          sessionId,
        });
        const result = {
          ...rawResult,
          images: await writeGeneratedImageTargets({
            images: rawResult.images,
            targets,
          }),
        };
        return buildGenerateImageSuccessResult({
          result,
          billing,
          refreshedAuth: true,
          requestedCount: count,
          referenceImages,
          followUp: approval.followUp,
        });
      }
      if (generatedImages.length > 0 && error instanceof Error) {
        return errorResult(error.message, {
          partial_images: codexGeneratedImageMetadata(generatedImages),
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
