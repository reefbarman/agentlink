import { describe, expect, it, vi } from "vitest";
import { loadRemoteTranscriptBlockDetail } from "./toolDetailTransport";
import {
  encodeTranscriptBlockDetail,
  parseTranscriptBlockDetailResponse,
  transcriptBlockContentRevision,
  type TranscriptDisplayBlock,
  type TranscriptBlockDetailRequest,
} from "../dataPlane/transcriptBlockDetail";

const source: TranscriptDisplayBlock = {
  type: "tool_call",
  id: "media-tool",
  name: "mcp_screenshot",
  inputJson: '{"target":"example"}',
  result: "captured",
  complete: true,
  resultImages: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
  resultDocuments: [
    { name: "report.pdf", mimeType: "application/pdf", data: "cGRm" },
  ],
};
const projected: TranscriptDisplayBlock = {
  type: "tool_call",
  id: source.id,
  name: source.name,
  inputJson: "",
  result: "",
  complete: true,
  remoteDetail: {
    messageId: "message-1",
    contentRevision: transcriptBlockContentRevision(source),
    available: true,
    imageCount: 1,
    documentCount: 1,
  },
};
function deliver(request: TranscriptBlockDetailRequest) {
  return parseTranscriptBlockDetailResponse(
    encodeTranscriptBlockDetail(request, source),
    request,
  );
}

describe("tool detail transport", () => {
  it("restores full display text and separate image/document responses", async () => {
    const request = vi.fn(async (selection: TranscriptBlockDetailRequest) =>
      deliver(selection),
    );
    expect(
      await loadRemoteTranscriptBlockDetail(projected, "session-1", request),
    ).toMatchObject({ ...source, remoteDetail: projected.remoteDetail });
    expect(request.mock.calls.map(([selection]) => selection.resource)).toEqual(
      [undefined, { kind: "image", index: 0 }, { kind: "document", index: 0 }],
    );
    for (const [selection] of request.mock.calls)
      expect(selection).toMatchObject({
        sessionId: "session-1",
        messageId: "message-1",
        blockId: source.id,
        contentRevision: projected.remoteDetail?.contentRevision,
      });
  });

  it("keeps text details usable and reports failed media explicitly", async () => {
    const restored = await loadRemoteTranscriptBlockDetail(
      projected,
      "session-1",
      async (selection) =>
        selection.resource
          ? { request: selection, state: "too_large" }
          : deliver(selection),
    );
    expect(restored.result).toBe("captured");
    expect(restored.remoteDetail?.warning).toContain("8 MiB");
    expect(restored.remoteDetail?.warning).toContain("Image 1");
    expect(restored.remoteDetail?.warning).toContain("Document 1");
  });

  it("rejects outdated/missing detail and leaves local VS Code blocks untouched", async () => {
    const request = vi.fn(async (selection: TranscriptBlockDetailRequest) => ({
      request: selection,
      state: "stale_revision" as const,
    }));
    await expect(
      loadRemoteTranscriptBlockDetail(projected, "session-1", request),
    ).rejects.toThrow("call has changed");
    expect(
      await loadRemoteTranscriptBlockDetail(source, "session-1", request),
    ).toBe(source);
    expect(request).toHaveBeenCalledTimes(1);
    await expect(
      loadRemoteTranscriptBlockDetail(
        {
          ...projected,
          remoteDetail: { ...projected.remoteDetail!, available: false },
        },
        "session-1",
        request,
      ),
    ).rejects.toThrow("updated session owner");
  });
});
