import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/paths.js", () => ({
  resolveAndValidatePath: (inputPath: string) => ({
    absolutePath: inputPath,
    inWorkspace: !inputPath.includes("outside-workspace"),
  }),
  getRelativePath: (absolutePath: string) =>
    absolutePath.replace(`${process.cwd()}/`, "").replace(/\\/g, "/"),
}));

import { openAiCodexAuthManager } from "../agent/providers/codex/OpenAiCodexAuthManager.js";
import type { OnApprovalRequest } from "../shared/types.js";
import {
  codexImageGenerationErrorMetadata,
  createCodexImageGenerationResultError,
} from "../core/model/providers/codex/imageGeneration.js";

import {
  buildRequestBodyForTest,
  handleGenerateImage,
  parseCodexImageSseForTest,
  requestImageGenerationApprovalForTest,
  resolveReferenceImagesForTest,
  type GeneratedImage,
  type GenerateImageReferenceImage,
} from "./generateImage.js";

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function sseResponse(events: unknown[]): Response {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function makeTargets(dir: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    absolutePath: path.join(dir, `image-${index + 1}.png`),
    relPath: `image-${index + 1}.png`,
  }));
}

describe("requestImageGenerationApprovalForTest", () => {
  it("shows the image prompt in approval detail and accepts standard write-card decisions", async () => {
    const onApprovalRequest = vi.fn<OnApprovalRequest>(async () => ({
      decision: "accept",
      followUp: "Use the generated image in the README.",
    }));

    const result = await requestImageGenerationApprovalForTest({
      approvalManager: {
        isBuiltInToolApproved: vi.fn().mockReturnValue(false),
      } as never,
      sessionId: "session-1",
      onApprovalRequest,
      prompt: "Create a colorful Gemini icon with no text.",
      count: 1,
      size: "1024x1024",
      targets: [{ relPath: "generated-icons/gemini.png" }],
      referenceImages: [
        {
          id: "session:image_1",
          label: "image_1 (hexaza.png)",
          mimeType: "image/png",
          base64: tinyPngBase64,
          source: "session",
        },
      ],
      billing: "ChatGPT/Codex OAuth quota (active account)",
    });

    expect(result).toEqual({
      approved: true,
      followUp: "Use the generated image in the README.",
      rejectionReason: undefined,
    });
    const approvalRequest = onApprovalRequest.mock.calls[0]?.[0];
    expect(approvalRequest).toEqual(
      expect.objectContaining({
        kind: "write",
        targetPath: "generated-icons/gemini.png",
        choices: expect.arrayContaining([
          expect.objectContaining({ value: "accept" }),
          expect.objectContaining({ value: "reject" }),
        ]),
      }),
    );
    expect(approvalRequest?.detail).toContain(
      "Generation prompt:\nCreate a colorful Gemini icon with no text.",
    );
    expect(approvalRequest?.detail).toContain(
      "Reference images (1):\n- image_1 (hexaza.png)",
    );
    expect(approvalRequest?.detail).toContain(
      "Generate for Session also authorizes later generate_image calls in this chat, including creation of new workspace PNG outputs.",
    );
    expect(onApprovalRequest.mock.calls[0]?.[1]).toBe("session-1");
  });

  it("promotes generate_image approval for the rest of the session", async () => {
    const approvalManager = {
      isBuiltInToolApproved: vi.fn().mockReturnValue(false),
      approveBuiltInTool: vi.fn(),
    };
    const onApprovalRequest = vi.fn<OnApprovalRequest>(async () => ({
      decision: "accept-session",
    }));

    const result = await requestImageGenerationApprovalForTest({
      approvalManager: approvalManager as never,
      sessionId: "session-1",
      onApprovalRequest,
      prompt: "Create an icon.",
      count: 1,
      billing: "OpenAI API key billing",
    });

    expect(result.approved).toBe(true);
    expect(approvalManager.approveBuiltInTool).toHaveBeenCalledWith(
      "session-1",
      "generate_image",
    );
    expect(onApprovalRequest.mock.calls[0]?.[0].choices).toEqual([
      { label: "Generate", value: "accept", isPrimary: true },
      { label: "Generate for Session", value: "accept-session" },
      { label: "Deny", value: "reject", isDanger: true },
    ]);
  });

  it("skips the prompt when generate_image is approved for the session", async () => {
    const approvalManager = {
      isBuiltInToolApproved: vi.fn().mockReturnValue(true),
      approveBuiltInTool: vi.fn(),
    };
    const onApprovalRequest = vi.fn<OnApprovalRequest>();

    const result = await requestImageGenerationApprovalForTest({
      approvalManager: approvalManager as never,
      sessionId: "session-1",
      onApprovalRequest,
      prompt: "Create an icon.",
      count: 1,
      billing: "OpenAI API key billing",
    });

    expect(result).toEqual({ approved: true });
    expect(onApprovalRequest).not.toHaveBeenCalled();
    expect(approvalManager.approveBuiltInTool).not.toHaveBeenCalled();
  });

  it("rejects unadvertised accept-prefixed decisions", async () => {
    const approvalManager = {
      isBuiltInToolApproved: vi.fn().mockReturnValue(false),
      approveBuiltInTool: vi.fn(),
    };
    const onApprovalRequest = vi.fn<OnApprovalRequest>(async () => ({
      decision: "accept-always",
    }));

    const result = await requestImageGenerationApprovalForTest({
      approvalManager: approvalManager as never,
      sessionId: "session-1",
      onApprovalRequest,
      prompt: "Create an icon.",
      count: 1,
      billing: "OpenAI API key billing",
    });

    expect(result.approved).toBe(false);
    expect(approvalManager.approveBuiltInTool).not.toHaveBeenCalled();
  });

  it("preserves rejection reasons from approval cards", async () => {
    const onApprovalRequest = vi.fn<OnApprovalRequest>(async () => ({
      decision: "reject",
      rejectionReason: "Prompt should mention the brand palette.",
    }));

    const result = await requestImageGenerationApprovalForTest({
      approvalManager: {
        isBuiltInToolApproved: vi.fn().mockReturnValue(false),
      } as never,
      sessionId: "session-1",
      onApprovalRequest,
      prompt: "Create an icon.",
      count: 1,
      targets: [{ relPath: "generated-icons/icon.png" }],
      billing: "OpenAI API key billing",
    });

    expect(result).toEqual({
      approved: false,
      followUp: undefined,
      rejectionReason: "Prompt should mention the brand palette.",
    });
  });
});

