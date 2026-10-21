import { describe, expect, it, vi } from "vitest";

import {
  getEffectiveHistory,
  summarizeConversation,
  type CondenseMessage,
  type CondenseModelClient,
} from "./contextCondense.js";
import { buildSessionTranscriptSnapshot } from "./sessionTranscriptRecall.js";

function client(text: string): CondenseModelClient & {
  complete: ReturnType<typeof vi.fn>;
} {
  return {
    id: "fixture",
    condenseModel: "fixture-small",
    getCapabilities: () => ({
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      supportsThinking: false,
      supportsCaching: false,
      supportsImages: false,
      supportsToolUse: true,
    }),
    complete: vi.fn(async () => ({ text })),
  };
}

const messages: CondenseMessage[] = [
  { role: "user", content: "Build the parser in src/parser.ts" },
  { role: "assistant", content: "Started on the parser." },
  { role: "user", content: "Next, add tests for it" },
  { role: "assistant", content: "Tests added." },
];

describe("summarizeConversation without host hooks", () => {
  it("appends a summary, tags earlier messages and projects VS Code's effective history", async () => {
    const model = client("<summary>Parser built; tests added.</summary>");
    const result = await summarizeConversation({
      messages,
      provider: model,
      systemPrompt: "system",
      isAutomatic: true,
      filesRead: ["src/parser.ts"],
      cwd: "/project",
    });

    expect(result.error).toBeUndefined();
    expect(model.complete).toHaveBeenCalledWith(
      expect.objectContaining({ model: "fixture-small", temperature: 0 }),
    );
    const summary = result.messages.at(-1)!;
    expect(summary.isSummary).toBe(true);
    const text = JSON.stringify(summary.content);
    expect(text).toContain("## Conversation Summary");
    expect(text).toContain("Parser built; tests added.");
    // No host outline or image index without the hooks.
    expect(text).not.toContain("## File Context");
    expect(text).not.toContain("## Session images");
    expect(result.messages[0]!.condenseParent).toBeUndefined();
    expect(result.messages.slice(1, -1).every((m) => m.condenseParent)).toBe(
      true,
    );

    const effective = getEffectiveHistory(result.messages);
    expect(effective[0]).toBe(messages[0]);
    expect(effective[1]).toBe(summary);
    expect(effective[2]?.isResumeContext).toBe(true);
    expect(effective).toHaveLength(3);

    const snapshot = buildSessionTranscriptSnapshot(result.messages);
    expect(snapshot.messages.map((m) => m.condensed)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it("uses host hooks when supplied", async () => {
    const result = await summarizeConversation({
      messages,
      provider: client("<summary>done</summary>"),
      systemPrompt: "system",
      isAutomatic: false,
      filesRead: ["src/parser.ts"],
      cwd: "/project",
      foldFileContext: async (paths) =>
        paths.map((filePath) => ({ filePath, section: `OUTLINE ${filePath}` })),
      sessionImageIndex: () => "IMAGE-INDEX",
    });
    const text = JSON.stringify(result.messages.at(-1)!.content);
    expect(text).toContain("OUTLINE src/parser.ts");
    expect(text).toContain("IMAGE-INDEX");
  });
});
