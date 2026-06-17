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
  readonly id = "fake";
  readonly displayName = "Fake";
  readonly condenseModel = "fake-a";

  visible: string[] = ["fake-a"];
  routable: string[] = ["fake-a"];

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

  // eslint-disable-next-line require-yield
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
});
