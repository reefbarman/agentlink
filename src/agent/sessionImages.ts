import type { AgentMessage } from "./types.js";
import type { CoreModelContentBlock } from "@agentlink/core/model-runtime";
import type { SessionImageReference } from "../core/tools/types.js";

const MAX_LISTED_SESSION_IMAGES = 20;

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

export interface DescribedSessionImage extends SessionImageReference {
  /** Short provenance label, e.g. "attached by the user" or "returned by read_file". */
  source: string;
}

function describeSessionImages(
  messages: readonly AgentMessage[],
): DescribedSessionImage[] {
  const images: DescribedSessionImage[] = [];
  const toolNamesById = new Map<string, string>();

  const appendImage = (params: {
    messageIndex: number;
    imageIndex: number;
    name?: string;
    mimeType: string;
    base64: string;
    source: string;
  }) => {
    const id = `image_${images.length + 1}`;
    images.push({
      id,
      name:
        params.name ||
        `${id}.${extensionForMimeType(params.mimeType.toLowerCase())}`,
      mimeType: params.mimeType,
      base64: params.base64,
      messageIndex: params.messageIndex,
      imageIndex: params.imageIndex,
      source: params.source,
    });
  };

  const visitBlocks = (
    blocks: readonly CoreModelContentBlock[],
    messageIndex: number,
    nextImageIndex: { value: number },
    source: string,
  ) => {
    for (const block of blocks) {
      if (block.type === "tool_use") {
        toolNamesById.set(block.id, block.name);
        continue;
      }
      if (block.type === "image" && block.source.type === "base64") {
        appendImage({
          messageIndex,
          imageIndex: nextImageIndex.value++,
          mimeType: block.source.media_type,
          base64: block.source.data,
          source,
        });
        continue;
      }
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        const toolName = toolNamesById.get(block.tool_use_id);
        visitBlocks(
          block.content,
          messageIndex,
          nextImageIndex,
          toolName ? `returned by ${toolName}` : "returned by a tool",
        );
      }
    }
  };

  messages.forEach((message, messageIndex) => {
    let imageIndex = 0;
    for (const image of message.media?.images ?? []) {
      appendImage({
        messageIndex,
        imageIndex: imageIndex++,
        name: image.name,
        mimeType: image.mimeType,
        base64: image.base64,
        source: "attached by the user",
      });
    }
    if (Array.isArray(message.content)) {
      visitBlocks(
        message.content,
        messageIndex,
        { value: imageIndex },
        message.role === "assistant"
          ? "from an assistant message"
          : "in a user message",
      );
    }
  });

  return images;
}

/**
 * Collect images in transcript order. This includes user-attached media and
 * image blocks returned by tools such as screenshots.
 */
export function collectSessionImages(
  messages: readonly AgentMessage[],
): SessionImageReference[] {
  return describeSessionImages(messages).map(
    ({ source: _source, ...image }) => image,
  );
}

function storedImageHistory(
  allMessages: readonly AgentMessage[],
): AgentMessage[] {
  return allMessages.filter(
    (message) => !message.diagnosticOnly && !message.runtimeError,
  );
}

/**
 * Collect images over the full stored history, so image_N IDs stay fixed when
 * condensing hides older messages from the model. Rewinding truncates the
 * stored history, which drops images from discarded turns.
 */
export function collectStoredSessionImages(
  allMessages: readonly AgentMessage[],
): SessionImageReference[] {
  return collectSessionImages(storedImageHistory(allMessages));
}

/**
 * Text block for a condense summary listing images that condensing hides
 * from the model, so it can keep referring to them by stable ID.
 */
export function buildCondensedSessionImageIndex(
  allMessages: readonly AgentMessage[],
): string | undefined {
  const images = describeSessionImages(storedImageHistory(allMessages));
  // The first message stays visible after condensing; its images need no entry.
  const hidden = images.filter((image) => image.messageIndex > 0);
  if (hidden.length === 0) return undefined;

  const listed = hidden.slice(-MAX_LISTED_SESSION_IMAGES);
  const omitted = hidden.length - listed.length;
  const lines = [
    "## Session images",
    "",
    "Images from earlier in this conversation are not shown here but remain available by ID to present_images, save_session_image, generate_image references, and background-agent image handoff.",
    "",
    ...(omitted > 0
      ? [
          `- ${omitted} older image${omitted === 1 ? "" : "s"} before ${listed[0]!.id} ${omitted === 1 ? "is" : "are"} also available.`,
        ]
      : []),
    ...listed.map(
      (image) =>
        `- ${image.id}: ${image.name} (${image.mimeType}), ${image.source}`,
    ),
    "",
    `The next new image in this conversation will be image_${images.length + 1}.`,
  ];
  return lines.join("\n");
}
