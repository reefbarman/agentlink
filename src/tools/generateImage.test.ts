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

import type { OnApprovalRequest } from "../shared/types.js";

import {
  buildRequestBodyForTest,
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
    }));

    const approved = await requestImageGenerationApprovalForTest({
      approvalManager: {} as never,
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

    expect(approved).toBe(true);
    const approvalRequest = onApprovalRequest.mock.calls[0]?.[0];
    expect(approvalRequest).toEqual(
      expect.objectContaining({
        kind: "write",
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
    expect(onApprovalRequest.mock.calls[0]?.[1]).toBe("session-1");
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
      path.join(process.cwd(), "tmp", "generate-image-ref-test-"),
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
      writtenImages,
    });

    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      path: "image-1.png",
      bytes: Buffer.byteLength("final"),
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
      writtenImages,
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
      writtenImages,
    });

    expect(writtenImages).toEqual([
      expect.objectContaining({
        path: "image-1.png",
        event_type: "response.image_generation_call.partial_image",
      }),
    ]);
  });
});
