import { describe, expect, it } from "vitest";

import { deriveModelSetupState, type ModelSetupModel } from "./modelSetup";

const models: ModelSetupModel[] = [
  {
    id: "openai/gpt-5",
    displayName: "GPT-5",
    provider: "codex",
    providerDisplayName: "ChatGPT/Codex",
    authenticated: true,
  },
  {
    id: "anthropic/claude-sonnet",
    displayName: "Claude Sonnet",
    provider: "anthropic",
    authenticated: false,
  },
];

describe("deriveModelSetupState", () => {
  it("waits while the selected model or catalog is still hydrating", () => {
    expect(deriveModelSetupState(undefined, models)).toEqual({
      kind: "checking",
      selectedModelId: "",
    });
    expect(deriveModelSetupState("openai/gpt-5", [])).toEqual({
      kind: "checking",
      selectedModelId: "openai/gpt-5",
    });
  });

  it("reports ready when the selected model has configured credentials", () => {
    expect(deriveModelSetupState("openai/gpt-5", models)).toEqual({
      kind: "ready",
      model: models[0],
    });
  });

  it("reports setup required when the selected model lacks credentials", () => {
    expect(deriveModelSetupState("anthropic/claude-sonnet", models)).toEqual({
      kind: "credentials_required",
      model: models[1],
    });
  });

  it("reports an unavailable selected model once the catalog has loaded", () => {
    expect(deriveModelSetupState("retired/model", models)).toEqual({
      kind: "model_unavailable",
      selectedModelId: "retired/model",
    });
  });

  it("moves from checking to ready as model metadata hydrates", () => {
    expect(deriveModelSetupState("openai/gpt-5", [])).toMatchObject({
      kind: "checking",
    });
    expect(deriveModelSetupState("openai/gpt-5", models)).toMatchObject({
      kind: "ready",
    });
  });
});
