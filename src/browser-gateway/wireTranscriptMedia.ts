import type {
  ChatMessage,
  ContentBlock,
} from "@agentlink/protocol/chat-transcript";

import {
  displayMediaContentRevision,
  transcriptBlockDetailSummary,
} from "./dataPlane/transcriptBlockDetail.js";

/**
 * Inline media allowed in one HTTP/SSE transcript payload. Small previews stay
 * inline; an image-heavy chat would otherwise serialize to hundreds of
 * megabytes per snapshot and exhaust the extension host heap.
 */
const MAX_INLINE_MEDIA_ITEM_CHARS = 64 * 1024;
const MAX_INLINE_MEDIA_TOTAL_CHARS = 1024 * 1024;

/**
 * Replace large base64 media with lazy references that the transcript resolves
 * through the block-detail route. Never mutates the input. Message and block
 * objects without large media are returned unchanged.
 */
export function boundTranscriptMediaForWire(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  let remaining = MAX_INLINE_MEDIA_TOTAL_CHARS;
  const keepInline = (sizes: number[]): boolean => {
    const total = sizes.reduce((sum, size) => sum + size, 0);
    if (
      sizes.some((size) => size > MAX_INLINE_MEDIA_ITEM_CHARS) ||
      total > remaining
    ) {
      return false;
    }
    remaining -= total;
    return true;
  };

  return messages.map((message) => {
    // Raw media only exists for model input; displayMedia carries previews.
    const { media, ...withoutRawMedia } = message;
    let bounded: ChatMessage = media ? withoutRawMedia : message;

    const blocks = boundBlocks(message, keepInline);
    if (blocks !== message.blocks) bounded = { ...bounded, blocks };

    const displayMedia = message.displayMedia;
    if (
      displayMedia?.images.length &&
      !keepInline(displayMedia.images.map(({ src }) => src.length))
    ) {
      const contentRevision = displayMediaContentRevision(displayMedia);
      bounded = {
        ...bounded,
        displayMedia: {
          ...displayMedia,
          images: displayMedia.images.map((image, index) => ({
            ...image,
            src: "",
            remoteDetail: image.remoteDetail ?? {
              messageId: message.id,
              contentRevision,
              index,
            },
          })),
        },
      };
    }
    return bounded;
  });
}

function boundBlocks(
  message: ChatMessage,
  keepInline: (sizes: number[]) => boolean,
): ContentBlock[] {
  let changed = false;
  const blocks = message.blocks?.map((block) => {
    if (block.type !== "tool_call") return block;
    const sizes = [
      ...(block.resultImages ?? []),
      ...(block.resultDocuments ?? []),
    ].map(({ data }) => data.length);
    if (sizes.length === 0 || keepInline(sizes)) return block;
    changed = true;
    const {
      resultImages: _resultImages,
      resultDocuments: _resultDocuments,
      ...rest
    } = block;
    return {
      ...rest,
      remoteDetail: {
        messageId: message.id,
        available: true,
        ...transcriptBlockDetailSummary(block),
      },
    };
  });
  return changed && blocks ? blocks : message.blocks;
}

/**
 * Whether the strings in a JSON-like value already exceed `limit` characters.
 * Their UTF-8 JSON is at least that large, so an oversized payload can be
 * rejected without building it.
 */
export function stringContentExceeds(value: unknown, limit: number): boolean {
  let remaining = limit;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      remaining -= current.length;
      if (remaining < 0) return true;
    } else if (current && typeof current === "object") {
      for (const child of Object.values(current)) pending.push(child);
    }
  }
  return false;
}
