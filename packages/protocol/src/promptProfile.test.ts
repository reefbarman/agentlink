import { describe, expect, expectTypeOf, it } from "vitest";

import {
  PROMPT_PROFILE_POLICY_REVISION,
  isCurrentPromptProfileResolution,
  isPromptProfile,
  normalizePromptProfileOverrides,
  promptProfileResolutionsEqual,
  type PromptProfile,
  type PromptProfileResolution,
  type PromptProfileResolutionSource,
} from "./promptProfile.js";

const current: PromptProfileResolution = {
  profile: "reasoning",
  source: "evaluated-model",
  policyRevision: PROMPT_PROFILE_POLICY_REVISION,
  providerId: "codex",
  modelId: "gpt-5.6-sol",
};

describe("prompt profile protocol", () => {
  it("keeps profile identities and serialized resolution evidence stable", () => {
    expectTypeOf<PromptProfile>().toEqualTypeOf<
      "compatibility" | "reasoning"
    >();
    expectTypeOf<PromptProfileResolutionSource>().toEqualTypeOf<
      "exact-model-override" | "evaluated-model" | "compatibility-default"
    >();
    expectTypeOf<PromptProfileResolution>().toEqualTypeOf<{
      profile: PromptProfile;
      source: PromptProfileResolutionSource;
      policyRevision: typeof PROMPT_PROFILE_POLICY_REVISION;
      providerId?: string;
      modelId: string;
    }>();
  });

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

  it("validates coherent current evidence without treating it as policy authority", () => {
    expect(isCurrentPromptProfileResolution(current)).toBe(true);
    expect(
      isCurrentPromptProfileResolution({
        ...current,
        profile: "reasoning",
        source: "exact-model-override",
      }),
    ).toBe(true);
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
    expect(isCurrentPromptProfileResolution({ ...current, modelId: " " })).toBe(
      false,
    );
  });

  it("compares every serialized evidence field", () => {
    expect(promptProfileResolutionsEqual(current, current)).toBe(true);
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
      promptProfileResolutionsEqual({ ...current, modelId: "other" }, current),
    ).toBe(false);
  });
});
