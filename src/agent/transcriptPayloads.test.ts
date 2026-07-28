import { describe, expect, it } from "vitest";

import type { AgentMessage } from "./types.js";
import {
  TRANSCRIPT_PAYLOAD_EXTERNALIZE_MIN_CHARS,
  TRANSCRIPT_PAYLOAD_MARKER_PREFIX,
  buildTranscriptPayloadMarker,
  externalizeTranscriptPayloads,
  parseTranscriptPayloadMarker,
  rehydrateTranscriptPayloads,
} from "./transcriptPayloads.js";

const bigPayload = (fill: string): string =>
  fill.repeat(
    Math.ceil(TRANSCRIPT_PAYLOAD_EXTERNALIZE_MIN_CHARS / fill.length) + 1,
  );

describe("transcript payload markers", () => {
  it("round-trips through build and parse", () => {
    const hash = "a".repeat(64);
    const marker = buildTranscriptPayloadMarker(hash, 1234);
    expect(parseTranscriptPayloadMarker(marker)).toEqual({
      hash,
      length: 1234,
    });
  });

  it("rejects near-miss strings", () => {
    expect(parseTranscriptPayloadMarker("not a marker")).toBeNull();
    expect(
      parseTranscriptPayloadMarker(`${TRANSCRIPT_PAYLOAD_MARKER_PREFIX}zz:9`),
    ).toBeNull();
    expect(
      parseTranscriptPayloadMarker(
        `${TRANSCRIPT_PAYLOAD_MARKER_PREFIX}${"a".repeat(64)}:9 trailing`,
      ),
    ).toBeNull();
  });
});

describe("externalizeTranscriptPayloads", () => {
  it("replaces oversized strings anywhere in the structure and leaves the rest", () => {
    const image = bigPayload("iVBORw0K");
    const doc = bigPayload("JVBERi0x");
    const messages = [
      { role: "user", content: "hello" },
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: image },
          },
        ],
        media: {
          images: [],
          documents: [
            { name: "spec.pdf", mimeType: "application/pdf", base64: doc },
          ],
        },
      },
    ] as unknown as AgentMessage[];

    const result = externalizeTranscriptPayloads(messages);

    expect(result.payloads.size).toBe(2);
    const serialized = JSON.stringify(result.messages);
    expect(serialized).not.toContain(image);
    expect(serialized).not.toContain(doc);
    expect(serialized).toContain(TRANSCRIPT_PAYLOAD_MARKER_PREFIX);
    // Small strings and untouched messages pass through by reference.
    expect(result.messages[0]).toBe(messages[0]);
    // Originals are never mutated.
    const block = (
      messages[1] as { content: Array<{ source: { data: string } }> }
    ).content[0]!;
    expect(block.source.data).toBe(image);
  });

  it("produces stable markers and payload keys across repeated calls", () => {
    const image = bigPayload("QUJDRA==");
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: image },
          },
        ],
      },
    ] as unknown as AgentMessage[];

    const first = externalizeTranscriptPayloads(messages);
    const second = externalizeTranscriptPayloads(messages);

    expect(JSON.stringify(second.messages)).toBe(
      JSON.stringify(first.messages),
    );
    expect([...second.payloads.keys()]).toEqual([...first.payloads.keys()]);
  });

  it("passes existing markers through without re-externalizing", () => {
    const marker = buildTranscriptPayloadMarker("b".repeat(64), 42);
    const messages = [
      { role: "user", content: marker },
    ] as unknown as AgentMessage[];

    const result = externalizeTranscriptPayloads(messages);

    expect(result.payloads.size).toBe(0);
    expect(result.messages).toBe(messages);
  });
});

describe("rehydrateTranscriptPayloads", () => {
  it("restores the exact original structure", () => {
    const image = bigPayload("iVBORw0K");
    const messages = [
      { role: "user", content: "hello", meta: { count: 3, flag: true } },
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: image },
          },
        ],
      },
    ] as unknown as AgentMessage[];

    const externalized = externalizeTranscriptPayloads(messages);
    const rehydrated = rehydrateTranscriptPayloads(
      externalized.messages,
      (hash) => externalized.payloads.get(hash) ?? null,
    );

    expect(rehydrated).toEqual(messages);
  });

  it("keeps the marker when the payload is missing or the length disagrees", () => {
    const image = bigPayload("iVBORw0K");
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: image },
          },
        ],
      },
    ] as unknown as AgentMessage[];
    const externalized = externalizeTranscriptPayloads(messages);
    const [hash] = [...externalized.payloads.keys()];

    const missing = rehydrateTranscriptPayloads(
      externalized.messages,
      () => null,
    );
    expect(JSON.stringify(missing)).toContain(hash);

    const truncated = rehydrateTranscriptPayloads(
      externalized.messages,
      () => "short",
    );
    expect(JSON.stringify(truncated)).toContain(hash);

    // A marker that survived a miss still round-trips through externalize.
    const reExternalized = externalizeTranscriptPayloads(missing);
    expect(JSON.stringify(reExternalized.messages)).toBe(
      JSON.stringify(externalized.messages),
    );
  });
});
