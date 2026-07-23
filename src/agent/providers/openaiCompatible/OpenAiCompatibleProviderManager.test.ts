import type {
  CompleteRequest,
  CompleteResult,
  ModelProvider,
  ProviderStreamEvent,
  StreamRequest,
} from "../types.js";
import { describe, expect, it, vi } from "vitest";

import { OpenAiCompatibleProviderManager } from "./OpenAiCompatibleProviderManager.js";
import { ProviderRegistry } from "../index.js";

const capabilities = {
  supportsThinking: false,
  supportsCaching: false,
  supportsImages: false,
  supportsToolUse: true,
  contextWindow: 10_000,
  maxOutputTokens: 1_000,
};

class BuiltInProvider implements ModelProvider {
  readonly id = "builtin";
  readonly displayName = "Built In";
  readonly condenseModel = "builtin-model";

  async isAuthenticated() {
    return true;
  }
  getCapabilities() {
    return capabilities;
  }
  listModels() {
    return [
      {
        id: "builtin-model",
        displayName: "Built In",
        provider: this.id,
        capabilities,
      },
    ];
  }
  listRoutableModelIds() {
    return ["builtin-hidden-model"];
  }
  // oxlint-disable-next-line require-yield
  async *stream(_request: StreamRequest): AsyncGenerator<ProviderStreamEvent> {
    return;
  }
  async complete(_request: CompleteRequest): Promise<CompleteResult> {
    return { text: "" };
  }
}

function configuredConnection(id = "custom", modelId = "custom-model") {
  return {
    id,
    displayName: "Custom",
    baseUrl: "https://example.invalid/v1",
    profile: "generic",
    authKey: "shared-key",
    models: [
      {
        id: modelId,
        model: "wire-model",
        displayName: "Custom Model",
        contextWindow: 10_000,
        maxOutputTokens: 1_000,
        supportsToolUse: true,
      },
    ],
  };
}

describe("OpenAiCompatibleProviderManager", () => {
  it("atomically installs and removes custom providers while preserving built-ins", () => {
    const registry = new ProviderRegistry();
    const builtIn = new BuiltInProvider();
    let configured: unknown = [configuredConnection()];
    const manager = new OpenAiCompatibleProviderManager({
      registry,
      builtInProviders: [builtIn],
      configuration: { get: <T>() => configured as T },
      secrets: { get: vi.fn() },
    });

    expect(manager.reconcile().applied).toBe(true);
    expect(registry.resolveProvider("custom-model").id).toBe(
      "openai-compatible:custom",
    );
    expect(registry.resolveProvider("builtin-model")).toBe(builtIn);

    configured = [];
    expect(manager.reconcile().applied).toBe(true);
    expect(registry.tryResolveProvider("custom-model")).toBeUndefined();
    expect(registry.resolveProvider("builtin-model")).toBe(builtIn);
  });

  it("validates collisions with hidden routable built-in models", () => {
    const manager = new OpenAiCompatibleProviderManager({
      registry: new ProviderRegistry(),
      builtInProviders: [new BuiltInProvider()],
      configuration: { get: <T>(_section: string, fallback: T) => fallback },
      secrets: { get: vi.fn() },
    });

    expect(
      manager.validateConnections([
        configuredConnection("other", "builtin-hidden-model"),
      ]).issues,
    ).toEqual([expect.objectContaining({ path: "$[0].models[0].id" })]);
  });

  it("retains the last valid provider set when any candidate is invalid", () => {
    const registry = new ProviderRegistry();
    let configured: unknown = [configuredConnection()];
    const manager = new OpenAiCompatibleProviderManager({
      registry,
      builtInProviders: [new BuiltInProvider()],
      configuration: { get: <T>() => configured as T },
      secrets: { get: vi.fn() },
    });
    manager.reconcile();

    configured = [configuredConnection("other", "builtin-model")];
    const result = manager.reconcile();

    expect(result.applied).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ path: "$[0].models[0].id" }),
    ]);
    expect(registry.resolveProvider("custom-model").id).toBe(
      "openai-compatible:custom",
    );
    expect(registry.tryResolveProvider("other")).toBeUndefined();
  });

  it("exposes only non-secret auth bindings and private runtime profiles", () => {
    const registry = new ProviderRegistry();
    const manager = new OpenAiCompatibleProviderManager({
      registry,
      builtInProviders: [new BuiltInProvider()],
      configuration: { get: <T>() => [configuredConnection()] as T },
      secrets: { get: vi.fn() },
    });
    manager.reconcile();

    expect(manager.listConfiguredAuthKeys()).toEqual(["shared-key"]);
    expect(manager.getAuthKey("openai-compatible:custom")).toBe("shared-key");
    expect(manager.getRuntimeProfiles()).toEqual({
      "openai-compatible:custom": expect.objectContaining({
        providerId: "openai-compatible:custom",
        authRequired: true,
        models: {
          "custom-model": expect.objectContaining({ model: "wire-model" }),
        },
      }),
    });
    expect(JSON.stringify(manager.getRuntimeProfiles())).not.toContain(
      "shared-key",
    );
  });
});