describe("handleGenerateImage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves classified metadata when the post-refresh attempt fails", async () => {
    vi.spyOn(openAiCodexAuthManager, "resolveModelAuth").mockResolvedValue({
      method: "oauth",
      bearerToken: "expired-token",
      accountId: "account-1",
      oauthAccountPoolId: "pool-1",
      oauthAccountLabel: "Test account",
      canRefresh: true,
    });
    const forceRefresh = vi
      .spyOn(openAiCodexAuthManager, "forceRefreshModelAuth")
      .mockResolvedValue({
        method: "oauth",
        bearerToken: "refreshed-token",
        accountId: "account-1",
        oauthAccountPoolId: "pool-1",
        oauthAccountLabel: "Test account",
        canRefresh: true,
      });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(
        sseResponse([
          {
            type: "response.refusal.done",
            refusal: "Provider refused the image request.",
          },
          {
            type: "response.error",
            error: { code: "server_unavailable", message: "late error" },
          },
        ]),
      );
    const onApprovalRequest = vi.fn<OnApprovalRequest>(async () => ({
      decision: "accept",
      followUp: "Use a different prompt.",
    }));

    const result = await handleGenerateImage(
      { prompt: "Create a test image", count: 1 },
      {
        isBuiltInToolApproved: vi.fn().mockReturnValue(false),
      } as never,
      "session-1",
      onApprovalRequest,
    );
    const text =
      result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(result.isError).toBe(true);
    expect(JSON.parse(text)).toMatchObject({
      error:
        "Codex image generation returned no image (refusal): Provider refused the image request.",
      failure_category: "refusal",
      retryable: false,
      quota_consumed: "unknown",
      generated_count: 0,
      event_types: ["response.refusal.done", "response.error"],
      provider_event_type: "response.refusal.done",
      provider_message: "Provider refused the image request.",
      follow_up: "Use a different prompt.",
    });
    expect(forceRefresh).toHaveBeenCalledWith("oauth", {
      oauthAccountPoolId: "pool-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("reference images", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("resolves workspace file references as base64 input images", async () => {
    const dir = await fs.mkdtemp(
      path.join(process.cwd(), ".generate-image-ref-test-"),
    );
    tempDirs.push(dir);
    const imagePath = path.join(dir, "reference.png");
    await fs.writeFile(imagePath, Buffer.from(tinyPngBase64, "base64"));

    const [image] = await resolveReferenceImagesForTest({
      referenceImagePaths: [imagePath],
    });

    expect(image).toMatchObject({
      label: path.relative(process.cwd(), imagePath).replace(/\\/g, "/"),
      mimeType: "image/png",
      base64: tinyPngBase64,
      source: "file",
    });
  });

  it("selects prior session images by id and recent count", async () => {
    const images = await resolveReferenceImagesForTest({
      referenceImageIds: ["image_1"],
      useRecentImages: 1,
      getSessionImages: () => [
        {
          id: "image_1",
          name: "first.png",
          mimeType: "image/png",
          base64: "first",
          messageIndex: 0,
          imageIndex: 0,
        },
        {
          id: "image_2",
          name: "second.png",
          mimeType: "image/png",
          base64: "second",
          messageIndex: 1,
          imageIndex: 0,
        },
      ],
    });

    expect(images.map((image) => image.label)).toEqual([
      "image_1 (first.png)",
      "image_2 (second.png)",
    ]);
    expect(images.map((image) => image.source)).toEqual(["session", "session"]);
  });

  it("dedupes overlapping explicit and recent session references", async () => {
    const images = await resolveReferenceImagesForTest({
      referenceImageIds: ["image_2"],
      useRecentImages: 1,
      getSessionImages: () => [
        {
          id: "image_1",
          name: "first.png",
          mimeType: "image/png",
          base64: "first",
          messageIndex: 0,
          imageIndex: 0,
        },
        {
          id: "image_2",
          name: "second.png",
          mimeType: "image/png",
          base64: "second",
          messageIndex: 1,
          imageIndex: 0,
        },
      ],
    });

    expect(images.map((image) => image.label)).toEqual([
      "image_2 (second.png)",
    ]);
  });

  it("normalizes session image MIME types using filename fallback", async () => {
    const [image] = await resolveReferenceImagesForTest({
      referenceImageIds: ["image_1"],
      getSessionImages: () => [
        {
          id: "image_1",
          name: "reference.jpg",
          mimeType: "",
          base64: "jpg-bytes",
          messageIndex: 0,
          imageIndex: 0,
        },
      ],
    });

    expect(image.mimeType).toBe("image/jpeg");
  });

  it("throws when session image MIME type cannot be normalized", async () => {
    await expect(
      resolveReferenceImagesForTest({
        referenceImageIds: ["image_1"],
        getSessionImages: () => [
          {
            id: "image_1",
            name: "reference.bmp",
            mimeType: "image/bmp",
            base64: "bmp-bytes",
            messageIndex: 0,
            imageIndex: 0,
          },
        ],
      }),
    ).rejects.toThrow(/unsupported MIME type/);
  });

  it("throws with available IDs for unknown prior session image refs", async () => {
    await expect(
      resolveReferenceImagesForTest({
        referenceImageIds: ["image_9"],
        getSessionImages: () => [
          {
            id: "image_1",
            name: "first.png",
            mimeType: "image/png",
            base64: "first",
            messageIndex: 0,
            imageIndex: 0,
          },
        ],
      }),
    ).rejects.toThrow(/Available image IDs: image_1/);
  });

  it("throws for unsupported and outside-workspace file references", async () => {
    await expect(
      resolveReferenceImagesForTest({
        referenceImagePaths: ["tmp/reference.txt"],
      }),
    ).rejects.toThrow(/reference image must be PNG, JPEG, GIF, or WebP/);

    await expect(
      resolveReferenceImagesForTest({
        referenceImagePaths: ["outside-workspace/reference.png"],
      }),
    ).rejects.toThrow(/must resolve inside the workspace/);
  });

  it("throws for non-string reference arrays and more than 8 refs", async () => {
    await expect(
      resolveReferenceImagesForTest({
        referenceImageIds: ["image_1", 42 as unknown as string],
      }),
    ).rejects.toThrow(/reference_image_ids must be an array of strings/);

    await expect(
      resolveReferenceImagesForTest({
        useRecentImages: true,
        referenceImageIds: [
          "image_1",
          "image_2",
          "image_3",
          "image_4",
          "image_5",
        ],
        getSessionImages: () =>
          Array.from({ length: 9 }, (_, index) => ({
            id: `image_${index + 1}`,
            name: `image-${index + 1}.png`,
            mimeType: "image/png",
            base64: `image-${index + 1}`,
            messageIndex: index,
            imageIndex: 0,
          })),
      }),
    ).rejects.toThrow(/at most 8 reference images/);
  });

  it("includes input_image blocks in the Codex request body", () => {
    const referenceImages: GenerateImageReferenceImage[] = [
      {
        id: "session:image_1",
        label: "image_1 (style.png)",
        mimeType: "image/png",
        base64: "abc123",
        source: "session",
      },
    ];

    const body = buildRequestBodyForTest({
      prompt: "Use the reference style.",
      count: 1,
      model: "gpt-5",
      referenceImages,
    });

    expect(body).toMatchObject({
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: expect.stringContaining("reference style"),
            },
            {
              type: "input_image",
              image_url: "data:image/png;base64,abc123",
              detail: "auto",
            },
          ],
        },
      ],
    });
  });
});

