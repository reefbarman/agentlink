import type { ChatMessage } from "@agentlink/protocol/chat-transcript";
import { describe, expect, it } from "vitest";

import {
  displayMediaContentRevision,
  encodeTranscriptMessageDetail,
} from "./dataPlane/transcriptBlockDetail.js";
import {
  boundTranscriptMediaForWire,
  stringContentExceeds,
} from "./wireTranscriptMedia.js";

const LARGE = "A".repeat(200_000);

function imageMessage(data: string, id = "t1"): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "",
    timestamp: 0,
    blocks: [
      {
        type: "tool_call",
        id: "tool-1",
        name: "generate_image",
        inputJson: "{}",
        result: "done",
        resultImages: [{ mimeType: "image/png", data }],
        resultDocuments: [
          { name: "a.pdf", mimeType: "application/pdf", data: "BBBB" },
        ],
        complete: true,
      },
    ],
    displayMedia: {
      images: [
        {
          name: "generated-image-1.png",
          mimeType: "image/png",
          src: `data:image/png;base64,${data}`,
        },
      ],
      documents: [],
    },
  } as ChatMessage;
}

function decode(content: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(content));
}

describe("boundTranscriptMediaForWire", () => {
  it("leaves small media and the original objects alone", () => {
    const message = imageMessage("AAAA");
    expect(boundTranscriptMediaForWire([message])[0]).toBe(message);
  });

  it("replaces large media with references that resolve to the original", () => {
    const message = imageMessage(LARGE);
    const [bounded] = boundTranscriptMediaForWire([message]);
    expect(JSON.stringify(bounded).length).toBeLessThan(2_000);
    expect(message.displayMedia?.images[0]?.src).toContain(LARGE);

    const image = bounded!.displayMedia!.images[0]!;
    expect(image.src).toBe("");
    const displayRequest = {
      kind: "transcript.block-detail" as const,
      sessionId: "s",
      messageId: "t1",
      blockId: "display-media",
      contentRevision: image.remoteDetail!.contentRevision,
      resource: { kind: "display-image" as const, index: 0 },
    };
    expect(
      decode(encodeTranscriptMessageDetail(displayRequest, message)),
    ).toMatchObject({ state: "media", mimeType: "image/png", data: LARGE });

    const block = bounded!.blocks[0]!;
    if (block.type !== "tool_call") throw new Error("expected tool call");
    expect(block.resultImages).toBeUndefined();
    expect(block.resultDocuments).toBeUndefined();
    expect(block.remoteDetail).toMatchObject({
      available: true,
      imageCount: 1,
      documentCount: 1,
    });
    const blockRequest = {
      ...displayRequest,
      blockId: "tool-1",
      contentRevision: block.remoteDetail!.contentRevision,
      resource: { kind: "image" as const, index: 0 },
    };
    expect(
      decode(encodeTranscriptMessageDetail(blockRequest, message)),
    ).toMatchObject({ state: "media", data: LARGE });

    // A re-projected transcript has new objects but the same revisions.
    expect(
      decode(encodeTranscriptMessageDetail(blockRequest, imageMessage(LARGE))),
    ).toMatchObject({ state: "media" });
    // Same length, different image.
    expect(
      decode(
        encodeTranscriptMessageDetail(
          blockRequest,
          imageMessage("B".repeat(LARGE.length)),
        ),
      ),
    ).toMatchObject({ state: "stale_revision" });
  });

  it("caps the total size of many small images", () => {
    const messages = Array.from({ length: 200 }, (_, index) =>
      imageMessage("A".repeat(50_000), `t${index}`),
    );
    expect(
      JSON.stringify(boundTranscriptMediaForWire(messages)).length,
    ).toBeLessThan(1_300_000);
  });

  it("gives large display media a stable revision per projection", () => {
    expect(displayMediaContentRevision(imageMessage(LARGE).displayMedia!)).toBe(
      displayMediaContentRevision(imageMessage(LARGE).displayMedia!),
    );
  });
});

describe("stringContentExceeds", () => {
  it("finds nested oversized content", () => {
    expect(stringContentExceeds({ a: ["xx", { b: "yyy" }] }, 4)).toBe(true);
    expect(stringContentExceeds({ a: ["xx", { b: "yyy" }], c: 1 }, 5)).toBe(
      false,
    );
  });
});
