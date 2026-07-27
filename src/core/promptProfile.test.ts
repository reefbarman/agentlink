import {
  PROMPT_PROFILE_POLICY_REVISION,
  isCurrentPromptProfileResolution,
  isPromptProfile,
  normalizePromptProfileOverrides,
  promptProfileResolutionsEqual,
  resolvePromptProfile,
} from "./promptProfile.js";
import { describe, expect, it } from "vitest";

describe("prompt profile policy", () => {
  it("recognizes only supported profile identities", () => {
    expect(isPromptProfile("compatibility")).toBe(true);
    expect(isPromptProfile("reasoning")).toBe(true);
    expect(isPromptProfile("auto")).toBe(false);
    expect(isPromptProfile({})).toBe(false);
  });

  it("normalizes exact-model overrides and rejects malformed entries", () => {
    const normalized = normalizePromptProfileOverrides({
      " gpt-5.6-sol ": "reasoning",
      "claude-opus-4-8": "compatibility",
      invalid: "auto",
      numeric: 1,
      " ": "reasoning",
    });

    expect(normalized).toEqual({
      "gpt-5.6-sol": "reasoning",
      "claude-opus-4-8": "compatibility",
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(normalizePromptProfileOverrides(undefined)).toEqual({});
    expect(normalizePromptProfileOverrides([])).toEqual({});
    expect(normalizePromptProfileOverrides("reasoning")).toEqual({});
  });

  it("uses a valid exact-model override before automatic policy", () => {
    expect(
      resolvePromptProfile({
        providerId: "codex",
        modelId: "gpt-5.6-sol",
        overrides: { "gpt-5.6-sol": "reasoning" },
      }),
    ).toEqual({
      profile: "reasoning",
      source: "exact-model-override",
      policyRevision: PROMPT_PROFILE_POLICY_REVISION,
      providerId: "codex",
      modelId: "gpt-5.6-sol",
    });

    expect(
      resolvePromptProfile({
        providerId: "anthropic",
        modelId: "claude-opus-4-8",
        overrides: { "claude-opus-4-8": "compatibility" },
      }).profile,
    ).toBe("compatibility");
  });

  it("rejects malformed direct override maps without relying on boundary normalization", () => {
    expect(
      resolvePromptProfile({
        providerId: "codex",
        modelId: "gpt-5.6-sol",
        overrides: { "gpt-5.6-sol": "auto" } as never,
      }),
    ).toMatchObject({
      profile: "compatibility",
      source: "compatibility-default",
      providerId: "codex",
      modelId: "gpt-5.6-sol",
    });
  });

  it("keeps known reasoning-capable models on compatibility until evaluated", () => {
    for (const [providerId, modelId] of [
      ["codex", "gpt-5.6-sol"],
      ["anthropic", "claude-opus-4-8"],
      ["gemini", "gemini-2.5-pro"],
    ] as const) {
      expect(resolvePromptProfile({ providerId, modelId })).toMatchObject({
        profile: "compatibility",
        source: "compatibility-default",
        providerId,
        modelId,
      });
    }
  });

  it("keeps unknown, dynamic, and custom models on compatibility", () => {
    for (const args of [
      { providerId: "anthropic", modelId: "claude-future-9" },
      { providerId: "openai-compatible", modelId: "custom-reasoner" },
      { providerId: "future-provider", modelId: "future-model" },
      { modelId: "unrouted-model" },
    ]) {
      expect(resolvePromptProfile(args)).toMatchObject({
        profile: "compatibility",
        source: "compatibility-default",
        modelId: args.modelId,
      });
    }
  });

  it("validates current evidence without treating it as policy authority", () => {
    const current = resolvePromptProfile({
      providerId: "codex",
      modelId: "gpt-5.6-sol",
    });
    const forged = {
      ...current,
      profile: "reasoning" as const,
      source: "exact-model-override" as const,
    };

    expect(isCurrentPromptProfileResolution(current)).toBe(true);
    expect(isCurrentPromptProfileResolution(forged)).toBe(true);
    expect(
      isCurrentPromptProfileResolution({
        ...current,
        profile: "reasoning",
        source: "compatibility-default",
      }),
    ).toBe(false);
    expect(
      isCurrentPromptProfileResolution({
        ...current,
        profile: "compatibility",
        source: "evaluated-model",
      }),
    ).toBe(false);
    expect(promptProfileResolutionsEqual(current, current)).toBe(true);
    expect(promptProfileResolutionsEqual(forged, current)).toBe(false);
    expect(
      promptProfileResolutionsEqual(
        { ...current, policyRevision: "prompt-profile-policy-v0" },
        current,
      ),
    ).toBe(false);
    expect(
      promptProfileResolutionsEqual(
        { ...current, providerId: "anthropic" },
        current,
      ),
    ).toBe(false);
    expect(
      promptProfileResolutionsEqual(
        { ...current, modelId: "gpt-other" },
        current,
      ),
    ).toBe(false);
  });

  it("returns immutable resolution evidence", () => {
    const resolution = resolvePromptProfile({
      providerId: "codex",
      modelId: "gpt-5.6-sol",
    });

    expect(Object.isFrozen(resolution)).toBe(true);
    expect(resolution.policyRevision).toBe(PROMPT_PROFILE_POLICY_REVISION);
  });
});
