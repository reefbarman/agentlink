import type {
  ImageAttribution,
  ToolResult,
} from "@agentlink/protocol/tool-result";

import type { LocalMarkdownImage } from "./markdownImageResolver.js";
import type { SessionImageReference } from "../core/tools/types.js";
import { errorResult } from "@agentlink/protocol/tool-result";
import { toSupportedImageMediaType } from "../agent/providers/types.js";

const DEFAULT_RECENT_IMAGE_COUNT = 1;
const MAX_PRESENTED_IMAGES = 8;

export interface PresentImagesInput {
  image_ids?: unknown;
  use_recent_images?: unknown;
  urls?: unknown;
  candidate_ids?: unknown;
  paths?: unknown;
}

export interface PresentImagesDeps {
  getSessionImages?: () => SessionImageReference[];
  /** Retrieves one public image ({ url } or { candidate_id }) for the model. */
  fetchWebImage?: (input: {
    url?: string;
    candidate_id?: string;
  }) => Promise<ToolResult>;
  /** Reads one local image file, or throws with a user-facing reason. */
  readLocalImage?: (filePath: string) => Promise<LocalMarkdownImage>;
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return value.map((entry: string) => entry.trim());
}

interface PresentedImage {
  id?: string;
  name?: string;
  mimeType: string;
  base64: string;
  attribution?: ImageAttribution;
}

function textOf(result: ToolResult): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();
}

/**
 * present_images: shows images in the chat and returns them to the model.
 * Sources are session image IDs, public image URLs, inspect_page_images
 * candidates and (where the host allows) local image files.
 */
export async function presentImages(
  input: PresentImagesInput,
  deps: PresentImagesDeps,
): Promise<ToolResult> {
  const urls = stringList(input.urls, "urls");
  const candidateIds = stringList(input.candidate_ids, "candidate_ids");
  const paths = stringList(input.paths, "paths");
  const external = urls.length + candidateIds.length + paths.length;
  if (external === 0) {
    return handlePresentImages(input, deps.getSessionImages);
  }

  const presented: PresentedImage[] = [];
  if (input.image_ids !== undefined || input.use_recent_images !== undefined) {
    presented.push(
      ...selectSessionImagesForPresentation(
        {
          image_ids: input.image_ids,
          use_recent_images: input.use_recent_images,
        },
        deps.getSessionImages?.() ?? [],
      ),
    );
  }
  if (presented.length + external > MAX_PRESENTED_IMAGES) {
    throw new Error(
      `present_images supports at most ${MAX_PRESENTED_IMAGES} images per call`,
    );
  }

  const errors: string[] = [];
  const webRequests: Array<{ url?: string; candidate_id?: string }> = [
    ...urls.map((url) => ({ url })),
    ...candidateIds.map((candidate_id) => ({ candidate_id })),
  ];
  if (webRequests.length > 0 && !deps.fetchWebImage) {
    errors.push("Web images are not available here.");
  } else {
    for (const request of webRequests) {
      const result = await deps.fetchWebImage!(request);
      const image = result.content.find((block) => block.type === "image");
      if (result.isError || !image || image.type !== "image") {
        errors.push(
          `${request.url ?? request.candidate_id}: ${textOf(result) || "not retrieved"}`,
        );
        continue;
      }
      presented.push({
        mimeType: image.mimeType,
        base64: image.data,
        ...(image.attribution ? { attribution: image.attribution } : {}),
      });
    }
  }
  for (const filePath of paths) {
    if (!deps.readLocalImage) {
      errors.push(`${filePath}: local image files are not available here.`);
      continue;
    }
    try {
      const image = await deps.readLocalImage(filePath);
      presented.push({
        name: image.name,
        mimeType: image.mimeType,
        base64: image.base64,
      });
    } catch (error) {
      errors.push(
        `${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (presented.length === 0) {
    return errorResult(errors.join("\n") || "No images could be presented", {
      status: "no_images",
      tool: "present_images",
    });
  }
  return presentedResult(presented, errors);
}

function presentedResult(
  images: readonly PresentedImage[],
  errors: readonly string[] = [],
): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "presented",
          count: images.length,
          images: images.map(({ id, name, mimeType, attribution }) => ({
            ...(id ? { id } : {}),
            ...(name ? { name } : {}),
            mimeType,
            ...(attribution?.sourceUrl || attribution?.imageUrl
              ? { source: attribution.sourceUrl ?? attribution.imageUrl }
              : {}),
          })),
          ...(errors.length > 0 ? { errors } : {}),
          note: [
            "These images are now shown in the chat; do not also embed them with Markdown.",
            images.some((image) => image.attribution)
              ? "Source links are shown under each web image. Creator and licence are publisher-supplied and unverified."
              : undefined,
          ]
            .filter(Boolean)
            .join(" "),
        }),
      },
      ...images.map(({ base64, mimeType, attribution }) => ({
        type: "image" as const,
        data: base64,
        mimeType,
        ...(attribution ? { attribution } : {}),
      })),
    ],
  };
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
  return presentedResult(selected);
}
