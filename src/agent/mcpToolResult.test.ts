import { describe, expect, it, vi } from "vitest";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { normalizeMcpToolResult } from "./mcpToolResult.js";

describe("normalizeMcpToolResult", () => {
  it("makes structured-only content canonical and model-visible", () => {
    const structuredContent = { count: 2, items: ["a", "b"] };

    expect(
      normalizeMcpToolResult({ content: [], structuredContent }),
    ).toMatchObject({
      data: structuredContent,
      content: [
        {
          type: "text",
          text: 'Structured content:\n{"count":2,"items":["a","b"]}',
        },
      ],
      mcpMeta: { content: [] },
    });
  });

  it("does not duplicate an identical canonical JSON text block", () => {
    const structuredContent = { ok: true };
    const serialized = JSON.stringify(structuredContent);

    const result = normalizeMcpToolResult({
      content: [{ type: "text", text: serialized }],
      structuredContent,
    });

    expect(result.content).toEqual([{ type: "text", text: serialized }]);
  });

  it("preserves server errors, annotations, metadata, and resource links", () => {
    const result = normalizeMcpToolResult({
      _meta: { requestId: "result-1" },
      isError: true,
      content: [
        {
          type: "text",
          text: "Invalid account",
          annotations: {
            audience: ["assistant"],
            priority: 0.8,
            lastModified: "2026-01-02T03:04:05Z",
          },
          _meta: { source: "validator" },
        },
        {
          type: "resource_link",
          uri: "https://example.com/account/1",
          name: "account-1",
          title: "Account 1",
          description: "The invalid account",
          mimeType: "application/json",
          size: 42,
          _meta: { relation: "invalid" },
        },
      ],
    });

    expect(result).toMatchObject({
      isError: true,
      error: { kind: "mcp_tool_error", message: "Invalid account" },
      mcpMeta: {
        resultMeta: { requestId: "result-1" },
        content: [
          {
            type: "text",
            annotations: {
              audience: ["assistant"],
              priority: 0.8,
              lastModified: "2026-01-02T03:04:05Z",
            },
            meta: { source: "validator" },
          },
          {
            type: "resource_link",
            meta: { relation: "invalid" },
            resourceLink: {
              uri: "https://example.com/account/1",
              name: "account-1",
              title: "Account 1",
              description: "The invalid account",
              mimeType: "application/json",
              size: 42,
            },
          },
        ],
      },
    });
    expect(result.content[1]).toEqual({
      type: "text",
      text: [
        "Resource link: Account 1",
        "URI: https://example.com/account/1",
        "Description: The invalid account",
        "MIME type: application/json",
        "Size: 42 bytes",
      ].join("\n"),
    });
  });

  it("retains embedded text and image resources and bounds unsupported media", () => {
    const result = normalizeMcpToolResult({
      content: [
        {
          type: "resource",
          resource: { uri: "file:///note.txt", text: "hello" },
        },
        {
          type: "resource",
          resource: {
            uri: "file:///image.png",
            blob: "image-data",
            mimeType: "image/png",
          },
        },
        {
          type: "resource",
          resource: {
            uri: "file:///archive.zip",
            blob: "binary-data",
            mimeType: "application/zip",
          },
        },
        { type: "audio", data: "audio-data", mimeType: "audio/wav" },
      ],
    });

    expect(result.content).toEqual([
      { type: "text", text: "hello" },
      { type: "image", data: "image-data", mimeType: "image/png" },
      {
        type: "text",
        text: "[Binary resource: file:///archive.zip; application/zip; 11 base64 characters]",
      },
      {
        type: "text",
        text: "[Audio: audio/wav; 10 base64 characters]",
      },
    ]);
  });

  it("keeps valid content when structured data cannot be serialized", () => {
    const warning = vi.fn();
    const structuredContent: Record<string, unknown> = {};
    structuredContent.self = structuredContent;

    const result = normalizeMcpToolResult(
      {
        content: [{ type: "text", text: "usable" }],
        structuredContent,
      } as CallToolResult,
      warning,
    );

    expect(result.content).toEqual([
      { type: "text", text: "usable" },
      { type: "text", text: "Structured content:\n[Unable to serialize]" },
    ]);
    expect(result.data).toBe(structuredContent);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Could not serialize MCP structured content"),
    );
  });
});
