import { describe, expect, expectTypeOf, it } from "vitest";

import {
  deriveModelSetupState,
  type ModelSetupModel,
  type ModelSetupState,
} from "./modelSetup.js";

const models: ModelSetupModel[] = [
  {
    id: "openai/gpt-5",
    displayName: "GPT-5",
    provider: "codex",
    authenticated: true,
  },
  {
    id: "anthropic/claude-sonnet",
    displayName: "Claude Sonnet",
    provider: "anthropic",
    authenticated: false,
  },
];

describe("model setup projection", () => {
  it("keeps the setup state serializable", () => {
    expectTypeOf<ModelSetupState>().toMatchTypeOf<
      | { kind: "checking"; selectedModelId: string }
      | { kind: "ready"; model: ModelSetupModel }
      | { kind: "credentials_required"; model: ModelSetupModel }
      | { kind: "model_unavailable"; selectedModelId: string }
    >();
  });

  it("derives hydration, readiness, and credential states", () => {
    expect(deriveModelSetupState(undefined, models)).toEqual({
      kind: "checking",
      selectedModelId: "",
    });
    expect(deriveModelSetupState("openai/gpt-5", models)).toEqual({
      kind: "ready",
      model: models[0],
    });
    expect(deriveModelSetupState("anthropic/claude-sonnet", models)).toEqual({
      kind: "credentials_required",
      model: models[1],
    });
    expect(deriveModelSetupState("retired/model", models)).toEqual({
      kind: "model_unavailable",
      selectedModelId: "retired/model",
    });
  });
});
