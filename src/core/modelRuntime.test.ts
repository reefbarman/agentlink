import { describe, expect, it, vi } from "vitest";

import type { CoreModelCatalogEntry } from "./modelCatalog.js";
import {
  collectCoreModelCompleteResult,
  CoreModelBackendRegistry,
  DefaultCoreModelRuntime,
  type CoreModelBackend,
  type CoreModelCapabilities,
  type CoreModelCompleteRequest,
  type CoreModelCompleteResult,
  type CoreModelProviderAuthStatus,
  type CoreModelStreamEvent,
  type CoreModelStreamRequest,
} from "./modelRuntime.js";

const CAPS: CoreModelCapabilities = {
  supportsThinking: false,
  supportsCaching: true,
  supportsImages: true,
  supportsToolUse: true,
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
};

async function* streamEvents(
  events: CoreModelStreamEvent[],
): AsyncGenerator<CoreModelStreamEvent> {
  yield* events;
}

class FakeBackend implements CoreModelBackend {
  readonly displayName: string;
  readonly condenseModel: string;

  visible: string[];
  routable: string[];
  authStatus: CoreModelProviderAuthStatus = {
    authenticated: true,
    authSource: "host",
  };
  streamRequests: CoreModelStreamRequest[] = [];
  completeRequests: CoreModelCompleteRequest[] = [];

  constructor(
    readonly providerId: string,
    visible: string[],
    routable = visible,
  ) {
    this.displayName = providerId;
    this.condenseModel = visible[0] ?? `${providerId}-condense`;
    this.visible = visible;
    this.routable = routable;
  }

  listModels(): CoreModelCatalogEntry[] {
    return this.visible.map((id) => ({
      id,
      displayName: id,
      providerId: this.providerId,
      contextWindow: CAPS.contextWindow,
      maxOutputTokens: CAPS.maxOutputTokens,
      authenticated: this.authStatus.authenticated,
    }));
  }

  listRoutableModelIds(): string[] {
    return this.routable;
  }

  getCapabilities(): CoreModelCapabilities {
    return CAPS;
  }

  async getAuthStatus(): Promise<CoreModelProviderAuthStatus> {
    return this.authStatus;
  }

  async *stream(
    request: CoreModelStreamRequest,
  ): AsyncGenerator<CoreModelStreamEvent> {
    this.streamRequests.push(request);
    yield { type: "text_delta", text: `stream:${request.model}` };
    yield { type: "done" };
  }

  async complete(
    request: CoreModelCompleteRequest,
  ): Promise<CoreModelCompleteResult> {
    this.completeRequests.push(request);
    return { text: `complete:${request.model}` };
  }
}

