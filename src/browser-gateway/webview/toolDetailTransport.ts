import type {
  TranscriptBlockDetailRequest,
  TranscriptBlockDetailResponse,
  TranscriptDisplayBlock,
} from "../dataPlane/transcriptBlockDetail";

export async function loadRemoteTranscriptBlockDetail(
  block: TranscriptDisplayBlock,
  sessionId: string,
  requestDetail: (
    request: TranscriptBlockDetailRequest,
  ) => Promise<TranscriptBlockDetailResponse>,
): Promise<TranscriptDisplayBlock> {
  const reference = block.remoteDetail;
  if (!reference) return block;
  if (!reference.available)
    throw new Error("Tool details require an updated session owner.");
  const request: TranscriptBlockDetailRequest = {
    kind: "transcript.block-detail",
    sessionId,
    messageId: reference.messageId,
    blockId: block.id,
    contentRevision: reference.contentRevision,
  };
  const response = await requestDetail(request);
  if (response.state !== "ready")
    throw new Error(detailStateMessage(response.state));
  if (
    response.block.type !== block.type ||
    response.block.id !== block.id ||
    (response.block.type === "tool_call" &&
      block.type === "tool_call" &&
      response.block.name !== block.name)
  ) {
    throw new Error("Tool detail identity changed.");
  }
  const restored: TranscriptDisplayBlock = {
    ...response.block,
    remoteDetail: reference,
  };
  if (restored.type !== "tool_call") return restored;

  const warnings: string[] = [];
  const images: NonNullable<typeof restored.resultImages> = [];
  const documents: NonNullable<typeof restored.resultDocuments> = [];
  for (const [index, descriptor] of response.images.entries()) {
    try {
      const image = await requestDetail({
        ...request,
        resource: { kind: "image", index },
      });
      if (image.state !== "media")
        throw new Error(detailStateMessage(image.state));
      if (image.mimeType !== descriptor.mimeType)
        throw new Error("Image detail type changed.");
      images.push({ mimeType: image.mimeType, data: image.data });
    } catch (error) {
      warnings.push(`Image ${index + 1}: ${errorMessage(error)}`);
    }
  }
  for (const [index, descriptor] of response.documents.entries()) {
    try {
      const document = await requestDetail({
        ...request,
        resource: { kind: "document", index },
      });
      if (document.state !== "media")
        throw new Error(detailStateMessage(document.state));
      if (
        document.mimeType !== descriptor.mimeType ||
        document.name !== descriptor.name
      )
        throw new Error("Document detail identity changed.");
      documents.push({
        name: descriptor.name,
        mimeType: document.mimeType,
        data: document.data,
      });
    } catch (error) {
      warnings.push(`Document ${index + 1}: ${errorMessage(error)}`);
    }
  }
  return {
    ...restored,
    ...(images.length ? { resultImages: images } : {}),
    ...(documents.length ? { resultDocuments: documents } : {}),
    remoteDetail: {
      ...reference,
      ...(warnings.length ? { warning: warnings.join("\n") } : {}),
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Result media is unavailable.";
}
function detailStateMessage(
  state: TranscriptBlockDetailResponse["state"],
): string {
  switch (state) {
    case "too_large":
      return "This result exceeds the 8 MiB detail delivery limit.";
    case "stale_revision":
      return "This call has changed. Retry to load the current details.";
    case "not_found":
      return "These details are no longer available in the selected session.";
    default:
      return "Tool detail response is unavailable.";
  }
}
