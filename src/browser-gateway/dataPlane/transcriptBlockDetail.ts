import type {
  ChatMessage,
  ContentBlock,
} from "@agentlink/protocol/chat-transcript";

import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "@agentlink/protocol/browser-gateway-data-plane-limits";
import type { BrowserGatewayOwnerCommandBody } from "@agentlink/protocol/browser-gateway-owner-command-body";
import type { BrowserGatewayTranscriptBlockDetailSummary } from "@agentlink/protocol/browser-gateway-transcript-block";

export type TranscriptDisplayBlock = Extract<
  ContentBlock,
  { type: "tool_call" | "skill_load" }
>;
export type TranscriptBlockDetailRequest = Extract<
  BrowserGatewayOwnerCommandBody,
  { kind: "transcript.block-detail" }
>;

interface ResultImageDescriptor {
  mimeType: string;
}
interface ResultDocumentDescriptor extends ResultImageDescriptor {
  name: string;
}

export type TranscriptBlockDetailResponse = {
  request: TranscriptBlockDetailRequest;
} & (
  | {
      state: "ready";
      block: TranscriptDisplayBlock;
      images: ResultImageDescriptor[];
      documents: ResultDocumentDescriptor[];
    }
  | { state: "media"; data: string; mimeType: string; name?: string }
  | { state: "not_found" | "stale_revision" | "too_large" }
);

const detailSummaries = new WeakMap<
  TranscriptDisplayBlock,
  {
    snapshot: TranscriptDisplayBlock;
    summary: BrowserGatewayTranscriptBlockDetailSummary;
  }
>();

export function transcriptBlockContentRevision(
  block: TranscriptDisplayBlock,
): number {
  return transcriptBlockDetailSummary(block).contentRevision;
}

function hashBlock(block: TranscriptDisplayBlock): number {
  return hashString(JSON.stringify(block));
}

