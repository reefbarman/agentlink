import type { SessionImageReference } from "../core/tools/types.js";
import type { CoreModelContentBlock } from "../core/modelRuntime.js";
import type { AgentMessage } from "./types.js";

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

/**
 * Collect images available in a session in transcript order. This includes
 * user-attached media and image blocks returned by tools such as screenshots.
 */
export function collectSessionImages(
  messages: readonly AgentMessage[],
): SessionImageReference[] {
  const images: SessionImageReference[] = [];

  const appendImage = (params: {
    messageIndex: number;
    imageIndex: number;
    name?: string;
    mimeType: string;
    base64: string;
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
    });
  };

  const visitBlocks = (
    blocks: readonly CoreModelContentBlock[],
    messageIndex: number,
    nextImageIndex: { value: number },
  ) => {
    for (const block of blocks) {
      if (block.type === "image" && block.source.type === "base64") {
        appendImage({
          messageIndex,
          imageIndex: nextImageIndex.value++,
          mimeType: block.source.media_type,
          base64: block.source.data,
        });
        continue;
      }
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        visitBlocks(block.content, messageIndex, nextImageIndex);
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
      });
    }
    if (Array.isArray(message.content)) {
      visitBlocks(message.content, messageIndex, { value: imageIndex });
    }
  });

  return images;
}
