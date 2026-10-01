import type {
  ModelCapabilities,
  ModelProvider,
  ProviderStreamEvent,
} from "./providers/types.js";
import {
  buildCondensedSessionImageIndex,
  collectSessionImages,
  collectStoredSessionImages,
} from "./sessionImages.js";
import { describe, expect, it, vi } from "vitest";
import { getEffectiveHistory, summarizeConversation } from "./condense.js";

import type { AgentMessage } from "./types.js";

const CAPABILITIES: ModelCapabilities = {
  supportsThinking: false,
  supportsCaching: false,
  supportsImages: true,
  supportsToolUse: true,
  contextWindow: 200_000,
  maxOutputTokens: 8192,
};

function provider(): ModelProvider {
  return {
    id: "mock",
    displayName: "Mock",
    condenseModel: "mock-condense",
    async isAuthenticated() {
      return true;
    },
    getCapabilities() {
      return CAPABILITIES;
    },
    listModels() {
      return [
        {
          id: "mock-model",
          displayName: "Mock",
          provider: "mock",
          capabilities: CAPABILITIES,
        },
      ];
    },
    async *stream(): AsyncGenerator<ProviderStreamEvent> {
      yield* [];
    },
    complete: vi.fn(async () => ({
      text: "<summary>Captured the login page and kept iterating.</summary>",
    })),
  };
}

function image(data: string) {
  return {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: "image/png" as const,
      data,
    },
  };
}

function screenshotTurn(callId: string, data: string): AgentMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: callId,
          name: "computer_use__screen_capture",
          input: {},
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: callId, content: [image(data)] },
      ],
    },
  ];
}

function conversation(): AgentMessage[] {
  return [
    {
      role: "user",
      content: "Match this mockup",
      media: {
        images: [
          { name: "mockup.png", mimeType: "image/png", base64: "mockup" },
        ],
        documents: [],
      },
    },
    ...screenshotTurn("shot-1", "first-capture"),
    {
      role: "user",
      content: [{ type: "text", text: "diagnostic" }, image("diagnostic")],
      diagnosticOnly: true,
    },
    ...screenshotTurn("shot-2", "second-capture"),
  ];
}

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

describe("collectStoredSessionImages", () => {
  it("keeps image IDs fixed after condensing hides older messages", async () => {
    const before = collectStoredSessionImages(conversation());
    expect(before.map(({ id, base64 }) => [id, base64])).toEqual([
      ["image_1", "mockup"],
      ["image_2", "first-capture"],
      ["image_3", "second-capture"],
    ]);

    const condensed = await summarizeConversation({
      messages: conversation(),
      provider: provider(),
      systemPrompt: "system",
      isAutomatic: true,
    });
    expect(condensed.error).toBeUndefined();
    const afterCondense = [
      ...condensed.messages,
      ...screenshotTurn("shot-3", "third-capture"),
    ];

    // Only the first message's image remains model-visible...
    expect(
      collectSessionImages(getEffectiveHistory(afterCondense)).map(
        (entry) => entry.base64,
      ),
    ).toEqual(["mockup", "third-capture"]);
    // ...but stored IDs do not shift, and the new capture continues the count.
    expect(
      collectStoredSessionImages(afterCondense).map(({ id, base64 }) => [
        id,
        base64,
      ]),
    ).toEqual([
      ["image_1", "mockup"],
      ["image_2", "first-capture"],
      ["image_3", "second-capture"],
      ["image_4", "third-capture"],
    ]);
  });

  it("drops images from turns discarded by a rewind without renumbering earlier ones", () => {
    const messages = [
      ...conversation(),
      ...screenshotTurn("shot-3", "third-capture"),
    ];
    // Rewind keeps a prefix of the stored history.
    const rewound = messages.slice(0, 3);

    expect(
      collectStoredSessionImages(rewound).map(({ id, base64 }) => [id, base64]),
    ).toEqual([
      ["image_1", "mockup"],
      ["image_2", "first-capture"],
    ]);
  });
});

describe("buildCondensedSessionImageIndex", () => {
  it("lists hidden images with provenance and the next ID inside the condense summary", async () => {
    const condensed = await summarizeConversation({
      messages: conversation(),
      provider: provider(),
      systemPrompt: "system",
      isAutomatic: true,
    });
    const summary = condensed.messages.at(-1)!;
    expect(summary.isSummary).toBe(true);
    const blocks = Array.isArray(summary.content) ? summary.content : [];
    const index = blocks.find(
      (block) =>
        block.type === "text" && block.text.startsWith("## Session images"),
    );

    expect(index).toBeDefined();
    const text = index?.type === "text" ? index.text : "";
    expect(text).toContain(
      "- image_2: image_2.png (image/png), returned by computer_use__screen_capture",
    );
    expect(text).toContain("- image_3: image_3.png");
    // The first message stays visible, so its attachment is not listed.
    expect(text).not.toContain("image_1");
    expect(text).not.toContain("diagnostic");
    expect(text).toContain(
      "The next new image in this conversation will be image_4.",
    );
  });

  it("caps the list and reports how many older images are omitted", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Start" },
      ...Array.from({ length: 25 }, (_, index) =>
        screenshotTurn(`shot-${index}`, `capture-${index}`),
      ).flat(),
    ];

    const text = buildCondensedSessionImageIndex(messages)!;
    expect(text).toContain(
      "- 5 older images before image_6 are also available.",
    );
    expect(text).toContain("- image_6:");
    expect(text).toContain("- image_25:");
    expect(text).not.toContain("- image_5:");
    expect(text).toContain("will be image_26.");
  });

  it("returns nothing when no images are hidden", () => {
    expect(
      buildCondensedSessionImageIndex([
        { role: "user", content: "Start" },
        { role: "assistant", content: [{ type: "text", text: "Done" }] },
      ]),
    ).toBeUndefined();
  });
});