function hashString(serialized: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function transcriptBlockDetailSummary(
  block: TranscriptDisplayBlock,
): BrowserGatewayTranscriptBlockDetailSummary {
  const cached = detailSummaries.get(block);
  if (
    cached &&
    Object.keys(block).length === Object.keys(cached.snapshot).length &&
    Object.entries(block).every(([key, value]) =>
      Object.is(value, cached.snapshot[key as keyof TranscriptDisplayBlock]),
    )
  )
    return cached.summary;
  let status: "error" | "interrupted" | undefined;
  if (block.complete) {
    try {
      const result: unknown = JSON.parse(block.result);
      if (isRecord(result)) {
        if (
          (typeof result.error === "string" && result.error.trim()) ||
          result.status === "error" ||
          result.status === "failed"
        )
          status = "error";
        else if (
          [
            "cancelled",
            "rejected",
            "rejected_by_user",
            "timed_out",
            "force-completed",
            "stopped",
          ].includes(String(result.status)) ||
          result.partial === true ||
          (Array.isArray(result.failed_blocks) &&
            result.failed_blocks.length > 0) ||
          (typeof result.malformed_blocks === "number" &&
            result.malformed_blocks > 0) ||
          (block.type === "tool_call" &&
            block.name === "execute_command" &&
            typeof result.exit_code === "number" &&
            result.exit_code !== 0)
        )
          status = "interrupted";
      }
    } catch {
      // Plain-text results have no structured status.
    }
  }
  const summary: BrowserGatewayTranscriptBlockDetailSummary = {
    contentRevision: hashBlock(block),
    ...(status ? { status } : {}),
    ...(block.type === "tool_call" && block.resultImages?.length
      ? { imageCount: block.resultImages.length }
      : {}),
    ...(block.type === "tool_call" && block.resultDocuments?.length
      ? { documentCount: block.resultDocuments.length }
      : {}),
  };
  detailSummaries.set(block, { snapshot: { ...block }, summary });
  return summary;
}

type DisplayMedia = NonNullable<ChatMessage["displayMedia"]>;

const displayMediaRevisions = new WeakMap<DisplayMedia, number>();

/** Stable revision for a message's display media, cached per object identity. */
export function displayMediaContentRevision(
  displayMedia: DisplayMedia,
): number {
  const cached = displayMediaRevisions.get(displayMedia);
  if (cached !== undefined) return cached;
  const revision = hashString(
    JSON.stringify({
      images: displayMedia.images.map(({ name, mimeType, src }) => ({
        name,
        mimeType,
        src,
      })),
      documents: displayMedia.documents,
    }),
  );
  displayMediaRevisions.set(displayMedia, revision);
  return revision;
}

/** Encodes one message display image addressed by a `display-image` request. */
export function encodeDisplayImageDetail(
  request: TranscriptBlockDetailRequest,
  message: ChatMessage | undefined,
): Uint8Array {
  let response: TranscriptBlockDetailResponse;
  const displayMedia = message?.displayMedia;
  const image =
    request.resource?.kind === "display-image"
      ? displayMedia?.images[request.resource.index]
      : undefined;
  const parsed = image ? parseDataUrl(image.src) : undefined;
  if (!displayMedia || !image || !parsed) {
    response = { request, state: "not_found" };
  } else if (
    displayMediaContentRevision(displayMedia) !== request.contentRevision
  ) {
    response = { request, state: "stale_revision" };
  } else {
    response = {
      request,
      state: "media",
      data: parsed.data,
      mimeType: parsed.mimeType || image.mimeType,
      ...(image.name ? { name: image.name } : {}),
    };
  }
  return encodeDetailResponse(request, response);
}

function parseDataUrl(
  src: string,
): { mimeType: string; data: string } | undefined {
  const match = /^data:([^;,]*)(?:;[^,]*)?;base64,/i.exec(src);
  if (!match) return undefined;
  return { mimeType: match[1] ?? "", data: src.slice(match[0].length) };
}

function encodeDetailResponse(
  request: TranscriptBlockDetailRequest,
  response: TranscriptBlockDetailResponse,
): Uint8Array {
  const encoder = new TextEncoder();
  const content = encoder.encode(JSON.stringify(response));
  return content.byteLength <=
    BROWSER_GATEWAY_DATA_PLANE_LIMITS.authenticatedDetailResponseBytes
    ? content
    : encoder.encode(JSON.stringify({ request, state: "too_large" }));
}

export function encodeTranscriptBlockDetail(
  request: TranscriptBlockDetailRequest,
  block: TranscriptDisplayBlock | undefined,
): Uint8Array {
  let response: TranscriptBlockDetailResponse;
  if (!block) response = { request, state: "not_found" };
  else if (transcriptBlockContentRevision(block) !== request.contentRevision) {
    response = { request, state: "stale_revision" };
  } else if (request.resource) {
    const resource =
      block.type === "tool_call" && request.resource.kind !== "display-image"
        ? (request.resource.kind === "image"
            ? block.resultImages
            : block.resultDocuments)?.[request.resource.index]
        : undefined;
    response = resource
      ? {
          request,
          state: "media",
          data: resource.data,
          mimeType: resource.mimeType,
          ...("name" in resource && typeof resource.name === "string"
            ? { name: resource.name }
            : {}),
        }
      : { request, state: "not_found" };
  } else {
    const displayBlock: TranscriptDisplayBlock =
      block.type === "tool_call"
        ? {
            type: block.type,
            id: block.id,
            name: block.name,
            inputJson: block.inputJson,
            result: block.result,
            complete: block.complete,
            ...(block.durationMs !== undefined
              ? { durationMs: block.durationMs }
              : {}),
            ...(block.startedAt !== undefined
              ? { startedAt: block.startedAt }
              : {}),
            ...(block.composeTrace ? { composeTrace: block.composeTrace } : {}),
            ...(block.mcpApprovalPromotion
              ? { mcpApprovalPromotion: block.mcpApprovalPromotion }
              : {}),
          }
        : {
            type: block.type,
            id: block.id,
            inputJson: block.inputJson,
            result: block.result,
            complete: block.complete,
            ...(block.skillName !== undefined
              ? { skillName: block.skillName }
              : {}),
            ...(block.path !== undefined ? { path: block.path } : {}),
            ...(block.content !== undefined ? { content: block.content } : {}),
            ...(block.durationMs !== undefined
              ? { durationMs: block.durationMs }
              : {}),
          };
    response = {
      request,
      state: "ready",
      block: displayBlock,
      images:
        block.type === "tool_call"
          ? (block.resultImages ?? []).map(({ mimeType }) => ({ mimeType }))
          : [],
      documents:
        block.type === "tool_call"
          ? (block.resultDocuments ?? []).map(({ mimeType, name }) => ({
              mimeType,
              name,
            }))
          : [],
    };
  }
  return encodeDetailResponse(request, response);
}

export function parseTranscriptBlockDetailResponse(
  content: Uint8Array,
  request: TranscriptBlockDetailRequest,
): TranscriptBlockDetailResponse {
  const value: unknown = JSON.parse(new TextDecoder().decode(content));
  if (
    !isRecord(value) ||
    !isRecord(value.request) ||
    value.request.kind !== request.kind ||
    value.request.sessionId !== request.sessionId ||
    value.request.messageId !== request.messageId ||
    value.request.blockId !== request.blockId ||
    value.request.contentRevision !== request.contentRevision ||
    JSON.stringify(value.request.resource) !== JSON.stringify(request.resource)
  ) {
    throw new Error("relay_block_detail_identity_mismatch");
  }
  if (
    value.state === "not_found" ||
    value.state === "stale_revision" ||
    value.state === "too_large"
  ) {
    return { request, state: value.state };
  }
  if (
    value.state === "media" &&
    request.resource &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string" &&
    (value.name === undefined || typeof value.name === "string")
  ) {
    return {
      request,
      state: "media",
      data: value.data,
      mimeType: value.mimeType,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
    };
  }
  if (
    value.state !== "ready" ||
    request.resource ||
    !isDisplayBlock(value.block) ||
    value.block.id !== request.blockId ||
    !Array.isArray(value.images) ||
    !Array.isArray(value.documents) ||
    !value.images.every(isImageDescriptor) ||
    !value.documents.every(isDocumentDescriptor)
  ) {
    throw new Error("relay_block_detail_payload_invalid");
  }
  return {
    request,
    state: "ready",
    block: value.block,
    images: value.images,
    documents: value.documents,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isImageDescriptor(value: unknown): value is ResultImageDescriptor {
  return isRecord(value) && typeof value.mimeType === "string";
}
function isDocumentDescriptor(
  value: unknown,
): value is ResultDocumentDescriptor {
  return (
    isImageDescriptor(value) &&
    "name" in value &&
    typeof value.name === "string"
  );
}
function isDisplayBlock(value: unknown): value is TranscriptDisplayBlock {
  return (
    isRecord(value) &&
    (value.type === "tool_call" || value.type === "skill_load") &&
    typeof value.id === "string" &&
    typeof value.inputJson === "string" &&
    typeof value.result === "string" &&
    typeof value.complete === "boolean" &&
    (value.type !== "tool_call" || typeof value.name === "string") &&
    (value.durationMs === undefined || typeof value.durationMs === "number") &&
    (value.startedAt === undefined || typeof value.startedAt === "number") &&
    (value.path === undefined || typeof value.path === "string") &&
    (value.skillName === undefined || typeof value.skillName === "string") &&
    (value.content === undefined || typeof value.content === "string") &&
    (value.composeTrace === undefined ||
      (isRecord(value.composeTrace) &&
        Array.isArray(value.composeTrace.children))) &&
    (value.mcpApprovalPromotion === undefined ||
      (isRecord(value.mcpApprovalPromotion) &&
        Array.isArray(value.mcpApprovalPromotion.scopes)))
  );
}
