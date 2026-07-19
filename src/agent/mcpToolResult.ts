import type {
  McpContentAnnotations,
  McpResultContentMeta,
  ToolResult,
} from "../shared/types.js";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const STRUCTURED_CONTENT_LABEL = "Structured content:";

function normalizeAnnotations(
  annotations: CallToolResult["content"][number]["annotations"],
): McpContentAnnotations | undefined {
  if (!annotations) return undefined;
  return {
    ...(annotations.audience ? { audience: [...annotations.audience] } : {}),
    ...(annotations.priority !== undefined
      ? { priority: annotations.priority }
      : {}),
    ...(annotations.lastModified
      ? { lastModified: annotations.lastModified }
      : {}),
  };
}

function normalizeContentMeta(
  item: CallToolResult["content"][number],
): McpResultContentMeta {
  const common = {
    type: item.type,
    ...(item.annotations
      ? { annotations: normalizeAnnotations(item.annotations) }
      : {}),
    ...(item._meta ? { meta: { ...item._meta } } : {}),
  };
  if (item.type === "resource_link") {
    return {
      ...common,
      resourceLink: {
        uri: item.uri,
        name: item.name,
        ...(item.title ? { title: item.title } : {}),
        ...(item.description ? { description: item.description } : {}),
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
        ...(item.size !== undefined ? { size: item.size } : {}),
        ...(item.icons
          ? {
              icons: item.icons.map((icon) => ({
                src: icon.src,
                ...(icon.mimeType ? { mimeType: icon.mimeType } : {}),
                ...(icon.sizes ? { sizes: [...icon.sizes] } : {}),
                ...(icon.theme ? { theme: icon.theme } : {}),
              })),
            }
          : {}),
      },
    };
  }
  if (item.type === "resource") {
    return {
      ...common,
      resource: {
        uri: item.resource.uri,
        ...(item.resource.mimeType ? { mimeType: item.resource.mimeType } : {}),
        ...(item.resource._meta ? { meta: { ...item.resource._meta } } : {}),
      },
    };
  }
  return common;
}

function formatResourceLink(
  item: Extract<CallToolResult["content"][number], { type: "resource_link" }>,
): string {
  const lines = [
    `Resource link: ${item.title ?? item.name}`,
    `URI: ${item.uri}`,
  ];
  if (item.description) lines.push(`Description: ${item.description}`);
  if (item.mimeType) lines.push(`MIME type: ${item.mimeType}`);
  if (item.size !== undefined) lines.push(`Size: ${item.size} bytes`);
  return lines.join("\n");
}

function serializeStructuredContent(
  structuredContent: Record<string, unknown>,
  onWarning?: (message: string) => void,
): string | null {
  try {
    return JSON.stringify(structuredContent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onWarning?.(
      `Could not serialize MCP structured content: ${message.slice(0, 300)}`,
    );
    return null;
  }
}

export function normalizeMcpToolResult(
  result: CallToolResult,
  onWarning?: (message: string) => void,
): ToolResult {
  const content: ToolResult["content"] = [];

  for (const item of result.content) {
    switch (item.type) {
      case "text":
        content.push({ type: "text", text: item.text });
        break;
      case "image":
        content.push({
          type: "image",
          data: item.data,
          mimeType: item.mimeType,
        });
        break;
      case "audio":
        content.push({
          type: "text",
          text: `[Audio: ${item.mimeType}; ${item.data.length} base64 characters]`,
        });
        break;
      case "resource_link":
        content.push({ type: "text", text: formatResourceLink(item) });
        break;
      case "resource":
        if ("text" in item.resource) {
          content.push({ type: "text", text: item.resource.text });
        } else if (item.resource.mimeType?.startsWith("image/")) {
          content.push({
            type: "image",
            data: item.resource.blob,
            mimeType: item.resource.mimeType,
          });
        } else {
          content.push({
            type: "text",
            text: `[Binary resource: ${item.resource.uri}; ${item.resource.mimeType ?? "unknown MIME type"}; ${item.resource.blob.length} base64 characters]`,
          });
        }
        break;
    }
  }

  if (result.structuredContent) {
    const serialized = serializeStructuredContent(
      result.structuredContent,
      onWarning,
    );
    if (serialized) {
      const duplicate = content.some(
        (item) => item.type === "text" && item.text === serialized,
      );
      if (!duplicate) {
        content.push({
          type: "text",
          text: `${STRUCTURED_CONTENT_LABEL}\n${serialized}`,
        });
      }
    } else {
      content.push({
        type: "text",
        text: `${STRUCTURED_CONTENT_LABEL}\n[Unable to serialize]`,
      });
    }
  }

  if (content.length === 0) content.push({ type: "text", text: "" });
  const firstText = content.find(
    (item): item is Extract<ToolResult["content"][number], { type: "text" }> =>
      item.type === "text" && item.text.length > 0,
  );

  return {
    ...(result.structuredContent ? { data: result.structuredContent } : {}),
    content,
    ...(result.isError
      ? {
          isError: true,
          error: {
            kind: "mcp_tool_error",
            message:
              firstText?.text ?? "MCP server reported a tool execution error.",
          },
        }
      : {}),
    mcpMeta: {
      ...(result._meta ? { resultMeta: { ...result._meta } } : {}),
      content: result.content.map(normalizeContentMeta),
    },
  };
}
