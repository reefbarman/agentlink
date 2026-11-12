import type { CodexImageGenerationOptions } from "./imageGeneration.js";

export interface ImageGenerationOptionMismatch {
  image_index: number;
  option: "output_size" | "quality";
  requested: string;
  actual: string;
}

/**
 * Compares the explicitly requested output size and quality with what each
 * returned image reports. Image backends may silently return a different
 * size or a lower quality; callers surface the result so the agent does not
 * assume the request was honoured. `auto` requests are never compared.
 */
export function imageGenerationOptionMismatches(
  options: Pick<CodexImageGenerationOptions, "outputSize" | "quality">,
  images: ReadonlyArray<{ size?: string; quality?: string }>,
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
  });
  return mismatches;
}

/** Result fields to merge into a generate_image success payload. */
export function imageGenerationOptionMismatchFields(
  options: Pick<CodexImageGenerationOptions, "outputSize" | "quality">,
  images: ReadonlyArray<{ size?: string; quality?: string }>,
): {
  option_mismatches?: ImageGenerationOptionMismatch[];
  warning?: string;
} {
  const mismatches = imageGenerationOptionMismatches(options, images);
  if (mismatches.length === 0) return {};
  const summary = [
    ...new Set(
      mismatches.map(
        (item) =>
          `${item.option} requested ${item.requested}, returned ${item.actual}`,
      ),
    ),
  ].join("; ");
  return {
    option_mismatches: mismatches,
    warning: `The image backend did not honour every requested option (${summary}). Use images[].size and images[].quality, not requested_options, when exact dimensions or quality matter.`,
  };
}
