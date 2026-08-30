import {
  deriveModelSetupState,
  type ModelSetupModel,
  type ModelSetupState,
} from "./modelSetup.js";
import { describe, expect, expectTypeOf, it } from "vitest";

const models: ModelSetupModel[] = [
  {
    id: "openai/gpt-5",
    displayName: "GPT-5",
    provider: "codex",
    authenticated: true,
  },
];

describe("model setup protocol compatibility shim", () => {
  it("preserves the legacy runtime and type contracts", () => {
    expectTypeOf<ModelSetupState>().toHaveProperty("kind");
    expect(deriveModelSetupState("openai/gpt-5", models)).toEqual({
      kind: "ready",
      model: models[0],
    });
  });
});
