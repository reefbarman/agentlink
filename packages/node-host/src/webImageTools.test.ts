import { describe, expect, it, vi } from "vitest";

import type { HostTool } from "@agentlink/core";

import {
  createNodeHostWebImageTools,
  type CreateNodeHostWebImageToolsOptions,
} from "./webImageTools.js";
import type { PublicWebFetcher } from "./webImageTransport.js";

const principal = { tenantId: "tenant-a", subjectId: "subject-a" };
const context = {
  principal,
  sessionId: "session-a",
  turnId: "turn-a",
  model: {
    model: { providerId: "fixture", modelId: "fixture-model" },
    source: "runtime" as const,
  },
  signal: undefined,
};

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([
      length,
      Buffer.from(type, "latin1"),
      data,
      Buffer.alloc(4),
    ]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", Buffer.alloc(4)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PAGE = `<html><head><title>OK Computer</title>
<meta property="og:image" content="https://cdn.example.com/ok-computer.png">
<meta property="og:title" content="OK Computer cover">
</head><body></body></html>`;

function fakeFetcher(): PublicWebFetcher & { urls: string[] } {
  const urls: string[] = [];
  const fetcher = async (
    request: Parameters<PublicWebFetcher>[0],
  ): ReturnType<PublicWebFetcher> => {
    await request.authorize(request.url, 0);
    urls.push(request.url.href);
    const isImage = request.url.pathname.endsWith(".png");
    return {
      requestedUrl: request.url,
      finalUrl: request.url,
      status: 200,
      contentType: isImage ? "image/png" : "text/html; charset=utf-8",
      body: isImage ? png(600, 600) : Buffer.from(PAGE),
    };
  };
  return Object.assign(fetcher, { urls });
}

async function resolve(
  options: CreateNodeHostWebImageToolsOptions = {},
): Promise<{
  tools: Map<string, HostTool>;
  toolkit: ReturnType<typeof createNodeHostWebImageTools>;
}> {
  const toolkit = createNodeHostWebImageTools({
    fetcher: fakeFetcher(),
    ...options,
  });
  const tools = await toolkit.resolveTools({
    principal,
    sessionId: context.sessionId,
    turnId: context.turnId,
    input: { text: "show me the OK Computer cover", attachments: undefined },
  });
  return {
    tools: new Map(tools.map((tool) => [tool.definition.name, tool])),
    toolkit,
  };
}

function text(result: { modelContent: unknown }): Record<string, unknown> {
  const content = result.modelContent;
  const raw =
    typeof content === "string"
      ? content
      : (content as Array<{ type: string; text?: string }>).find(
          (block) => block.type === "text",
        )?.text;
  return JSON.parse(raw ?? "{}") as Record<string, unknown>;
}

describe("createNodeHostWebImageTools", () => {
  it("finds, retrieves and presents a web image with its source", async () => {
    const { tools, toolkit } = await resolve();
    expect([...tools.keys()]).toEqual([
      "inspect_page_images",
      "present_images",
    ]);

    const inspected = await tools
      .get("inspect_page_images")!
      .execute({ url: "https://music.example.com/ok-computer" }, context);
    const candidates = text(inspected).candidates as Array<{
      candidate_id: string;
      image_url: string;
    }>;
    expect(candidates[0]?.candidate_id).toMatch(/^img_/);
    expect(String(text(inspected).next_step)).toContain("Markdown");

    const presented = await tools
      .get("present_images")!
      .execute({ candidate_ids: [candidates[0]!.candidate_id] }, context);
    expect(presented.isError).toBeUndefined();
    const blocks = presented.modelContent as unknown as Array<
      Record<string, unknown>
    >;
    expect(blocks[1]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png" },
      attribution: {
        origin: "web_page",
        sourceUrl: "https://music.example.com/ok-computer",
      },
    });
    expect(JSON.stringify(presented.displayContent)).not.toContain(
      png(600, 600).toString("base64"),
    );
    expect(presented.displayContent).toMatchObject({
      kind: "agentlink.presented_images",
      images: [
        {
          imageId: "web_image_1",
          mimeType: "image/png",
          attribution: { sourceUrl: "https://music.example.com/ok-computer" },
        },
      ],
    });
    expect(text(presented).images).toEqual([
      {
        image_id: "web_image_1",
        source: "https://music.example.com/ok-computer",
      },
    ]);
    expect(toolkit.getImage("session-a", "web_image_1")?.data).toBe(
      png(600, 600).toString("base64"),
    );
    expect(toolkit.getImage("session-b", "web_image_1")).toBeUndefined();

    const again = await tools
      .get("present_images")!
      .execute({ image_ids: ["web_image_1"] }, context);
    expect(text(again).count).toBe(1);

    toolkit.clearSession("session-a");
    expect(toolkit.getImage("session-a", "web_image_1")).toBeUndefined();
    await toolkit.dispose();
  });

  it("resolves Markdown image sources seen in the session and asks for others", async () => {
    const { tools, toolkit } = await resolve();
    await tools
      .get("inspect_page_images")!
      .execute({ url: "https://music.example.com/ok-computer" }, context);
    const seen = await toolkit.resolveImageSource(
      "session-a",
      "https://cdn.example.com/ok-computer.png",
    );
    expect(seen).toMatchObject({
      status: "ready",
      mimeType: "image/png",
      data: png(600, 600).toString("base64"),
      attribution: { sourceUrl: "https://music.example.com/ok-computer" },
    });
    expect(
      await toolkit.resolveImageSource(
        "session-a",
        "https://other.example.org/x.png",
      ),
    ).toEqual({ status: "needs_confirmation", host: "other.example.org" });
    expect(
      (
        await toolkit.resolveImageSource(
          "session-a",
          "https://other.example.org/x.png",
          { userConfirmed: true },
        )
      ).status,
    ).toBe("ready");
    expect(
      (await toolkit.resolveImageSource("session-a", "javascript:alert(1)"))
        .status,
    ).toBe("unavailable");
  });

  it("inlines presented image bytes only when asked", async () => {
    const { tools } = await resolve({ inlineDisplayImages: true });
    const presented = await tools
      .get("present_images")!
      .execute({ urls: ["https://cdn.example.com/a.png"] }, context);
    expect(
      (presented.displayContent as { images: Array<{ data?: string }> })
        .images[0]?.data,
    ).toBe(png(600, 600).toString("base64"));
  });

  it("rejects unknown image IDs and empty sessions", async () => {
    const { tools } = await resolve();
    const empty = await tools.get("present_images")!.execute({}, context);
    expect(empty.isError).toBe(true);
    const missing = await tools
      .get("present_images")!
      .execute({ image_ids: ["web_image_9"] }, context);
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.modelContent)).toContain("web_image_9");
  });

  it("omits the tools when the turn policy disables retrieval", async () => {
    const { tools } = await resolve({
      resolvePolicy: () => ({ mode: "disabled" }),
    });
    expect(tools.size).toBe(0);
  });

  it("asks the host for consent in prompt mode and honours denial", async () => {
    const requestApproval = vi.fn(async () => ({ decision: "reject" }));
    const { tools } = await resolve({
      resolvePolicy: () => ({ mode: "prompt" }),
      requestApproval,
    });
    const result = await tools
      .get("present_images")!
      .execute({ urls: ["https://cdn.example.com/a.png"] }, context);
    expect(result.isError).toBe(true);
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "https://cdn.example.com" }),
      { principal, sessionId: "session-a", turnId: "turn-a" },
      undefined,
    );
  });

  it("applies host domain lists", async () => {
    const { tools } = await resolve({
      resolvePolicy: () => ({ blockedDomains: ["example.com"] }),
    });
    const result = await tools
      .get("present_images")!
      .execute({ urls: ["https://cdn.example.com/a.png"] }, context);
    expect(result.isError).toBe(true);
    expect(String(text(result).error)).toContain("blocked");
  });
});
