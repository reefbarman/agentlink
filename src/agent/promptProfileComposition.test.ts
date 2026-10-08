import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentConfig } from "./types.js";
import { AgentSession } from "./AgentSession.js";
import { OpenAiCompatibleProvider } from "./providers/openaiCompatible/OpenAiCompatibleProvider.js";
import type { PromptProfile } from "@agentlink/protocol/prompt-profile";
import { buildPromptArtifacts } from "./systemPrompt.js";
import { createProjectlessSessionScope } from "@agentlink/protocol/workspace-project";
import { normalizeOpenAiCompatibleConnections } from "@agentlink/core/openai-compatible";
import { providerRegistry } from "./providers/index.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentlink-profile-composition-"),
  );
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function configureModels(profiles: PromptProfile[]) {
  const parsed = normalizeOpenAiCompatibleConnections([
    {
      id: "profile-composition",
      displayName: "Profile composition",
      baseUrl: "https://example.invalid/v1",
      profile: "generic",
      models: profiles.map((promptProfile, index) => ({
        id: `alias-${index}`,
        model: "opaque-upstream",
        displayName: `Model ${index}`,
        modelFamily: "anthropic",
        promptProfile,
        contextWindow: 200000,
        maxOutputTokens: 8192,
        supportsToolUse: true,
      })),
    },
  ]);
  expect(parsed.issues).toEqual([]);
  const provider = new OpenAiCompatibleProvider({
    connection: parsed.connections[0]!,
    secrets: { get: async () => undefined },
  });
  vi.spyOn(providerRegistry, "tryResolveProvider").mockReturnValue(provider);
  return provider;
}

function config(
  overrides?: AgentConfig["promptProfileOverrides"],
): AgentConfig {
  return {
    model: "alias-0",
    maxTokens: 8192,
    thinkingBudget: 0,
    showThinking: false,
    autoCondense: true,
    autoCondenseThreshold: 0.9,
    promptProfileOverrides: overrides,
  };
}

describe("configured profile production composition", () => {
  it.each(["compatibility", "reasoning"] as const)(
    "renders JSON %s through the real provider adapter",
    async (profile) => {
      const provider = configureModels([profile]);
      const artifacts = await buildPromptArtifacts("code", root, {
        providerId: provider.id,
        model: "alias-0",
      });
      expect(artifacts.promptProfile).toMatchObject({
        profile,
        source: "configured-model",
      });
      expect(artifacts.promptBreakdown.profile).toBe(profile);
      expect(artifacts.systemPrompt.includes("## Core Contract")).toBe(
        profile === "reasoning",
      );
      expect(artifacts.systemPrompt.startsWith("You are AgentLink,")).toBe(
        true,
      );
    },
  );

  it("keeps exact overrides, mode text, and evidence coherent through a direct model switch", async () => {
    const provider = configureModels(["reasoning", "compatibility"]);
    const session = await AgentSession.createForLegacyCwd({
      mode: "code",
      cwd: root,
      providerId: provider.id,
      config: config({ "alias-1": "reasoning" }),
    });
    await session.updateModelSelection("alias-1", provider.id);
    expect(session.promptProfile).toMatchObject({
      modelId: "alias-1",
      profile: "reasoning",
      source: "exact-model-override",
    });
    expect(session.systemPrompt).toContain("## Core Contract");
    expect(session.contextBreakdown?.prompt?.profile).toBe("reasoning");
    expect(session.modeInstructionAnchors.at(-1)?.blockText).toContain(
      "Take the fastest safe path",
    );
    await session.rebuildSystemPrompt({ promptProfileOverrides: {} });
    expect(session.promptProfile).toMatchObject({
      profile: "compatibility",
      source: "configured-model",
    });
    expect(session.systemPrompt).not.toContain("## Core Contract");
    expect(session.modeInstructionAnchors.at(-1)?.blockText).not.toContain(
      "Take the fastest safe path",
    );
  });

  it("applies projectless profiles and switches without accessing a workspace", async () => {
    const provider = configureModels(["reasoning", "compatibility"]);
    const session = await AgentSession.createProjectlessAsk({
      config: config(),
      providerId: provider.id,
      projectScope: createProjectlessSessionScope(),
    });
    expect(session.promptProfile).toMatchObject({
      profile: "reasoning",
      source: "configured-model",
    });
    expect(session.systemPrompt).toContain(
      "missing information materially blocks",
    );
    await session.updateModelSelection("alias-1", provider.id);
    expect(session.promptProfile.profile).toBe("compatibility");
    expect(session.systemPrompt).toContain(
      "self-contained clarifying question",
    );
    await session.rebuildSystemPrompt({
      promptProfileOverrides: { "alias-1": "reasoning" },
    });
    expect(session.promptProfile.source).toBe("exact-model-override");
    expect(session.systemPrompt).toContain("No local project, files, shell");
    expect(session.systemPrompt).not.toContain(root);
  });
});
