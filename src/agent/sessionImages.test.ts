import { describe, expect, it } from "vitest";

import type { AgentMessage } from "./types.js";
import { collectSessionImages } from "./sessionImages.js";

describe("collectSessionImages", () => {
  it("collects user attachments and nested tool-result screenshots in transcript order", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "Use this reference",
        media: {
          images: [
            {
              name: "reference.jpg",
              mimeType: "image/jpeg",
              base64: "user-image",
            },
          ],
          documents: [],
        },
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "screenshot-call",
            content: [
              { type: "text", text: "Screenshot captured" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "screenshot-image",
                },
              },
            ],
          },
        ],
      },
    ];

    expect(collectSessionImages(messages)).toEqual([
      {
        id: "image_1",
        name: "reference.jpg",
        mimeType: "image/jpeg",
        base64: "user-image",
        messageIndex: 0,
        imageIndex: 0,
      },
      {
        id: "image_2",
        name: "image_2.png",
        mimeType: "image/png",
        base64: "screenshot-image",
        messageIndex: 1,
        imageIndex: 0,
      },
    ]);
  });
});