describe("collectCoreModelCompleteResult", () => {
  it("collects text deltas and latest usage into a complete result", async () => {
    await expect(
      collectCoreModelCompleteResult(
        streamEvents([
          { type: "text_delta", text: "hello " },
          { type: "text_delta", text: "world" },
          {
            type: "usage",
            inputTokens: 1,
            outputTokens: 2,
            cacheReadTokens: 3,
            cacheCreationTokens: 4,
            providerResponseId: "resp_1",
          },
          {
            type: "usage",
            inputTokens: 5,
            outputTokens: 6,
            providerResponseId: "resp_2",
          },
          { type: "done" },
        ]),
      ),
    ).resolves.toEqual({
      text: "hello world",
      usage: {
        inputTokens: 5,
        outputTokens: 6,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      providerResponseId: "resp_2",
    });
  });

  it("returns empty text and zero usage when no text or usage events are emitted", async () => {
    await expect(
      collectCoreModelCompleteResult(streamEvents([{ type: "done" }])),
    ).resolves.toEqual({
      text: "",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      providerResponseId: undefined,
    });
  });
});

describe("CoreModelBackendRegistry", () => {
  it("routes visible models and keeps hidden routing-floor IDs resolvable", () => {
    const registry = new CoreModelBackendRegistry();
    const backend = new FakeBackend("fake", ["fake-a"]);
    registry.register(backend);

    expect(registry.resolveModel("fake-a").providerId).toBe("fake");

    backend.visible = ["fake-b"];
    backend.routable = ["fake-b", "fake-a"];
    registry.refreshIndex();

    expect(registry.resolveModel("fake-b").providerId).toBe("fake");
    expect(registry.resolveModel("fake-a").providerId).toBe("fake");
    expect(registry.listModels().map((model) => model.id)).toEqual(["fake-b"]);
  });

  it("returns undefined for unknown model lookups", () => {
    const registry = new CoreModelBackendRegistry();
    registry.register(new FakeBackend("fake", ["fake-a"]));

    expect(registry.tryResolveModel("missing-model")).toBeUndefined();
    expect(registry.getCapabilities("missing-model")).toBeUndefined();
  });

  it("throws an unknown-model error with available model IDs", () => {
    const registry = new CoreModelBackendRegistry();
    registry.register(new FakeBackend("fake", ["fake-a", "fake-b"]));

    expect(() => registry.resolveModel("missing-model")).toThrow(
      'Unknown model "missing-model". Available models: fake-a, fake-b',
    );
  });

  it("rejects duplicate provider IDs", () => {
    const registry = new CoreModelBackendRegistry();
    registry.register(new FakeBackend("fake", ["fake-a"]));

    expect(() =>
      registry.register(new FakeBackend("fake", ["fake-b"])),
    ).toThrow('Duplicate model provider "fake"');
  });

  it("rejects duplicate visible model IDs across providers", () => {
    const registry = new CoreModelBackendRegistry();
    registry.register(new FakeBackend("fake-a", ["shared-model"]));

    expect(() =>
      registry.register(new FakeBackend("fake-b", ["shared-model"])),
    ).toThrow(
      'Duplicate model "shared-model" registered by providers "fake-a" and "fake-b"',
    );
  });

  it("aggregates catalog snapshots with owner and timestamp metadata", async () => {
    const registry = new CoreModelBackendRegistry();
    registry.register(new FakeBackend("a", ["a-1"]));
    registry.register(new FakeBackend("b", ["b-1", "b-2"]));

    await expect(
      registry.listCatalog({ ownerId: "owner-1", now: 123 }),
    ).resolves.toEqual({
      models: [
        expect.objectContaining({ id: "a-1", providerId: "a" }),
        expect.objectContaining({ id: "b-1", providerId: "b" }),
        expect.objectContaining({ id: "b-2", providerId: "b" }),
      ],
      publishedByOwnerId: "owner-1",
      publishedAt: 123,
    });
  });

  it("aggregates backend auth status", async () => {
    const registry = new CoreModelBackendRegistry();
    const ready = new FakeBackend("ready", ["ready-1"]);
    const missing = new FakeBackend("missing", ["missing-1"]);
    missing.authStatus = {
      authenticated: false,
      authSource: "unavailable",
      unavailableReason: "missing_credentials",
    };
    registry.register(ready);
    registry.register(missing);

    await expect(registry.getAuthStatus()).resolves.toEqual({
      ready: { authenticated: true, authSource: "host" },
      missing: {
        authenticated: false,
        authSource: "unavailable",
        unavailableReason: "missing_credentials",
      },
    });
  });

  it("infers auth status from catalog entries when a backend has no explicit status method", async () => {
    const registry = new CoreModelBackendRegistry();
    const backend: CoreModelBackend = {
      providerId: "catalog-only",
      displayName: "Catalog Only",
      condenseModel: "catalog-a",
      listModels: () => [
        {
          id: "catalog-a",
          displayName: "Catalog A",
          providerId: "catalog-only",
          contextWindow: 100,
          maxOutputTokens: 10,
          authenticated: false,
        },
      ],
      getCapabilities: () => CAPS,
      stream: async function* () {
        yield { type: "done" };
      },
      complete: async () => ({ text: "" }),
    };
    registry.register(backend);

    await expect(registry.getAuthStatus()).resolves.toEqual({
      "catalog-only": { authenticated: false, authSource: "unavailable" },
    });
  });
});

describe("DefaultCoreModelRuntime", () => {
  it("uses runtime owner/time defaults for catalog snapshots", async () => {
    const registry = new CoreModelBackendRegistry();
    registry.register(new FakeBackend("fake", ["fake-a"]));
    const runtime = new DefaultCoreModelRuntime(registry, {
      ownerId: "runtime-owner",
      now: () => 456,
    });

    await expect(runtime.listCatalog()).resolves.toMatchObject({
      publishedByOwnerId: "runtime-owner",
      publishedAt: 456,
    });
  });

  it("throws unknown-model errors from stream and complete calls", async () => {
    const registry = new CoreModelBackendRegistry();
    registry.register(new FakeBackend("fake", ["fake-a"]));
    const runtime = new DefaultCoreModelRuntime(registry, {
      ownerId: "runtime-owner",
    });

    expect(() =>
      runtime.stream({
        model: "missing-model",
        systemPrompt: "system",
        messages: [],
        maxTokens: 10,
      }),
    ).toThrow('Unknown model "missing-model". Available models: fake-a');
    await expect(
      runtime.complete({
        model: "missing-model",
        systemPrompt: "system",
        messages: [],
        maxTokens: 10,
      }),
    ).rejects.toThrow(
      'Unknown model "missing-model". Available models: fake-a',
    );
  });

  it("delegates stream and complete requests to the resolved backend", async () => {
    const registry = new CoreModelBackendRegistry();
    const backend = new FakeBackend("fake", ["fake-a"]);
    registry.register(backend);
    const runtime = new DefaultCoreModelRuntime(registry, {
      ownerId: "runtime-owner",
    });

    const streamEvents: CoreModelStreamEvent[] = [];
    for await (const event of runtime.stream({
      model: "fake-a",
      systemPrompt: "system",
      messages: [],
      maxTokens: 10,
    })) {
      streamEvents.push(event);
    }
    const completeResult = await runtime.complete({
      model: "fake-a",
      systemPrompt: "system",
      messages: [],
      maxTokens: 10,
    });

    expect(streamEvents).toEqual([
      { type: "text_delta", text: "stream:fake-a" },
      { type: "done" },
    ]);
    expect(completeResult).toEqual({ text: "complete:fake-a" });
    expect(backend.streamRequests).toHaveLength(1);
    expect(backend.completeRequests).toHaveLength(1);
  });

  it("refreshes the routing index before returning the refreshed catalog", async () => {
    const registry = new CoreModelBackendRegistry();
    const backend = new FakeBackend("fake", ["fake-a"]);
    registry.register(backend);
    const refreshIndex = vi.spyOn(registry, "refreshIndex");
    const runtime = new DefaultCoreModelRuntime(registry, {
      ownerId: "runtime-owner",
      now: () => 789,
    });

    backend.visible = ["fake-b"];
    backend.routable = ["fake-b", "fake-a"];
    await expect(runtime.refreshCatalog()).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "fake-b" })],
      publishedAt: 789,
    });

    expect(refreshIndex).toHaveBeenCalledOnce();
    expect(runtime.resolveModel("fake-a").providerId).toBe("fake");
  });
});
