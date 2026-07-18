import type { ContentBlock as AcpContentBlock } from "@agentclientprotocol/sdk" with {
  "resolution-mode": "import",
};

import {
  toSupportedImageMediaType,
  type ContentBlock,
} from "./providers/types.js";

export const MAX_ACP_OUTPUT_IMAGE_BYTES = 10 * 1024 * 1024;

export interface AcpContentConversion {
  content?: ContentBlock;
  warning?: string;
}

/** Convert protocol content into the surface-neutral model content AgentLink persists. */
export function convertAcpContentBlock(
  block: AcpContentBlock,
): AcpContentConversion {
  if (block.type === "text") {
    return { content: { type: "text", text: block.text } };
  }
  if (block.type === "resource_link") {
    return { content: { type: "text", text: block.uri } };
  }
  if (block.type === "resource") {
    const resource = block.resource;
    if ("text" in resource && typeof resource.text === "string") {
      return { content: { type: "text", text: resource.text } };
    }
    return {};
  }
  if (block.type !== "image") return {};

  const mimeType = toSupportedImageMediaType(block.mimeType);
  if (!mimeType) {
    return {
      warning: `[ACP image omitted: unsupported MIME type ${block.mimeType}]`,
    };
  }

  const data = block.data.replace(/\s/g, "");
  const remainder = data.length % 4;
  const validBase64 =
    data.length > 0 && remainder !== 1 && /^[A-Za-z0-9+/]*={0,2}$/.test(data);
  if (!validBase64) {
    return { warning: "[ACP image omitted: invalid base64 data]" };
  }

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const byteLength = Math.floor((data.length * 3) / 4) - padding;
  if (byteLength > MAX_ACP_OUTPUT_IMAGE_BYTES) {
    return {
      warning: `[ACP image omitted: ${(byteLength / 1024 / 1024).toFixed(1)} MB exceeds the 10 MB limit]`,
    };
  }

  return {
    content: {
      type: "image",
      source: { type: "base64", media_type: mimeType, data },
    },
  };
}
