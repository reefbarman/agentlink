import * as fs from "fs/promises";
import * as path from "path";

import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import { openAiCodexAuthManager } from "../agent/providers/codex/OpenAiCodexAuthManager.js";
import {
  assertCodexImageGenerationOptionsSupported,
  codexGeneratedImageMetadata,
  codexImageGenerationErrorMetadata,
  CODEX_IMAGE_GENERATION_ACTIONS,
  CODEX_IMAGE_GENERATION_BACKGROUNDS,
  CODEX_IMAGE_GENERATION_DEFAULT_TIMEOUT_MS,
  CODEX_IMAGE_GENERATION_INPUT_FIDELITIES,
  CODEX_IMAGE_GENERATION_MAX_COUNT,
  CODEX_IMAGE_GENERATION_MAX_REFERENCE_IMAGES,
  CODEX_IMAGE_GENERATION_OUTPUT_FORMATS,
  CODEX_IMAGE_GENERATION_QUALITIES,
  CodexImageGenerationError,
  generateCodexImages,
  normalizeCodexImageGenerationModel,
  validateCodexMaskedEdit,
  type CodexImageGenerationAction,
  type CodexImageGenerationBackground,
  type CodexImageGenerationInputFidelity,
  type CodexImageGenerationModel,
  type CodexImageGenerationOptions,
  type CodexImageGenerationOutputFormat,
  type CodexImageGenerationQuality,
  parseCodexImageGenerationSse,
  type CodexGeneratedImage,
  type CodexImageGenerationSseResult,
  type CodexImageReferenceImage,
} from "../core/model/providers/codex/imageGeneration.js";
import type { SessionImageReference } from "../agent/toolAdapter.js";
import { toSupportedImageMediaType } from "../agent/providers/types.js";
import { errorResult, type ToolResult } from "@agentlink/protocol/tool-result";
import type { OnApprovalRequest } from "@agentlink/protocol/inline-approval";
import { getRelativePath, resolveAndValidatePath } from "../util/paths.js";

const MAX_COUNT = CODEX_IMAGE_GENERATION_MAX_COUNT;
const DEFAULT_TIMEOUT_MS = CODEX_IMAGE_GENERATION_DEFAULT_TIMEOUT_MS;
const DEFAULT_RECENT_IMAGE_COUNT = 4;
const MAX_REFERENCE_IMAGES = CODEX_IMAGE_GENERATION_MAX_REFERENCE_IMAGES;

type GenerateImageParams = {
  prompt?: unknown;
  image_model?: unknown;
  output_path?: unknown;
  size?: unknown;
  output_size?: unknown;
  quality?: unknown;
  background?: unknown;
  output_format?: unknown;
  output_compression?: unknown;
  action?: unknown;
  input_fidelity?: unknown;
  edit_image_path?: unknown;
  edit_image_id?: unknown;
  mask_image_path?: unknown;
  mask_image_id?: unknown;
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

function normalizeEnum<T extends string>(params: {
  value: unknown;
  values: readonly T[];
  fieldName: string;
}): T | undefined {
  if (params.value == null) return undefined;
  if (
    typeof params.value === "string" &&
    params.values.includes(params.value as T)
  ) {
    return params.value as T;
  }
  throw new Error(
    `${params.fieldName} must be one of: ${params.values.join(", ")}`,
  );
}

function normalizeOutputSize(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("output_size must be auto or WIDTHxHEIGHT");
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto") return normalized;
  const match = /^(\d+)x(\d+)$/.exec(normalized);
  if (!match) throw new Error("output_size must be auto or WIDTHxHEIGHT");
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const ratio = width / height;
  if (
    width % 16 !== 0 ||
    height % 16 !== 0 ||
    width > 3840 ||
    height > 3840 ||
    ratio < 1 / 3 ||
    ratio > 3 ||
    pixels < 655_360 ||
    pixels > 8_294_400
  ) {
    throw new Error(
      "output_size dimensions must be multiples of 16, each no larger than 3840, use an aspect ratio from 1:3 to 3:1, and contain 655360 to 8294400 pixels",
    );
  }
  return normalized;
}

function normalizeOutputCompression(value: unknown): number | undefined {
  if (value == null) return undefined;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 100) {
    throw new Error("output_compression must be an integer from 0 to 100");
  }
  return numeric;
}

