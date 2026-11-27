import type {
  CodexImageGenerationOptions,
  CodexServedImageTool,
} from "./imageGeneration.js";

export interface ImageGenerationOptionMismatch {
  image_index: number;
  option: "output_size" | "quality" | "background";
  requested: string;
  actual: string;
}

/**
 * Compares the explicitly requested output size and quality with what each
 * returned image reports. Image backends may silently return a different
 * size or a lower quality; callers surface the result so the agent does not
 * assume the request was honoured. `auto` requests are never compared.
 * A transparent background is reported whenever the caller did not ask for
 * one (unset or `opaque`): a partly transparent image looks normal in chat
 * but composites as a washed-out tile.
 */
export function imageGenerationOptionMismatches(
  options: Pick<
    CodexImageGenerationOptions,
    "outputSize" | "quality" | "background"
  >,
  images: ReadonlyArray<{
    size?: string;
    quality?: string;
    background?: string;
  }>,
): ImageGenerationOptionMismatch[] {
  const requestedSize =
    options.outputSize && options.outputSize !== "auto"
      ? options.outputSize.toLowerCase()
      : undefined;
  const requestedQuality =
    options.quality && options.quality !== "auto" ? options.quality : undefined;
  const mismatches: ImageGenerationOptionMismatch[] = [];
  images.forEach((image, index) => {
    const size = image.size?.trim().toLowerCase();
    if (requestedSize && size && size !== "auto" && size !== requestedSize) {
      mismatches.push({
        image_index: index,
        option: "output_size",
        requested: requestedSize,
        actual: size,
      });
    }
    const quality = image.quality?.trim().toLowerCase();
    if (
      requestedQuality &&
      quality &&
      quality !== "auto" &&
      quality !== requestedQuality
    ) {
      mismatches.push({
        image_index: index,
        option: "quality",
        requested: requestedQuality,
        actual: quality,
      });
    }
    const background = image.background?.trim().toLowerCase();
    if (
      background === "transparent" &&
      options.background !== "transparent" &&
      options.background !== "auto"
    ) {
      mismatches.push({
        image_index: index,
        option: "background",
        requested: options.background ?? "unset",
        actual: background,
      });
    }
  });
  return mismatches;
}

export interface ImageGenerationServedTool {
  /** The image model the caller asked for. */
  requestedImageModel: string;
  /** The tool settings the backend echoed, when it reported them. */
  tool?: CodexServedImageTool;
}

/**
 * Result fields to merge into a generate_image success payload: per-image
 * size/quality mismatches plus the image tool the backend actually served.
 */
export function imageGenerationOptionMismatchFields(
  options: Pick<
    CodexImageGenerationOptions,
    "outputSize" | "quality" | "background" | "maskImage" | "complexity"
  >,
  images: ReadonlyArray<{
    size?: string;
    quality?: string;
    background?: string;
  }>,
  served?: ImageGenerationServedTool,
): {
  served_image_tool?: CodexServedImageTool;
  option_mismatches?: ImageGenerationOptionMismatch[];
  warning?: string;
} {
  const mismatches = imageGenerationOptionMismatches(options, images);
  const servedTool = served?.tool;
  const servedModel = servedTool?.model?.trim();
  const modelReplaced = Boolean(
    servedModel && served && servedModel !== served.requestedImageModel,
  );
  const warnings: string[] = [];
  if (modelReplaced && served && servedTool) {
    const settings = [
      servedTool.size ? `size ${servedTool.size}` : undefined,
      servedTool.quality ? `quality ${servedTool.quality}` : undefined,
    ].filter(Boolean);
    const settingsText =
      settings.length > 0 ? ` with ${settings.join(", ")}` : "";
    const maskText = options.maskImage
      ? " The mask was sent but this backend does not apply it, so the edit may land outside the masked area."
      : "";
    const complexityText = options.complexity
      ? ` complexity ${options.complexity} was sent but has no effect on this backend.`
      : "";
    warnings.push(
      `The image backend served ${servedModel}${settingsText} instead of ${served.requestedImageModel}. On ChatGPT/Codex OAuth the backend chooses the image model, size and quality itself and ignores masks; the image model, exact sizes, quality, complexity and masks need an OpenAI API key. Describe the shape in the prompt (for example "Aspect ratio: 16:9") instead.${maskText}${complexityText ? ` The${complexityText}` : ""}`.trimEnd(),
    );
  }
  const sizeOrQuality = mismatches.filter(
    (item) => item.option !== "background",
  );
  if (sizeOrQuality.length > 0) {
    const summary = [
      ...new Set(
        sizeOrQuality.map(
          (item) =>
            `${item.option} requested ${item.requested}, returned ${item.actual}`,
        ),
      ),
    ].join("; ");
    warnings.push(
      `The image backend did not honour every requested option (${summary}). Use images[].size and images[].quality, not requested_options, when exact dimensions or quality matter.`,
    );
  }
  const transparent = [
    ...new Set(
      mismatches
        .filter((item) => item.option === "background")
        .map((item) => item.image_index),
    ),
  ];
  if (transparent.length > 0) {
    warnings.push(
      `The image backend returned a transparent background for image ${transparent.join(", ")} although transparency was not requested; the saved file may be partly see-through. If it must be opaque (for example to composite it), retry with background: "opaque".`,
    );
  }
  return {
    ...(servedTool ? { served_image_tool: servedTool } : {}),
    ...(mismatches.length > 0 ? { option_mismatches: mismatches } : {}),
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  };
}
