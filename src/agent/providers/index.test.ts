import type {
  CompleteRequest,
  CompleteResult,
  ModelCapabilities,
  ModelInfo,
  ModelProvider,
  ProviderStreamEvent,
  StreamRequest,
} from "./types.js";
import { describe, expect, it } from "vitest";

import { ProviderRegistry } from "./index.js";

const CAPS: ModelCapabilities = {
  supportsThinking: false,
  supportsCaching: true,
  supportsImages: true,
  supportsToolUse: true,
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
};

/** A minimal fake provider whose model set + routing floor can be mutated. */
class FakeProvider implements ModelProvider {
  readonly id: string = "fake";
  readonly displayName = "Fake";
  readonly condenseModel = "fake-a";

  visible: string[] = ["fake-a"];
  routable: string[] = ["fake-a"];
  migrations: Record<string, string> = {};

  async isAuthenticated(): Promise<boolean> {
    return true;
  }

  getCapabilities(): ModelCapabilities {
    return CAPS;
  }

  listModels(): ModelInfo[] {
    return this.visible.map((id) => ({
      id,
      displayName: id,
      provider: this.id,
      capabilities: CAPS,
    }));
  }

  listRoutableModelIds(): string[] {
    return this.routable;
  }

  getModelMigration(model: string): string | undefined {
    return this.migrations[model];
  }

  // oxlint-disable-next-line require-yield
  async *stream(_request: StreamRequest): AsyncGenerator<ProviderStreamEvent> {
    return;
  }

  async complete(_request: CompleteRequest): Promise<CompleteResult> {
    return { text: "" };
  }
}

describe("ProviderRegistry.refreshIndex", () => {
  it("routes newly added models and keeps routing-floor IDs resolvable", () => {
    const registry = new ProviderRegistry();
    const provider = new FakeProvider();
    registry.register(provider);

    expect(registry.resolveProvider("fake-a").id).toBe("fake");

    // Dynamic refresh: a new model appears, the old one is hidden from the
    // picker but kept in the routing floor.
    provider.visible = ["fake-b"];
    provider.routable = ["fake-b", "fake-a"];
    registry.refreshIndex();

    // New model routes.
    expect(registry.resolveProvider("fake-b").id).toBe("fake");
    // Hidden-but-routable model still resolves.
    expect(registry.resolveProvider("fake-a").id).toBe("fake");
    // Picker list reflects only the visible set.
    expect(registry.listAllModels().map((m) => m.id)).toEqual(["fake-b"]);
  });

  it("migrates retired ids without returning them in the picker model list", () => {
    const registry = new ProviderRegistry();
    const provider = new FakeProvider();
    provider.visible = ["fake-current"];
    provider.routable = ["fake-current"];
    provider.migrations = {
      "fake-retired": "fake-intermediate",
      "fake-intermediate": "fake-current",
    };
    registry.register(provider);

    expect(registry.listAllModels().map(({ id }) => id)).toEqual([
      "fake-current",
    ]);
    expect(registry.tryResolveProvider("fake-retired")).toBeUndefined();
    expect(registry.resolveAvailableModel("fake-retired")).toEqual({
      model: "fake-current",
      provider,
      migratedFrom: "fake-retired",
    });
  });

  it("rejects duplicate providers and models without mutating the valid registry", () => {
    const registry = new ProviderRegistry();
    const first = new FakeProvider();
    registry.register(first);

    const duplicateProvider = new FakeProvider();
    expect(() => registry.register(duplicateProvider)).toThrow(
      'Duplicate model provider "fake"',
    );
    expect(registry.resolveProvider("fake-a")).toBe(first);

    const colliding = new FakeProvider();
    Object.defineProperty(colliding, "id", { value: "other" });
    expect(() => registry.register(colliding)).toThrow(
      /Duplicate model "fake-a" registered by providers "fake" and "other"/,
    );
    expect(registry.listProviders()).toEqual([first]);
    expect(registry.resolveProvider("fake-a")).toBe(first);
  });

  it("atomically reconciles provider additions and removals", () => {
    const registry = new ProviderRegistry();
    const first = new FakeProvider();
    const second = new FakeProvider();
    Object.defineProperty(second, "id", { value: "second" });
    second.visible = ["second-a"];
    second.routable = ["second-a"];
    registry.register(first);

    registry.reconcile([second]);

    expect(registry.tryResolveProvider("fake-a")).toBeUndefined();
    expect(registry.resolveProvider("second-a")).toBe(second);
    expect(registry.getProvider("fake")).toBeUndefined();
  });

  it("rejects cyclic or cross-provider migration targets", () => {
    const registry = new ProviderRegistry();
    const provider = new FakeProvider();
    provider.migrations = {
      "fake-cycle-a": "fake-cycle-b",
      "fake-cycle-b": "fake-cycle-a",
      "fake-cross": "other-current",
      "fake-cross-chain": "other-retired",
    };
    registry.register(provider);

    const other = new FakeProvider();
    Object.defineProperty(other, "id", { value: "other" });
    other.visible = ["other-current"];
    other.routable = ["other-current"];
    other.migrations = { "other-retired": "other-current" };
    registry.register(other);

    expect(registry.resolveAvailableModel("fake-cycle-a")).toBeUndefined();
    expect(registry.resolveAvailableModel("fake-cross")).toBeUndefined();
    expect(registry.resolveAvailableModel("fake-cross-chain")).toBeUndefined();
  });
});
