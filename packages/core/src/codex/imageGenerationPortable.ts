export type CodexPortableImageModel =
  | "gpt-image-2.5-flare"
  | "gpt-image-2.5-sunburst";

export interface CodexPortableImageReference {
  label: string;
  imageURL: string;
}

export interface BuildCodexImageGenerationRequestParams {
  prompt: string;
  imageModel?: CodexPortableImageModel;
  references?: CodexPortableImageReference[];
}

export interface CodexImageGenerationRequestBody {
  model: "gpt-5.6-sol";
  stream: true;
  store: false;
  instructions: string;
  input: Array<{
    role: "user";
    content: Array<
      | { type: "input_text"; text: string }
      | { type: "input_image"; image_url: string; detail: "auto" }
    >;
  }>;
  tools: Array<{ type: "image_generation"; model: CodexPortableImageModel }>;
  tool_choice: { type: "image_generation" };
}

const MAX_PROMPT_LENGTH = 16_000;
const MAX_REFERENCES = 8;
const MAX_IMAGE_URL_LENGTH = 20 * 1024 * 1024;
const IMAGE_DATA_URL =
  /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const SUPPORTED_MODELS: readonly CodexPortableImageModel[] = [
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
];

/** Builds only the credential-free OAuth request body. The host owns auth, approval, and transport. */
export function buildCodexImageGenerationRequest(
  params: BuildCodexImageGenerationRequestParams,
): CodexImageGenerationRequestBody {
  if (!params || typeof params !== "object") {
    throw new Error("Image generation request parameters are required");
  }
  const keys = Object.keys(params);
  if (
    keys.some((key) => !["prompt", "imageModel", "references"].includes(key))
  ) {
    throw new Error("Unsupported image generation request option");
  }
  if (
    typeof params.prompt !== "string" ||
    !params.prompt.trim() ||
    params.prompt.length > MAX_PROMPT_LENGTH
  ) {
    throw new Error(
      `prompt must be a string of at most ${MAX_PROMPT_LENGTH} characters`,
    );
  }
  const imageModel =
    params.imageModel === undefined ? "gpt-image-2.5-flare" : params.imageModel;
  if (!SUPPORTED_MODELS.includes(imageModel)) {
    throw new Error("Unsupported Codex image generation model");
  }
  const references = params.references === undefined ? [] : params.references;
  if (!Array.isArray(references) || references.length > MAX_REFERENCES) {
    throw new Error(
      `references must contain between 0 and ${MAX_REFERENCES} images`,
    );
  }

  const content: CodexImageGenerationRequestBody["input"][number]["content"] = [
    {
      type: "input_text",
      text: `Create exactly one PNG image. ${params.prompt}`,
    },
  ];
  for (const reference of references) {
    if (!reference || typeof reference !== "object") {
      throw new Error("Each reference must include a label and imageURL");
    }
    if (
      Object.keys(reference).some((key) => !["label", "imageURL"].includes(key))
    ) {
      throw new Error("Unsupported reference image option");
    }
    if (
      typeof reference.label !== "string" ||
      !reference.label.trim() ||
      reference.label.length > 300
    ) {
      throw new Error("Each reference image must have a non-empty label");
    }
    if (
      typeof reference.imageURL !== "string" ||
      reference.imageURL.length > MAX_IMAGE_URL_LENGTH
    ) {
      throw new Error("Reference image URL is invalid or too large");
    }
    const match = IMAGE_DATA_URL.exec(reference.imageURL);
    if (!match || !isCanonicalBase64(match[2])) {
      throw new Error(
        "Reference image must be a bounded base64 PNG, JPEG, or WebP data URL",
      );
    }
    content.push({
      type: "input_text",
      text: `Reference image role: ${reference.label}`,
    });
    content.push({
      type: "input_image",
      image_url: reference.imageURL,
      detail: "auto",
    });
  }

  return {
    model: "gpt-5.6-sol",
    stream: true,
    store: false,
    instructions:
      "You are an image generation helper. Use the image_generation tool. Create exactly one PNG image. Do not add commentary.",
    input: [{ role: "user", content }],
    tools: [{ type: "image_generation", model: imageModel }],
    tool_choice: { type: "image_generation" },
  };
}

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  if (value.endsWith("==")) return !value.slice(0, -2).includes("=");
  if (value.endsWith("=")) return !value.slice(0, -1).includes("=");
  return !value.includes("=");
}

