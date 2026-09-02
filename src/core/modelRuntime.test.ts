import { describe, expect, it, vi } from "vitest";

import type { CoreModelCatalogEntry } from "@agentlink/protocol/model-catalog";
import type { AgentPrincipal } from "@agentlink/core/turn-contracts";
import {
  collectCoreModelCompleteResult,
  CoreModelBackendRegistry,
  DefaultCoreModelRuntime,
  type CoreModelBackend,
  type CoreModelCapabilities,
  type CoreModelCompleteRequest,
  type CoreModelCompleteResult,
  type CoreModelProviderAuthStatus,
  type CoreModelRequestContext,
  type CoreModelStreamEvent,
  type CoreModelStreamRequest,
} from "@agentlink/core/model-runtime";

const PRINCIPAL: AgentPrincipal = {
  tenantId: "tenant-a",
  subjectId: "subject-a",
};
const REQUEST_CONTEXT: CoreModelRequestContext = {
  principal: PRINCIPAL,
  authContext: undefined,
};

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
  contexts: CoreModelRequestContext[] = [];

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

  async getAuthStatus(
    context: CoreModelRequestContext,
  ): Promise<CoreModelProviderAuthStatus> {
    this.contexts.push(context);
    return this.authStatus;
  }

  async *stream(
    request: CoreModelStreamRequest,
    context: CoreModelRequestContext,
  ): AsyncGenerator<CoreModelStreamEvent> {
    this.streamRequests.push(request);
    this.contexts.push(context);
    yield { type: "text_delta", text: `stream:${request.model}` };
    yield { type: "done" };
  }

  async complete(
    request: CoreModelCompleteRequest,
    context: CoreModelRequestContext,
  ): Promise<CoreModelCompleteResult> {
    this.completeRequests.push(request);
    this.contexts.push(context);
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
            inputTokenBreakdownReported: true,
            providerResponseId: "resp_1",
          },
          {
            type: "usage",
            inputTokens: 5,
            outputTokens: 6,
            inputTokenBreakdownReported: false,
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
        inputTokenBreakdownReported: false,
      },
      providerResponseId: "resp_2",
    });
  });

  it("collects server-tool usage and the final assistant continuation message", async () => {
    const assistantMessage = {
      role: "assistant" as const,
      content: [
        {
          type: "web_activity" as const,
          activity: {
            id: "web-1",
            kind: "search" as const,
            status: "completed" as const,
            backend: "provider" as const,
            query: "current docs",
          },
        },
        {
          type: "text" as const,
          text: "Current answer",
          citations: [{ url: "https://example.com", title: "Example" }],
        },
      ],
    };

    await expect(
      collectCoreModelCompleteResult(
        streamEvents([
          { type: "text_delta", text: "Current answer" },
          {
            type: "usage",
            inputTokens: 10,
            outputTokens: 5,
            serverToolUsage: { webSearchRequests: 2 },
          },
          {
            type: "model_stop",
            reason: "pause_turn",
            assistantMessage,
          },
          { type: "done" },
        ]),
      ),
    ).resolves.toEqual({
      text: "Current answer",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        serverToolUsage: { webSearchRequests: 2 },
      },
      providerResponseId: undefined,
      assistantMessage,
      stopReason: "pause_turn",
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
      'Unknown model "missing-model". Available models: fake/fake-a, fake/fake-b',
    );
  });

  it("rejects duplicate provider IDs", () => {
    const registry = new CoreModelBackendRegistry();
    registry.register(new FakeBackend("fake", ["fake-a"]));

    expect(() =>
      registry.register(new FakeBackend("fake", ["fake-b"])),
    ).toThrow('Duplicate model provider "fake"');
  });

  it("allows qualified duplicate model IDs and rejects ambiguous legacy lookup", () => {
    const registry = new CoreModelBackendRegistry();
    const first = new FakeBackend("fake-a", ["shared-model"]);
    const second = new FakeBackend("fake-b", ["shared-model"]);
    const third = new FakeBackend("fake-c", ["shared-model"]);
    registry.register(first);
    registry.register(second);
    registry.register(third);

    expect(
      registry.resolveModel({
        providerId: "fake-a",
        modelId: "shared-model",
      }).provider,
    ).toBe(first);
    expect(
      registry.resolveModel({
        providerId: "fake-b",
        modelId: "shared-model",
      }).provider,
    ).toBe(second);
    expect(() => registry.resolveModel("shared-model")).toThrow(
      'Ambiguous legacy model "shared-model". Use a provider-qualified model reference.',
    );
    expect(registry.tryResolveModel("shared-model")).toBeUndefined();
    expect(
      registry.resolveModel({
        providerId: "fake-c",
        modelId: "shared-model",
      }).provider,
    ).toBe(third);
  });

  it("aggregates catalog snapshots with owner and timestamp metadata", async () => {
    const registry = new CoreModelBackendRegistry();
    registry.register(new FakeBackend("a", ["a-1"]));
    registry.register(new FakeBackend("b", ["b-1", "b-2"]));

    await expect(
      registry.listCatalog({
        ...REQUEST_CONTEXT,
        ownerId: "owner-1",
        now: 123,
      }),
    ).resolves.toEqual({
      models: [
        expect.objectContaining({
          id: "a-1",
          providerId: "a",
          ref: { providerId: "a", modelId: "a-1" },
        }),
        expect.objectContaining({
          id: "b-1",
          providerId: "b",
          ref: { providerId: "b", modelId: "b-1" },
        }),
        expect.objectContaining({
          id: "b-2",
          providerId: "b",
          ref: { providerId: "b", modelId: "b-2" },
        }),
      ],
      publishedByOwnerId: "owner-1",
      publishedAt: 123,
    });
  });

  it("keeps unique legacy IDs resolvable after another provider registers", () => {
    const registry = new CoreModelBackendRegistry();
    const first = new FakeBackend("first", ["first-model"]);
    registry.register(first);
    registry.register(new FakeBackend("second", ["second-model"]));

    expect(registry.resolveModel("first-model").provider).toBe(first);
    expect(registry.listModels()).toHaveLength(2);
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

    await expect(registry.getAuthStatus(REQUEST_CONTEXT)).resolves.toEqual({
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

    await expect(registry.getAuthStatus(REQUEST_CONTEXT)).resolves.toEqual({
      "catalog-only": {
        authenticated: false,
        authSource: "unavailable",
        unavailableReason:
          "Provider does not expose request-scoped auth status",
      },
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

    await expect(runtime.listCatalog(REQUEST_CONTEXT)).resolves.toMatchObject({
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

    const stream = runtime.stream({
      ...REQUEST_CONTEXT,
      model: "missing-model",
      request: {
        systemPrompt: "system",
        messages: [],
        maxTokens: 10,
      },
    });
    await expect(stream.next()).rejects.toThrow(
      'Unknown model "missing-model". Available models: fake/fake-a',
    );
    await expect(
      runtime.complete({
        ...REQUEST_CONTEXT,
        model: "missing-model",
        request: {
          systemPrompt: "system",
          messages: [],
          maxTokens: 10,
        },
      }),
    ).rejects.toThrow(
      'Unknown model "missing-model". Available models: fake/fake-a',
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
      ...REQUEST_CONTEXT,
      model: { providerId: "fake", modelId: "fake-a" },
      request: {
        systemPrompt: "system",
        messages: [],
        maxTokens: 10,
      },
    })) {
      streamEvents.push(event);
    }
    const completeResult = await runtime.complete({
      ...REQUEST_CONTEXT,
      model: "fake-a",
      request: {
        systemPrompt: "system",
        messages: [],
        maxTokens: 10,
      },
    });

    expect(streamEvents).toEqual([
      { type: "text_delta", text: "stream:fake-a" },
      { type: "done" },
    ]);
    expect(completeResult).toEqual({ text: "complete:fake-a" });
    expect(backend.streamRequests).toHaveLength(1);
    expect(backend.completeRequests).toHaveLength(1);
    expect(backend.contexts).toEqual([REQUEST_CONTEXT, REQUEST_CONTEXT]);
  });

  it("refreshes the routing index before returning the refreshed catalog", async () => {
    const registry = new CoreModelBackendRegistry();
    const backend = new FakeBackend("fake", ["fake-a"]);
    registry.register(backend);
    const refreshCatalog = vi.spyOn(registry, "refreshCatalog");
    const runtime = new DefaultCoreModelRuntime(registry, {
      ownerId: "runtime-owner",
      now: () => 789,
    });

    backend.visible = ["fake-b"];
    backend.routable = ["fake-b", "fake-a"];
    await expect(
      runtime.refreshCatalog(REQUEST_CONTEXT),
    ).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "fake-b" })],
      publishedAt: 789,
    });

    expect(refreshCatalog).toHaveBeenCalledOnce();
    expect(
      runtime.resolveModel({
        principal: PRINCIPAL,
        authContext: undefined,
        model: "fake-a",
      }).providerId,
    ).toBe("fake");
  });
});
