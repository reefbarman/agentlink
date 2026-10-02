import { describe, expect, it } from "vitest";
import {
  encodeTranscriptBlockDetail,
  parseTranscriptBlockDetailResponse,
  transcriptBlockContentRevision,
  transcriptBlockDetailSummary,
  type TranscriptDisplayBlock,
  type TranscriptBlockDetailRequest,
} from "./transcriptBlockDetail.js";
import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "@agentlink/protocol/browser-gateway-data-plane-limits";

const block: TranscriptDisplayBlock = {
  type: "tool_call",
  id: "tool-1",
  name: "read_file",
  inputJson: '{"path":"README.md"}',
  result: '{"content":"distinctive result"}',
  complete: true,
  durationMs: 17,
  resultImages: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
  resultDocuments: [
    { name: "result.pdf", mimeType: "application/pdf", data: "cGRm" },
  ],
};
const request: TranscriptBlockDetailRequest = {
  kind: "transcript.block-detail",
  sessionId: "session-1",
  messageId: "message-1",
  blockId: block.id,
  contentRevision: transcriptBlockContentRevision(block),
};

function response(
  source: TranscriptDisplayBlock | undefined = block,
  selection = request,
) {
  return parseTranscriptBlockDetailResponse(
    encodeTranscriptBlockDetail(selection, source),
    selection,
  );
}

describe("transcript block detail", () => {
  it("reuses summaries while detecting in-place streamed field updates", () => {
    const source = { ...block };
    const summary = transcriptBlockDetailSummary(source);
    expect(transcriptBlockDetailSummary(source)).toBe(summary);
    source.inputJson += " ";
    const updated = transcriptBlockDetailSummary(source);
    expect(updated).not.toBe(summary);
    expect(updated.contentRevision).not.toBe(summary.contentRevision);
    expect(transcriptBlockContentRevision(source)).toBe(
      updated.contentRevision,
    );
    expect(transcriptBlockDetailSummary(source)).toBe(updated);
  });

  it("returns display fields without embedding result media", () => {
    const detail = response();
    expect(detail).toMatchObject({
      state: "ready",
      block: {
        inputJson: block.inputJson,
        result: block.result,
        durationMs: 17,
      },
      images: [{ mimeType: "image/png" }],
      documents: [{ name: "result.pdf", mimeType: "application/pdf" }],
    });
    if (detail.state !== "ready") throw new Error("expected ready detail");
    expect(detail.block).not.toHaveProperty("resultImages");
    expect(detail.block).not.toHaveProperty("resultDocuments");
  });

  it("retrieves individual images/documents with the same identity and revision", () => {
    expect(
      response(block, { ...request, resource: { kind: "image", index: 0 } }),
    ).toMatchObject({
      state: "media",
      data: "aW1hZ2U=",
      mimeType: "image/png",
    });
    expect(
      response(block, { ...request, resource: { kind: "document", index: 0 } }),
    ).toMatchObject({ state: "media", data: "cGRm", name: "result.pdf" });
    expect(
      response(block, { ...request, resource: { kind: "image", index: 1 } }),
    ).toMatchObject({ state: "not_found" });
  });

  it("preserves skill content and changes revision when only the result changes", () => {
    const skill: TranscriptDisplayBlock = {
      type: "skill_load",
      id: "skill-1",
      inputJson: '{"path":"SKILL.md"}',
      result: "loaded",
      content: "skill contents",
      path: "SKILL.md",
      skillName: "example",
      complete: true,
    };
    expect(
      response(skill, {
        ...request,
        blockId: skill.id,
        contentRevision: transcriptBlockContentRevision(skill),
      }),
    ).toMatchObject({ state: "ready", block: skill });
    expect(
      transcriptBlockContentRevision({ ...block, result: "new result" }),
    ).not.toBe(request.contentRevision);
    expect(response({ ...block, result: "new result" })).toMatchObject({
      state: "stale_revision",
    });
  });

  it("returns per-item size and missing states without throwing", () => {
    expect(response(undefined)).toMatchObject({ state: "ready" });
    expect(
      parseTranscriptBlockDetailResponse(
        encodeTranscriptBlockDetail(request, undefined),
        request,
      ),
    ).toMatchObject({ state: "not_found" });
    const large = {
      ...block,
      result: "x".repeat(
        BROWSER_GATEWAY_DATA_PLANE_LIMITS.authenticatedDetailResponseBytes,
      ),
    };
    expect(
      response(large, {
        ...request,
        contentRevision: transcriptBlockContentRevision(large),
      }),
    ).toMatchObject({ state: "too_large" });
  });

  it("rejects mismatched identity and malformed display data", () => {
    const content = encodeTranscriptBlockDetail(request, block);
    expect(() =>
      parseTranscriptBlockDetailResponse(content, {
        ...request,
        sessionId: "another-session",
      }),
    ).toThrow("identity_mismatch");
    expect(() =>
      parseTranscriptBlockDetailResponse(
        new TextEncoder().encode(
          JSON.stringify({
            request,
            state: "ready",
            block: { ...block, inputJson: 123 },
            images: [],
            documents: [],
          }),
        ),
        request,
      ),
    ).toThrow("payload_invalid");
  });

  it("projects payload-free error and media indicators", () => {
    expect(
      transcriptBlockDetailSummary({
        ...block,
        result: '{"error":"private failure"}',
      }),
    ).toMatchObject({ status: "error", imageCount: 1, documentCount: 1 });
    expect(
      transcriptBlockDetailSummary({
        ...block,
        result: '{"status":"cancelled"}',
      }),
    ).toMatchObject({ status: "interrupted" });
    expect(JSON.stringify(transcriptBlockDetailSummary(block))).not.toContain(
      "README.md",
    );
  });
});
