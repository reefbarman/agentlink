import type {
  ChatModeInfo,
  ChatModelInfo,
  ChatProjectInfo,
  ChatReasoningEffort,
  ChatSlashCommandInfo,
  ChatSlashCommandSource,
} from "./chatCatalog.js";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("chat catalog protocol", () => {
  it("preserves project, mode, model, and slash-command wire shapes", () => {
    const project: ChatProjectInfo = {
      projectId: "project-1",
      displayName: "AgentLink",
      availability: "available",
    };
    const mode: ChatModeInfo = { slug: "code", name: "Code", icon: "code" };
    const model: ChatModelInfo = {
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      provider: "openai",
      providerDisplayName: "OpenAI",
      supportsToolUse: true,
      supportsImages: true,
      contextWindow: 200_000,
      maxInputTokens: 180_000,
      maxOutputTokens: 20_000,
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
      authenticated: true,
      condenseThreshold: 0.8,
    };
    const command: ChatSlashCommandInfo = {
      name: "skill:review",
      displayName: "review",
      description: "Review changes",
      source: "skill",
      builtin: false,
      skillPath: "/skills/review/SKILL.md",
      skillId: "project:review",
      skillRevision: "abc123",
      icon: "checklist",
    };

    expect(
      JSON.parse(JSON.stringify({ project, mode, model, command })),
    ).toEqual({
      project,
      mode,
      model,
      command,
    });
  });

  it("keeps reasoning efforts and command sources closed", () => {
    expectTypeOf<ChatReasoningEffort>().toEqualTypeOf<
      "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    >();
    expectTypeOf<ChatSlashCommandSource>().toEqualTypeOf<
      "builtin" | "project" | "global" | "agentlink" | "skill"
    >();
  });
});