function optionalString(value: unknown, fieldName: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
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

const OUTPUT_FORMAT_EXTENSIONS: Record<
  CodexImageGenerationOutputFormat,
  readonly string[]
> = {
  png: [".png"],
  jpeg: [".jpg", ".jpeg"],
  webp: [".webp"],
};

function outputFormatFromPath(
  outputPath: string | undefined,
): CodexImageGenerationOutputFormat | undefined {
  if (!outputPath) return undefined;
  const extension = path.extname(outputPath).toLowerCase();
  return CODEX_IMAGE_GENERATION_OUTPUT_FORMATS.find((format) =>
    OUTPUT_FORMAT_EXTENSIONS[format].includes(extension),
  );
}

function outputExtension(format: CodexImageGenerationOutputFormat): string {
  return format === "jpeg" ? ".jpg" : `.${format}`;
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

export function resolveSessionReferenceImages(params: {
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

async function resolveSingleImage(params: {
  pathValue?: unknown;
  idValue?: unknown;
  pathField: string;
  idField: string;
  getSessionImages?: () => SessionImageReference[];
}): Promise<GenerateImageReferenceImage | undefined> {
  const imagePath = optionalString(params.pathValue, params.pathField);
  const imageId = optionalString(params.idValue, params.idField);
  if (imagePath && imageId) {
    throw new Error(
      `${params.pathField} and ${params.idField} are mutually exclusive`,
    );
  }
  const images = await resolveReferenceImagesForTest({
    referenceImagePaths: imagePath ? [imagePath] : [],
    referenceImageIds: imageId ? [imageId] : [],
    getSessionImages: params.getSessionImages,
  });
  return images[0];
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
  outputFormat: CodexImageGenerationOutputFormat,
): Promise<Array<{ absolutePath: string; relPath: string }>> {
  const suppliedFormat = outputFormatFromPath(outputPath);
  const extension = path.extname(outputPath).toLowerCase();
  const isFile = Boolean(suppliedFormat);
  if (suppliedFormat && suppliedFormat !== outputFormat) {
    throw new Error(
      `output_path extension does not match output_format ${outputFormat}`,
    );
  }
  const ext = isFile ? extension : outputExtension(outputFormat);
  const baseInput = isFile ? outputPath : path.join(outputPath, `image${ext}`);
  const { absolutePath, inWorkspace } = resolveAndValidatePath(baseInput);
  if (!inWorkspace) {
    throw new Error(
      "generate_image output_path must resolve inside the workspace",
    );
  }

  const directory = path.dirname(absolutePath);
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
  imageModel: CodexImageGenerationModel;
  size?: string;
  options?: CodexImageGenerationOptions;
  targets?: Array<{ relPath: string; absolutePath?: string }>;
  referenceImages?: GenerateImageReferenceImage[];
  editImage?: GenerateImageReferenceImage;
  billing: string;
}): Promise<ImageGenerationApprovalResult> {
  const options = params.options ?? {};
  const advanced = Object.keys(options).length > 0;
  if (
    !advanced &&
    params.approvalManager.isBuiltInToolApproved(
      params.sessionId,
      "generate_image",
    )
  ) {
    return { approved: true };
  }

  const referenceImages = params.referenceImages ?? [];
  const targets = params.targets ?? [];
  const detail = [
    `Generation prompt:\n${params.prompt}`,
    `Images: ${params.count}`,
    `Image model: ${params.imageModel}`,
    params.size ? `Best-effort size hint: ${params.size}` : undefined,
    options.outputSize ? `Output size: ${options.outputSize}` : undefined,
    options.quality ? `Quality: ${options.quality}` : undefined,
    options.background ? `Background: ${options.background}` : undefined,
    options.outputFormat ? `Output format: ${options.outputFormat}` : undefined,
    options.outputCompression !== undefined
      ? `Output compression: ${options.outputCompression}`
      : undefined,
    options.action ? `Action: ${options.action}` : undefined,
    options.inputFidelity
      ? `Input fidelity: ${options.inputFidelity}`
      : undefined,
    params.editImage ? `Edit target: ${params.editImage.label}` : undefined,
    options.maskImage ? `Mask: ${options.maskImage.label}` : undefined,
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
    advanced
      ? "Advanced Image 2.5 controls and edits require approval for each call."
      : "Generate for Session also authorizes later legacy generate_image calls in this chat, including creation of new workspace PNG outputs.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  if (params.onApprovalRequest) {
    const raw = await params.onApprovalRequest(
      {
        kind: "write",
        title: `Generate ${params.count} image${params.count === 1 ? "" : "s"}?`,
        detail,
        targetPath:
          targets[0]?.absolutePath ??
          (targets.length === 1 ? targets[0]?.relPath : undefined),
        choices: advanced
          ? [
              { label: "Generate", value: "accept", isPrimary: true },
              { label: "Deny", value: "reject", isDanger: true },
            ]
          : [
              { label: "Generate", value: "accept", isPrimary: true },
              { label: "Generate for Session", value: "accept-session" },
              { label: "Deny", value: "reject", isDanger: true },
            ],
        writeChoices: advanced
          ? [
              { label: "Generate", value: "accept", isPrimary: true },
              { label: "Deny", value: "reject", isDanger: true },
            ]
          : [
              { label: "Generate", value: "accept", isPrimary: true },
              { label: "Generate for Session", value: "accept-session" },
              { label: "Deny", value: "reject", isDanger: true },
            ],
      },
      params.sessionId,
    );
    const decision = typeof raw === "string" ? raw : raw.decision;
    if (decision === "accept-session" && !advanced) {
      params.approvalManager.approveBuiltInTool(
        params.sessionId,
        "generate_image",
      );
    }
    return {
      approved: decision === "accept" || decision === "accept-session",
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
}): Promise<
  Omit<CodexImageGenerationSseResult, "images"> & { images: GeneratedImage[] }
> {
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
  return { ...parsed, images };
}

function assertGeneratedImageFormat(
  image: GeneratedImage,
  expectedFormat: CodexImageGenerationOutputFormat,
): void {
  const bytes = Buffer.from(image.base64, "base64");
  const matches =
    expectedFormat === "png"
      ? bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : expectedFormat === "jpeg"
        ? bytes[0] === 0xff && bytes[1] === 0xd8
        : bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
          bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!matches) {
    throw new Error(
      `Generated image bytes do not match requested ${expectedFormat} output format`,
    );
  }
}

async function writeGeneratedImageTargets(params: {
  images: GeneratedImage[];
  outputFormat: CodexImageGenerationOutputFormat;
  targets?: Array<{ absolutePath: string; relPath: string }>;
}): Promise<GeneratedImage[]> {
  if (!params.targets?.length) return params.images;
  const images = [...params.images];
  for (const [index, image] of images.entries()) {
    const target = params.targets[index];
    if (!target) continue;
    assertGeneratedImageFormat(image, params.outputFormat);
    await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
    await fs.writeFile(
      target.absolutePath,
      Buffer.from(image.base64, "base64"),
    );
    images[index] = { ...image, path: target.relPath };
  }
  return images;
}

function buildGenerateImageErrorResult(params: {
  error: unknown;
  generatedImages: GeneratedImage[];
  followUp?: string;
}): ToolResult {
  const message =
    params.error instanceof Error ? params.error.message : String(params.error);
  const failureMetadata = codexImageGenerationErrorMetadata(params.error);
  const partialImages =
    params.error instanceof CodexImageGenerationError
      ? params.error.partialImages
      : [];
  const result = errorResult(message, {
    ...failureMetadata,
    ...(params.generatedImages.length > 0
      ? {
          generated_count: params.generatedImages.length,
          completed_images: codexGeneratedImageMetadata(params.generatedImages),
        }
      : {}),
    ...(partialImages.length > 0
      ? {
          partial_count: partialImages.length,
          partial_images: codexGeneratedImageMetadata(partialImages),
        }
      : {}),
    ...(params.followUp ? { follow_up: params.followUp } : {}),
  });
  result.content.push(
    ...params.generatedImages.map((image) => ({
      type: "image" as const,
      data: image.base64,
      mimeType: image.mimeType,
    })),
  );
  return result;
}

function requestedOptionsMetadata(
  options: CodexImageGenerationOptions,
): Record<string, unknown> {
  return {
    ...(options.outputSize ? { output_size: options.outputSize } : {}),
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
          mask_image: {
            source: options.maskImage.source,
            label: options.maskImage.label,
            mime_type: options.maskImage.mimeType,
          },
        }
      : {}),
  };
}

function buildGenerateImageSuccessResult(params: {
  result: {
    images: GeneratedImage[];
    partialImages: GeneratedImage[];
    eventTypes: string[];
    responseId?: string;
    usage?: Record<string, unknown>;
    model: string;
    imageModel: CodexImageGenerationModel;
  };
  billing: string;
  refreshedAuth?: boolean;
  requestedCount: number;
  requestedOptions: CodexImageGenerationOptions;
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
            image_model: result.imageModel,
            billing: params.billing,
            ...(params.refreshedAuth ? { refreshed_auth: true } : {}),
            requested_count: params.requestedCount,
            generated_count: result.images.length,
            requested_options: requestedOptionsMetadata(
              params.requestedOptions,
            ),
            saved: result.images.some((image) => Boolean(image.path)),
            reference_images: referenceImages.map((image) => ({
              source: image.source,
              label: image.label,
              mime_type: image.mimeType,
            })),
            images: codexGeneratedImageMetadata(result.images),
            ...(result.responseId ? { response_id: result.responseId } : {}),
            ...(result.usage ? { usage: result.usage } : {}),
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
    const imageModel = normalizeCodexImageGenerationModel(params.image_model);
    const size = normalizeSize(params.size);
    const outputSize = normalizeOutputSize(params.output_size);
    if (size && outputSize) {
      throw new Error("size and output_size cannot be combined");
    }
    const quality = normalizeEnum<CodexImageGenerationQuality>({
      value: params.quality,
      values: CODEX_IMAGE_GENERATION_QUALITIES,
      fieldName: "quality",
    });
    const background = normalizeEnum<CodexImageGenerationBackground>({
      value: params.background,
      values: CODEX_IMAGE_GENERATION_BACKGROUNDS,
      fieldName: "background",
    });
    const requestedOutputFormat =
      normalizeEnum<CodexImageGenerationOutputFormat>({
        value: params.output_format,
        values: CODEX_IMAGE_GENERATION_OUTPUT_FORMATS,
        fieldName: "output_format",
      });
    const outputCompression = normalizeOutputCompression(
      params.output_compression,
    );
    const requestedAction = normalizeEnum<CodexImageGenerationAction>({
      value: params.action,
      values: CODEX_IMAGE_GENERATION_ACTIONS,
      fieldName: "action",
    });
    const inputFidelity = normalizeEnum<CodexImageGenerationInputFidelity>({
      value: params.input_fidelity,
      values: CODEX_IMAGE_GENERATION_INPUT_FIDELITIES,
      fieldName: "input_fidelity",
    });
    const timeoutMs = normalizeTimeoutMs(params.timeout_seconds);
    const editImage = await resolveSingleImage({
      pathValue: params.edit_image_path,
      idValue: params.edit_image_id,
      pathField: "edit_image_path",
      idField: "edit_image_id",
      getSessionImages,
    });
    const maskImage = await resolveSingleImage({
      pathValue: params.mask_image_path,
      idValue: params.mask_image_id,
      pathField: "mask_image_path",
      idField: "mask_image_id",
      getSessionImages,
    });
    if (requestedAction === "edit" && !editImage) {
      throw new Error("action edit requires edit_image_path or edit_image_id");
    }
    if (requestedAction === "generate" && (editImage || maskImage)) {
      throw new Error(
        "action generate cannot be combined with an edit target or mask",
      );
    }
    validateCodexMaskedEdit({ editImage, maskImage });
    const action = editImage || maskImage ? "edit" : requestedAction;
    const referenceImages = await resolveReferenceImagesForTest({
      referenceImagePaths: params.reference_image_paths,
      referenceImageIds: params.reference_image_ids,
      useRecentImages: params.use_recent_images,
      getSessionImages,
    });
    const providerReferenceImages = editImage
      ? uniqueById([editImage, ...referenceImages])
      : referenceImages;
    if (providerReferenceImages.length > MAX_REFERENCE_IMAGES) {
      throw new Error(
        `generate_image supports at most ${MAX_REFERENCE_IMAGES} input images including the edit target`,
      );
    }
    const outputPath = outputPathInput(params.output_path);
    const inferredOutputFormat = outputFormatFromPath(outputPath);
    const outputFormat = requestedOutputFormat ?? inferredOutputFormat ?? "png";
    if (background === "transparent" && outputFormat === "jpeg") {
      throw new Error("transparent backgrounds require PNG or WebP output");
    }
    if (outputCompression !== undefined && outputFormat === "png") {
      throw new Error("output_compression requires JPEG or WebP output");
    }
    const options: CodexImageGenerationOptions = {
      ...(outputSize ? { outputSize } : {}),
      ...(quality ? { quality } : {}),
      ...(background ? { background } : {}),
      ...(requestedOutputFormat ||
      (inferredOutputFormat && inferredOutputFormat !== "png")
        ? { outputFormat }
        : {}),
      ...(outputCompression !== undefined ? { outputCompression } : {}),
      ...(action ? { action } : {}),
      ...(inputFidelity ? { inputFidelity } : {}),
      ...(maskImage ? { maskImage } : {}),
    };
    const targets = outputPath
      ? await resolveOutputTargets(outputPath, count, outputFormat)
      : undefined;
    const generatedImages: GeneratedImage[] = [];

    let auth = await openAiCodexAuthManager.resolveModelAuth();
    if (!auth) {
      return errorResult(
        "OpenAI/Codex auth is not configured. Sign in with ChatGPT/Codex OAuth or add an OpenAI API key before using generate_image.",
      );
    }

    assertCodexImageGenerationOptionsSupported(auth, options);

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
      imageModel,
      size,
      options,
      targets,
      referenceImages,
      editImage,
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
        imageModel,
        size,
        options,
        referenceImages: providerReferenceImages,
        timeoutMs,
        generatedImages,
        sessionId,
      });
      const result = {
        ...rawResult,
        images: await writeGeneratedImageTargets({
          images: rawResult.images,
          outputFormat,
          targets,
        }),
      };
      return buildGenerateImageSuccessResult({
        result,
        billing,
        requestedCount: count,
        requestedOptions: options,
        referenceImages: providerReferenceImages,
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
        assertCodexImageGenerationOptionsSupported(auth, options);
        try {
          const rawResult = await generateCodexImages({
            auth,
            prompt,
            count,
            imageModel,
            size,
            options,
            referenceImages: providerReferenceImages,
            timeoutMs,
            generatedImages,
            sessionId,
          });
          const result = {
            ...rawResult,
            images: await writeGeneratedImageTargets({
              images: rawResult.images,
              outputFormat,
              targets,
            }),
          };
          return buildGenerateImageSuccessResult({
            result,
            billing,
            refreshedAuth: true,
            requestedCount: count,
            requestedOptions: options,
            referenceImages: providerReferenceImages,
            followUp: approval.followUp,
          });
        } catch (refreshError) {
          return buildGenerateImageErrorResult({
            error: refreshError,
            generatedImages,
            followUp: approval.followUp,
          });
        }
      }
      return buildGenerateImageErrorResult({
        error,
        generatedImages,
        followUp: approval.followUp,
      });
    }
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}
