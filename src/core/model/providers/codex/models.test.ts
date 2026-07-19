import {
  CODEX_DEFAULT_MODEL,
  CODEX_OAUTH_CHEAP_MODEL,
  getCodexModelCapabilities,
  getCodexUnavailableModelFallback,
  listCodexModels,
  resolveCodexEffectiveModel,
  resolveCodexReasoningEffort,
} from "./models.js";
import { describe, expect, it } from "vitest";

describe("Codex model resolution", () => {
  it("keeps API-key models unchanged", () => {
    expect(resolveCodexEffectiveModel("gpt-5.4-pro", "apiKey")).toEqual({
      model: "gpt-5.4-pro",
      remapped: false,
    });
  });

  it("keeps OAuth-served models unchanged", () => {
    expect(resolveCodexEffectiveModel("gpt-5.6-sol", "oauth")).toEqual({
      model: "gpt-5.6-sol",
      remapped: false,
    });
  });

  it("lists GPT-5.6 models without preview labels", () => {
    const models = listCodexModels("codex");
    expect(models.find(({ id }) => id === "gpt-5.6-sol")?.displayName).toBe(
      "GPT-5.6 Sol",
    );
    expect(models.find(({ id }) => id === "gpt-5.6-terra")?.displayName).toBe(
      "GPT-5.6 Terra",
    );
    expect(models.find(({ id }) => id === "gpt-5.6-luna")?.displayName).toBe(
      "GPT-5.6 Luna",
    );
  });

  it("maps unavailable GPT-5.6 models to gpt-5.5, the last older backend model", () => {
    expect(getCodexUnavailableModelFallback("gpt-5.6-sol")).toBe("gpt-5.5");
    expect(getCodexUnavailableModelFallback("gpt-5.6-terra")).toBe("gpt-5.5");
    expect(getCodexUnavailableModelFallback("gpt-5.6-luna")).toBe("gpt-5.5");
  });

  it("follows upstream migrations for rotated-out OAuth models", () => {
    expect(resolveCodexEffectiveModel("gpt-5.4", "oauth")).toEqual({
      model: "gpt-5.6-terra",
      remapped: true,
    });
    expect(resolveCodexEffectiveModel("gpt-5.4-mini", "oauth")).toEqual({
      model: "gpt-5.6-luna",
      remapped: true,
    });
  });

  it("remaps unavailable OAuth mini/nano models to the cheap OAuth model", () => {
    expect(resolveCodexEffectiveModel("gpt-5.4-nano", "oauth")).toEqual({
      model: CODEX_OAUTH_CHEAP_MODEL,
      remapped: true,
    });
  });

  it("remaps unavailable OAuth non-mini models to the default OAuth model", () => {
    expect(resolveCodexEffectiveModel("gpt-5.4-pro", "oauth")).toEqual({
      model: CODEX_DEFAULT_MODEL,
      remapped: true,
    });
  });

  it("omits reasoning when requested effort is none", () => {
    expect(
      resolveCodexReasoningEffort({
        modelId: "gpt-5.5",
        requestedEffort: "none",
      }),
    ).toBeUndefined();
  });

  it("uses requested reasoning effort when provided", () => {
    expect(
      resolveCodexReasoningEffort({
        modelId: "gpt-5.5",
        requestedEffort: "high",
      }),
    ).toBe("high");
  });

  it("uses the effective model default reasoning effort", () => {
    expect(
      resolveCodexReasoningEffort({ modelId: "gpt-5.3-codex-spark" }),
    ).toBe("high");
    expect(resolveCodexReasoningEffort({ modelId: "gpt-5.4-pro" })).toBe(
      "high",
    );
  });

  it("lists Spark for OAuth but hides it on API-key auth", () => {
    const oauthIds = listCodexModels("codex", "oauth").map(({ id }) => id);
    const apiKeyIds = listCodexModels("codex", "apiKey").map(({ id }) => id);
    expect(oauthIds).toContain("gpt-5.3-codex-spark");
    expect(apiKeyIds).not.toContain("gpt-5.3-codex-spark");
    expect(apiKeyIds).toContain("gpt-5.4-pro");
    expect(apiKeyIds).toContain("gpt-5.2-codex");
    expect(getCodexUnavailableModelFallback("gpt-5.3-codex-spark")).toBe(
      "gpt-5.6-luna",
    );
  });

  it("maps API-retired codex models to their published replacements", () => {
    expect(getCodexUnavailableModelFallback("gpt-5.2-codex")).toBe("gpt-5.5");
    expect(getCodexUnavailableModelFallback("gpt-5.1-codex-max")).toBe(
      "gpt-5.5",
    );
    expect(getCodexUnavailableModelFallback("gpt-5.1-codex-mini")).toBe(
      "gpt-5.4-mini",
    );
  });

  it("uses the remapped effective model default reasoning effort", () => {
    const resolution = resolveCodexEffectiveModel("gpt-5.1-codex-max", "oauth");
    expect(resolution).toEqual({ model: CODEX_DEFAULT_MODEL, remapped: true });
    expect(resolveCodexReasoningEffort({ modelId: resolution.model })).toBe(
      "medium",
    );
  });

  it("falls back to medium reasoning for unknown models", () => {
    expect(resolveCodexReasoningEffort({ modelId: "unknown-model" })).toBe(
      "medium",
    );
  });
});

describe("Codex hosted web capabilities", () => {
  it("advertises cited hosted search for API-key and OAuth Responses", () => {
    expect(getCodexModelCapabilities("gpt-5.5", "apiKey").hostedWeb).toEqual({
      search: {
        supported: true,
        supportsDomainRestrictions: true,
        supportsCitations: true,
        supportsPageAccess: true,
      },
      fetch: { supported: false },
    });
    expect(getCodexModelCapabilities("gpt-5.5", "oauth").hostedWeb).toEqual({
      search: {
        supported: true,
        supportsDomainRestrictions: false,
        supportsCitations: true,
        supportsPageAccess: true,
      },
      fetch: { supported: false },
    });
  });
});

describe("Codex OAuth context window clamps", () => {
  it("clamps gpt-5.5 to the enforced 400k/272k window over OAuth", () => {
    const caps = getCodexModelCapabilities("gpt-5.5", "oauth");
    expect(caps.contextWindow).toBe(400_000);
    expect(caps.maxInputTokens).toBe(272_000);
  });

  it("clamps GPT-5.6 models to the enforced 353k input window over OAuth", () => {
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      const caps = getCodexModelCapabilities(model, "oauth");
      expect(caps.maxInputTokens).toBe(353_000);
      expect(caps.contextWindow).toBe(481_000);
    }
  });

  it("keeps the full advertised window over API-key auth", () => {
    for (const model of ["gpt-5.4", "gpt-5.5", "gpt-5.6-sol"]) {
      const caps = getCodexModelCapabilities(model, "apiKey");
      expect(caps.contextWindow).toBe(1_050_000);
      expect(caps.maxInputTokens).toBeUndefined();
    }
  });
});
