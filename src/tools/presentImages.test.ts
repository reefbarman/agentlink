import { describe, expect, it, vi } from "vitest";
import {
  handlePresentImages,
  presentImages,
  selectSessionImagesForPresentation,
} from "./presentImages.js";

import type { SessionImageReference } from "../core/tools/types.js";

const images: SessionImageReference[] = [
  {
    id: "image_1",
    name: "reference.jpg",
    mimeType: "image/jpeg",
    base64: "first",
    messageIndex: 0,
    imageIndex: 0,
  },
  {
    id: "image_2",
    name: "screenshot.png",
    mimeType: "image/png",
    base64: "second",
    messageIndex: 2,
    imageIndex: 0,
  },
];

describe("present_images", () => {
  it("presents the most recent session image by default", () => {
    expect(handlePresentImages({}, () => images)).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "presented",
            count: 1,
            images: [
              {
                id: "image_2",
                name: "screenshot.png",
                mimeType: "image/png",
              },
            ],
            note: "These images are now shown in the chat; do not also embed them with Markdown.",
          }),
        },
        { type: "image", data: "second", mimeType: "image/png" },
      ],
    });
  });

  it("carries web image attribution into the presented image and summary", () => {
    const attribution = {
      origin: "web_page" as const,
      sourceUrl: "https://example.com/album",
      imageUrl: "https://cdn.example.com/cover.jpg",
      title: "Album cover",
    };
    const result = handlePresentImages({ image_ids: ["image_1"] }, () => [
      { ...images[0]!, attribution },
    ]);
    const summary = JSON.parse(
      (result.content[0] as { text: string }).text,
    ) as { images: Array<{ source?: string }>; note?: string };
    expect(summary.images[0]?.source).toBe("https://example.com/album");
    expect(summary.note).toContain("Source links");
    expect(result.content[1]).toEqual({
      type: "image",
      data: "first",
      mimeType: "image/jpeg",
      attribution,
    });
  });

  it("retrieves web URLs and candidates with attribution and keeps going past failures", async () => {
    const attribution = {
      origin: "web_url" as const,
      imageUrl: "https://coverartarchive.org/release/1/front-500",
    };
    const fetchWebImage = vi.fn(
      async (input: { url?: string; candidate_id?: string }) =>
        input.candidate_id
          ? {
              content: [{ type: "text" as const, text: "candidate expired" }],
              isError: true,
            }
          : {
              content: [
                { type: "text" as const, text: "{}" },
                {
                  type: "image" as const,
                  data: "cover",
                  mimeType: "image/jpeg",
                  attribution,
                },
              ],
            },
    );
    const result = await presentImages(
      {
        urls: ["https://coverartarchive.org/release/1/front-500"],
        candidate_ids: ["img_old"],
      },
      { getSessionImages: () => images, fetchWebImage },
    );
    expect(fetchWebImage).toHaveBeenCalledTimes(2);
    expect(result.isError).toBeUndefined();
    const summary = JSON.parse(
      (result.content[0] as { text: string }).text,
    ) as {
      count: number;
      errors: string[];
    };
    expect(summary.count).toBe(1);
    expect(summary.errors[0]).toContain("img_old: candidate expired");
    expect(result.content[1]).toEqual({
      type: "image",
      data: "cover",
      mimeType: "image/jpeg",
      attribution,
    });
  });

  it("reads local paths through the host reader and reports every failure", async () => {
    const result = await presentImages(
      { paths: ["missing.png"] },
      {
        readLocalImage: async () => {
          throw new Error("Image file not found: missing.png");
        },
      },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      "missing.png: Image file not found",
    );
  });

  it("combines exact and recent selections without duplicates", () => {
    expect(
      selectSessionImagesForPresentation(
        { image_ids: ["image_1"], use_recent_images: 2 },
        images,
      ).map((image) => image.id),
    ).toEqual(["image_1", "image_2"]);
  });

  it("reports available IDs when an exact image is missing", () => {
    expect(() =>
      selectSessionImagesForPresentation({ image_ids: ["image_3"] }, images),
    ).toThrow(
      'No session image found for image_ids entry "image_3". Available image IDs: image_1, image_2',
    );
  });

  it("rejects empty sessions and unsupported image formats", () => {
    expect(() => selectSessionImagesForPresentation({}, [])).toThrow(
      "No images are available in the current session",
    );
    expect(() =>
      selectSessionImagesForPresentation({}, [
        { ...images[0]!, mimeType: "image/svg+xml" },
      ]),
    ).toThrow("unsupported MIME type: image/svg+xml");
  });
});
