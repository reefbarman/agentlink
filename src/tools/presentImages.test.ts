import { describe, expect, it } from "vitest";

import type { SessionImageReference } from "../core/tools/types.js";
import {
  handlePresentImages,
  selectSessionImagesForPresentation,
} from "./presentImages.js";

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
          }),
        },
        { type: "image", data: "second", mimeType: "image/png" },
      ],
    });
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