export type CodexImageGenerationEventResult =
  | { kind: "partial_image"; base64: string; eventType: string }
  | {
      kind: "final_image";
      base64: string;
      eventType: string;
      completionEvidence: boolean;
    }
  | {
      kind: "completed";
      eventType: string;
      completionEvidence: true;
      hasFinalImage: boolean;
    }
  | { kind: "refusal"; eventType: string; message?: string }
  | {
      kind: "provider_error";
      eventType: string;
      code?: string;
      message?: string;
    }
  | { kind: "incomplete"; eventType: string; reason?: string; message?: string }
  | { kind: "other"; eventType?: string };

/** Classifies one already-parsed provider event. Image bytes remain opaque base64 strings. */
export function parseCodexImageGenerationEvent(
  input: unknown,
): CodexImageGenerationEventResult {
  if (!isRecord(input)) return { kind: "other" };
  const eventType = typeof input.type === "string" ? input.type : undefined;
  if (!eventType) return { kind: "other" };

  if (
    eventType === "response.image_generation_call.partial_image" &&
    typeof input.partial_image_b64 === "string"
  ) {
    return {
      kind: "partial_image",
      base64: input.partial_image_b64,
      eventType,
    };
  }
  const response = isRecord(input.response) ? input.response : undefined;
  const error = isRecord(input.error)
    ? input.error
    : response && isRecord(response.error)
      ? response.error
      : undefined;
  if (eventType.includes("refusal")) {
    return {
      kind: "refusal",
      eventType,
      ...optionalString("message", input.delta, input.refusal, input.message),
    };
  }
  if (
    eventType === "response.error" ||
    eventType === "error" ||
    eventType === "response.failed" ||
    response?.status === "failed" ||
    error !== undefined
  ) {
    return {
      kind: "provider_error",
      eventType,
      ...optionalString(
        "code",
        error?.code,
        error?.type,
        input.code,
        response?.status,
      ),
      ...optionalString("message", error?.message, input.message),
    };
  }
  if (
    eventType === "response.incomplete" ||
    response?.status === "incomplete"
  ) {
    const details = isRecord(response?.incomplete_details)
      ? response.incomplete_details
      : undefined;
    return {
      kind: "incomplete",
      eventType,
      ...optionalString("reason", details?.reason, response?.status),
      ...optionalString("message", details?.message, input.message),
    };
  }
  if (eventType === "response.completed" && response?.status !== "completed") {
    return {
      kind: "incomplete",
      eventType,
      reason: "missing_completion_status",
    };
  }
  const image = imageResult(input);
  if (image) {
    return {
      kind: "final_image",
      base64: image,
      eventType,
      completionEvidence:
        eventType === "response.completed" && response?.status === "completed",
    };
  }
  if (eventType === "response.completed") {
    return {
      kind: "completed",
      eventType,
      completionEvidence: true,
      hasFinalImage: false,
    };
  }
  return { kind: "other", eventType };
}

function imageResult(event: Record<string, unknown>): string | undefined {
  if (
    event.type === "response.image_generation_call.completed" &&
    typeof event.result === "string"
  ) {
    return event.result;
  }
  if (
    event.type === "response.output_item.done" &&
    isRecord(event.item) &&
    event.item.type === "image_generation_call" &&
    typeof event.item.result === "string"
  ) {
    return event.item.result;
  }
  if (
    event.type === "response.completed" &&
    isRecord(event.response) &&
    Array.isArray(event.response.output)
  ) {
    for (const item of event.response.output) {
      if (
        isRecord(item) &&
        item.type === "image_generation_call" &&
        typeof item.result === "string"
      ) {
        return item.result;
      }
    }
  }
  return undefined;
}

function optionalString<T extends string>(
  key: T,
  ...values: unknown[]
): { [K in T]?: string } {
  const value = values.find(
    (candidate): candidate is string => typeof candidate === "string",
  );
  return value === undefined ? {} : ({ [key]: value } as { [K in T]?: string });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
