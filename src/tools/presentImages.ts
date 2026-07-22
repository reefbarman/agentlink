import type { SessionImageReference } from "../core/tools/types.js";
import type { ToolResult } from "../shared/types.js";
import { toSupportedImageMediaType } from "../agent/providers/types.js";

const DEFAULT_RECENT_IMAGE_COUNT = 1;
const MAX_PRESENTED_IMAGES = 8;

export interface PresentImagesInput {
  image_ids?: unknown;
  use_recent_images?: unknown;
}

function selectedRecentCount(value: unknown): number {
  if (value === undefined || value === true) return DEFAULT_RECENT_IMAGE_COUNT;
  if (value === false) return 0;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(
      "use_recent_images must be true, false, or a positive number",
    );
  }
  return Math.min(Math.floor(numeric), MAX_PRESENTED_IMAGES);
}

export function selectSessionImagesForPresentation(
  input: PresentImagesInput,
  sessionImages: readonly SessionImageReference[],
): SessionImageReference[] {
  const byId = new Map(sessionImages.map((image) => [image.id, image]));
  const selected: SessionImageReference[] = [];

  if (input.image_ids !== undefined) {
    if (!Array.isArray(input.image_ids)) {
      throw new Error("image_ids must be an array of session image IDs");
    }
    for (const rawId of input.image_ids) {
      if (typeof rawId !== "string" || !rawId.trim()) {
        throw new Error("image_ids must be an array of session image IDs");
      }
      const id = rawId.trim();
      const image = byId.get(id);
      if (!image) {
        const available = sessionImages.map((item) => item.id).join(", ");
        throw new Error(
          `No session image found for image_ids entry "${id}"${available ? `. Available image IDs: ${available}` : ""}`,
        );
      }
      selected.push(image);
    }
  }

  const shouldSelectRecent =
    input.use_recent_images !== undefined || input.image_ids === undefined;
  if (shouldSelectRecent) {
    const count = selectedRecentCount(input.use_recent_images);
    if (count > 0) selected.push(...sessionImages.slice(-count));
  }

  const unique = Array.from(
    new Map(selected.map((image) => [image.id, image])).values(),
  );
  if (unique.length > MAX_PRESENTED_IMAGES) {
    throw new Error(
      `present_images supports at most ${MAX_PRESENTED_IMAGES} images per call`,
    );
  }
  if (unique.length === 0) {
    throw new Error("No images are available in the current session");
  }

  const unsupported = unique.find(
    (image) => !toSupportedImageMediaType(image.mimeType),
  );
  if (unsupported) {
    throw new Error(
      `Session image ${unsupported.id} has an unsupported MIME type: ${unsupported.mimeType}`,
    );
  }
  return unique;
}

export function handlePresentImages(
  input: PresentImagesInput,
  getSessionImages?: () => SessionImageReference[],
): ToolResult {
  const selected = selectSessionImagesForPresentation(
    input,
    getSessionImages?.() ?? [],
  );
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "presented",
          count: selected.length,
          images: selected.map(({ id, name, mimeType }) => ({
            id,
            name,
            mimeType,
          })),
        }),
      },
      ...selected.map(({ base64, mimeType }) => ({
        type: "image" as const,
        data: base64,
        mimeType,
      })),
    ],
  };
}
