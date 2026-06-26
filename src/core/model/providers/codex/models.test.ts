import {
  CODEX_DEFAULT_MODEL,
  CODEX_OAUTH_CHEAP_MODEL,
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
    expect(resolveCodexEffectiveModel("gpt-5.5", "oauth")).toEqual({
      model: "gpt-5.5",
      remapped: false,
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
