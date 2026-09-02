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

  it("uses richer readiness instead of the legacy authenticated boolean", () => {
    expect(
      deriveModelSetupState("openai/gpt-5", [
        {
          ...models[0]!,
          authenticated: true,
          readiness: {
            status: "configuration_required",
            action: {
              kind: "configure_provider",
              providerId: "openai-compatible:custom",
            },
          },
        },
      ]),
    ).toMatchObject({ kind: "configuration_required" });
    expect(
      deriveModelSetupState("openai/gpt-5", [
        {
          ...models[0]!,
          readiness: { status: "unavailable", reason: "Host offline" },
        },
      ]),
    ).toEqual({
      kind: "model_unavailable",
      selectedModelId: "openai/gpt-5",
      reason: "Host offline",
    });
  });
});
