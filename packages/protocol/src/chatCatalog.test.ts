import {
  projectCoreModelCatalogToChatModels,
  type ChatModeInfo,
  type ChatModelInfo,
  type ChatProjectInfo,
  type ChatReasoningEffort,
  type ChatSlashCommandInfo,
  type ChatSlashCommandSource,
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

  it("projects readiness and truthful actions from one shared catalog snapshot", () => {
    const models = projectCoreModelCatalogToChatModels({
      models: [
        {
          id: "ready",
          displayName: "Ready",
          providerId: "ready-provider",
          contextWindow: 100,
          authenticated: false,
          readiness: { status: "ready" },
        },
        {
          id: "keyed",
          displayName: "Keyed",
          providerId: "key-provider",
          contextWindow: 100,
          authenticated: true,
          readiness: {
            status: "credentials_required",
            action: { kind: "api_key", providerId: "key-provider" },
            reason: "Missing key",
          },
        },
        {
          id: "down",
          displayName: "Down",
          providerId: "down-provider",
          contextWindow: 100,
          authenticated: false,
          readiness: { status: "unavailable", reason: "Offline" },
        },
      ],
    });

    expect(models).toEqual([
      expect.objectContaining({ authenticated: true, authAction: undefined }),
      expect.objectContaining({
        authenticated: false,
        authAction: { kind: "api_key", providerId: "key-provider" },
        unavailableReason: "Missing key",
      }),
      expect.objectContaining({
        authenticated: false,
        authAction: undefined,
        unavailableReason: "Offline",
      }),
    ]);
  });

  it("keeps reasoning efforts and command sources closed", () => {
    expectTypeOf<ChatReasoningEffort>().toEqualTypeOf<
      "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
    >();
    expectTypeOf<ChatSlashCommandSource>().toEqualTypeOf<
      "builtin" | "project" | "global" | "agentlink" | "skill"
    >();
  });
});
