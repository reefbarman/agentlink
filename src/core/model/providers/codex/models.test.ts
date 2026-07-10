import {
  CODEX_DEFAULT_MODEL,
  CODEX_OAUTH_CHEAP_MODEL,
  getCodexModelCapabilities,
  getCodexPreviewModelFallback,
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

  it("maps limited-preview models to stable equivalents", () => {
    expect(getCodexPreviewModelFallback("gpt-5.6-sol")).toBe("gpt-5.5");
    expect(getCodexPreviewModelFallback("gpt-5.6-terra")).toBe("gpt-5.4");
    expect(getCodexPreviewModelFallback("gpt-5.6-luna")).toBe("gpt-5.4-mini");
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
    expect(resolveCodexReasoningEffort({ modelId: "gpt-5.4-pro" })).toBe(
      "high",
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
    for (const model of ["gpt-5.5", "gpt-5.6-sol"]) {
      const caps = getCodexModelCapabilities(model, "apiKey");
      expect(caps.contextWindow).toBe(1_050_000);
      expect(caps.maxInputTokens).toBeUndefined();
    }
  });
});
