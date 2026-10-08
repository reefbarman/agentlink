import {
  CODEX_MODEL_PROMPT_PROFILES,
  resolvePromptProfile,
} from "./promptProfilePolicy.js";
import { describe, expect, it } from "vitest";

import { CODEX_PICKER_MODEL_IDS } from "./codex/models.js";
import { isCurrentPromptProfileResolution } from "@agentlink/protocol/prompt-profile";

describe("shared prompt profile policy", () => {
  it("requires a deliberate default for every maintained picker model", () => {
    for (const modelId of CODEX_PICKER_MODEL_IDS) {
      expect(CODEX_MODEL_PROMPT_PROFILES[modelId]).toBeDefined();
    }
  });

  it.each(["gpt-6-astra", "gpt-6.1-sol", "gpt-5.6-sol"])(
    "uses the same automatic profile for both provider identities: %s",
    (modelId) => {
      for (const providerId of ["codex", "openai-codex", "openai"]) {
        const result = resolvePromptProfile({ providerId, modelId });
        expect(result).toMatchObject({
          profile: "reasoning",
          providerId,
          modelId,
        });
        expect(isCurrentPromptProfileResolution(result)).toBe(true);
      }
    },
  );

  it.each(["gpt-6-luna", "gpt-5.6-luna", "gpt-5.3-codex-spark", "gpt-99-sol"])(
    "keeps small or unknown variants conservative: %s",
    (modelId) => {
      expect(
        resolvePromptProfile({ providerId: "codex", modelId }).profile,
      ).toBe("compatibility");
    },
  );

  it.each(["compatibility", "reasoning"] as const)(
    "honours explicit compatible-model configuration: %s",
    (configuredProfile) => {
      const result = resolvePromptProfile({
        providerId: "openai-compatible:meridian",
        modelId: "local-alias",
        configuredProfile,
      });
      expect(result).toMatchObject({
        profile: configuredProfile,
        source: "configured-model",
      });
      expect(isCurrentPromptProfileResolution(result)).toBe(true);
    },
  );

  it("gives exact local-model overrides precedence over configuration and defaults", () => {
    expect(
      resolvePromptProfile({
        providerId: "codex",
        modelId: "gpt-6-astra",
        configuredProfile: "reasoning",
        overrides: { "gpt-6-astra": "compatibility" },
      }),
    ).toMatchObject({
      profile: "compatibility",
      source: "exact-model-override",
    });
    expect(
      resolvePromptProfile({
        providerId: "openai-compatible:claude",
        modelId: "opus-alias",
        configuredProfile: "compatibility",
        overrides: { "opus-alias": "reasoning" },
      }),
    ).toMatchObject({ profile: "reasoning", source: "exact-model-override" });
  });

  it("does not infer a custom model's capabilities from its name or transport", () => {
    for (const modelId of [
      "claude-opus-5-5",
      "gpt-6-astra",
      "custom-reasoner",
    ]) {
      expect(
        resolvePromptProfile({
          providerId: "openai-compatible:custom",
          modelId,
        }),
      ).toMatchObject({
        profile: "compatibility",
        source: "compatibility-default",
      });
    }
  });
});