describe("parseCodexImageSseForTest", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("updates the same output file for multiple partials of one image", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-image-test-"),
    );
    tempDirs.push(dir);
    const targets = await makeTargets(dir, 1);
    const writtenImages: GeneratedImage[] = [];

    const result = await parseCodexImageSseForTest({
      response: sseResponse([
        {
          type: "response.image_generation_call.partial_image",
          item_id: "ig_1",
          output_index: 0,
          partial_image_index: 0,
          partial_image_b64: Buffer.from("first").toString("base64"),
          size: "512x512",
          quality: "low",
          output_format: "png",
        },
        {
          type: "response.image_generation_call.partial_image",
          item_id: "ig_1",
          output_index: 0,
          partial_image_index: 1,
          partial_image_b64: Buffer.from("final").toString("base64"),
          size: "1024x1024",
          quality: "medium",
          output_format: "png",
        },
      ]),
      targets,
      maxImages: 1,
      generatedImages: writtenImages,
    });

    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      path: "image-1.png",
      bytes: Buffer.byteLength("final"),
      mimeType: "image/png",
      base64: Buffer.from("final").toString("base64"),
      size: "1024x1024",
      quality: "medium",
    });
    await expect(fs.readFile(targets[0].absolutePath, "utf8")).resolves.toBe(
      "final",
    );
  });

  it("maps distinct image_generation items to distinct targets", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-image-test-"),
    );
    tempDirs.push(dir);
    const targets = await makeTargets(dir, 2);
    const writtenImages: GeneratedImage[] = [];

    const result = await parseCodexImageSseForTest({
      response: sseResponse([
        {
          type: "response.image_generation_call.partial_image",
          item_id: "ig_1",
          output_index: 0,
          partial_image_b64: Buffer.from("one").toString("base64"),
        },
        {
          type: "response.image_generation_call.partial_image",
          item_id: "ig_2",
          output_index: 1,
          partial_image_b64: Buffer.from("two").toString("base64"),
        },
      ]),
      targets,
      maxImages: 2,
      generatedImages: writtenImages,
    });

    expect(result.images.map((image) => image.path)).toEqual([
      "image-1.png",
      "image-2.png",
    ]);
    await expect(fs.readFile(targets[0].absolutePath, "utf8")).resolves.toBe(
      "one",
    );
    await expect(fs.readFile(targets[1].absolutePath, "utf8")).resolves.toBe(
      "two",
    );
  });

  it("collects image payloads without writing files when no targets are provided", async () => {
    const generatedImages: GeneratedImage[] = [];

    const result = await parseCodexImageSseForTest({
      response: sseResponse([
        {
          type: "response.image_generation_call.partial_image",
          item_id: "ig_1",
          output_index: 0,
          partial_image_b64: Buffer.from("display-only").toString("base64"),
          output_format: "png",
        },
      ]),
      maxImages: 1,
      generatedImages,
    });

    expect(result.images[0]).toEqual(
      expect.objectContaining({
        bytes: Buffer.byteLength("display-only"),
        mimeType: "image/png",
        base64: Buffer.from("display-only").toString("base64"),
        event_type: "response.image_generation_call.partial_image",
      }),
    );
    expect(result.images[0].path).toBeUndefined();
    expect(generatedImages).toBe(result.images);
  });

  it("collects the final result from a completed output item", async () => {
    const finalBase64 = Buffer.from("final-output-item").toString("base64");

    const result = await parseCodexImageSseForTest({
      response: sseResponse([
        {
          type: "response.image_generation_call.completed",
          item_id: "ig_1",
          output_index: 0,
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "ig_1",
            type: "image_generation_call",
            status: "completed",
            result: finalBase64,
            size: "1536x1024",
            quality: "high",
            output_format: "png",
          },
        },
        {
          type: "response.completed",
          response: { status: "completed" },
        },
      ]),
      maxImages: 1,
      generatedImages: [],
    });

    expect(result.images).toEqual([
      expect.objectContaining({
        bytes: Buffer.byteLength("final-output-item"),
        base64: finalBase64,
        size: "1536x1024",
        quality: "high",
        output_format: "png",
        event_type: "response.output_item.done",
      }),
    ]);
  });

  it("replaces a partial with the final result for the same output", async () => {
    const partialBase64 = Buffer.from("partial-image").toString("base64");
    const finalBase64 = Buffer.from("final-image").toString("base64");

    const result = await parseCodexImageSseForTest({
      response: sseResponse([
        {
          type: "response.image_generation_call.partial_image",
          output_index: 0,
          partial_image_index: 0,
          partial_image_b64: partialBase64,
          size: "1536x1024",
          quality: "high",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "ig_1",
            type: "image_generation_call",
            status: "completed",
            result: finalBase64,
          },
        },
      ]),
      maxImages: 1,
      generatedImages: [],
    });

    expect(result.images).toEqual([
      expect.objectContaining({
        bytes: Buffer.byteLength("final-image"),
        base64: finalBase64,
        size: "1536x1024",
        quality: "high",
        event_type: "response.output_item.done",
      }),
    ]);
  });

  it("collects final image results from the completed response", async () => {
    const firstBase64 = Buffer.from("first-final").toString("base64");
    const secondBase64 = Buffer.from("second-final").toString("base64");

    const result = await parseCodexImageSseForTest({
      response: sseResponse([
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              {
                id: "ig_1",
                type: "image_generation_call",
                status: "completed",
                result: firstBase64,
              },
              {
                id: "ig_2",
                type: "image_generation_call",
                status: "completed",
                result: secondBase64,
              },
            ],
          },
        },
      ]),
      maxImages: 2,
      generatedImages: [],
    });

    expect(result.images.map((image) => image.base64)).toEqual([
      firstBase64,
      secondBase64,
    ]);
  });

  it("classifies an explicit refusal without inferring quota use", async () => {
    const result = await parseCodexImageSseForTest({
      response: sseResponse([
        {
          type: "response.refusal.done",
          refusal: "This image request was refused.",
        },
      ]),
      maxImages: 1,
      generatedImages: [],
    });

    const error = createCodexImageGenerationResultError(result);
    expect(error).toMatchObject({
      name: "CodexImageGenerationError",
      message:
        "Codex image generation returned no image (refusal): This image request was refused.",
      failure: {
        category: "refusal",
        eventType: "response.refusal.done",
        message: "This image request was refused.",
        retryable: false,
        quotaConsumed: "unknown",
        eventTypes: ["response.refusal.done"],
      },
    });
    expect(codexImageGenerationErrorMetadata(error)).toEqual({
      failure_category: "refusal",
      retryable: false,
      quota_consumed: "unknown",
      generated_count: 0,
      event_types: ["response.refusal.done"],
      provider_event_type: "response.refusal.done",
      provider_message: "This image request was refused.",
    });
  });

  it("preserves provider failure code and explicit quota evidence", async () => {
    const result = await parseCodexImageSseForTest({
      response: sseResponse([
        {
          type: "response.failed",
          quota_consumed: false,
          error: {
            code: "server_unavailable",
            message: "Image backend unavailable",
          },
        },
      ]),
      maxImages: 1,
      generatedImages: [],
    });

    expect(
      codexImageGenerationErrorMetadata(
        createCodexImageGenerationResultError(result),
      ),
    ).toEqual({
      failure_category: "provider_error",
      retryable: true,
      quota_consumed: false,
      generated_count: 0,
      event_types: ["response.failed"],
      provider_event_type: "response.failed",
      provider_code: "server_unavailable",
      provider_message: "Image backend unavailable",
    });
  });

  it("distinguishes incomplete and generic no-image completion", async () => {
    const incomplete = await parseCodexImageSseForTest({
      response: sseResponse([
        {
          type: "response.completed",
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          },
        },
      ]),
      maxImages: 1,
      generatedImages: [],
    });
    expect(
      codexImageGenerationErrorMetadata(
        createCodexImageGenerationResultError(incomplete),
      ),
    ).toMatchObject({
      failure_category: "incomplete",
      retryable: true,
      quota_consumed: "unknown",
      provider_code: "max_output_tokens",
    });

    const noImage = await parseCodexImageSseForTest({
      response: sseResponse([{ type: "response.completed", response: {} }]),
      maxImages: 1,
      generatedImages: [],
    });
    expect(
      codexImageGenerationErrorMetadata(
        createCodexImageGenerationResultError(noImage),
      ),
    ).toEqual({
      failure_category: "no_image",
      retryable: false,
      quota_consumed: "unknown",
      generated_count: 0,
      event_types: ["response.completed"],
    });
  });

  it("records partial files in the shared writtenImages array", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentlink-image-test-"),
    );
    tempDirs.push(dir);
    const targets = await makeTargets(dir, 1);
    const writtenImages: GeneratedImage[] = [];

    await parseCodexImageSseForTest({
      response: sseResponse([
        {
          type: "response.image_generation_call.partial_image",
          item_id: "ig_1",
          output_index: 0,
          partial_image_b64: tinyPngBase64,
        },
      ]),
      targets,
      maxImages: 1,
      generatedImages: writtenImages,
    });

    expect(writtenImages).toEqual([
      expect.objectContaining({
        path: "image-1.png",
        event_type: "response.image_generation_call.partial_image",
      }),
    ]);
  });
});
