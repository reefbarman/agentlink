import type { CoreModelCatalogEntry } from "@agentlink/protocol/model-catalog";
import type { AgentPrincipal } from "./turnContracts.js";
import {
  CoreModelBackendRegistry,
  DefaultCoreModelRuntime,
  type CoreModelBackend,
  type CoreModelCapabilities,
  type CoreModelCompleteRequest,
  type CoreModelProviderAuthStatus,
  type CoreModelRequestContext,
  type CoreModelStreamEvent,
  type CoreModelStreamRequest,
} from "./modelRuntime.js";
import { describe, expect, it, vi } from "vitest";

const CAPS: CoreModelCapabilities = {
  supportsThinking: false,
  supportsCaching: false,
  supportsImages: false,
  supportsToolUse: true,
  contextWindow: 32_768,
  maxOutputTokens: 4_096,
};
const principalA: AgentPrincipal = {
  tenantId: "tenant-a",
  subjectId: "subject-a",
};
const principalB: AgentPrincipal = {
  tenantId: "tenant-b",
  subjectId: "subject-b",
};

class ScopedBackend implements CoreModelBackend {
  readonly displayName: string;
  readonly condenseModel: string;
  readonly contexts: CoreModelRequestContext[] = [];
  readonly streamRequests: CoreModelStreamRequest[] = [];
  readonly completeRequests: CoreModelCompleteRequest[] = [];

  constructor(
    readonly providerId: string,
    private readonly modelIds: string[],
  ) {
    this.displayName = providerId;
    this.condenseModel = modelIds[0]!;
  }

  listModels(): CoreModelCatalogEntry[] {
    return this.modelIds.map((id) => ({
      id,
      displayName: id,
      providerId: this.providerId,
      contextWindow: CAPS.contextWindow,
      maxOutputTokens: CAPS.maxOutputTokens,
      authenticated: true,
    }));
  }

  async listAvailableModels(
    request: CoreModelRequestContext,
  ): Promise<CoreModelCatalogEntry[]> {
    this.contexts.push(request);
    return this.listModels();
  }

  getCapabilities(): CoreModelCapabilities {
    return CAPS;
  }

  async getAuthStatus(
    request: CoreModelRequestContext,
  ): Promise<CoreModelProviderAuthStatus> {
    this.contexts.push(request);
    return request.principal.tenantId === "tenant-a"
      ? { authenticated: true, authSource: "host" }
      : {
          authenticated: false,
          authSource: "unavailable",
          unavailableReason: "principal_has_no_credential",
        };
  }

  async *stream(
    request: CoreModelStreamRequest,
    context: CoreModelRequestContext,
  ): AsyncGenerator<CoreModelStreamEvent> {
    this.streamRequests.push(request);
    this.contexts.push(context);
    yield { type: "done" };
  }

  async complete(
    request: CoreModelCompleteRequest,
    context: CoreModelRequestContext,
  ) {
    this.completeRequests.push(request);
    this.contexts.push(context);
    return { text: `${context.principal.tenantId}:${request.model}` };
  }
}

function modelRequest() {
  return {
    systemPrompt: "system",
    messages: [],
    maxTokens: 128,
  };
}

describe("request-scoped model runtime", () => {
  it("routes duplicate bare IDs by qualified reference and fails legacy ambiguity", () => {
    const registry = new CoreModelBackendRegistry();
    const first = new ScopedBackend("first", ["shared"]);
    const second = new ScopedBackend("second", ["shared"]);
    const third = new ScopedBackend("third", ["shared"]);
    registry.register(first);
    registry.register(second);
    registry.register(third);

    expect(
      registry.resolveModel({ providerId: "second", modelId: "shared" })
        .provider,
    ).toBe(second);
    expect(() => registry.resolveModel("shared")).toThrow(
      'Ambiguous legacy model "shared". Use a provider-qualified model reference.',
    );
  });

  it("publishes qualified catalog refs and rebuilds routing from available models", async () => {
    const registry = new CoreModelBackendRegistry();
    const backend = new ScopedBackend("provider", ["model-a"]);
    registry.register(backend);
    const runtime = new DefaultCoreModelRuntime(registry, {
      ownerId: "owner",
      now: () => 123,
    });

    await expect(
      runtime.refreshCatalog({ principal: principalA, authContext: undefined }),
    ).resolves.toMatchObject({
      publishedByOwnerId: "owner",
      publishedAt: 123,
      models: [
        expect.objectContaining({
          ref: { providerId: "provider", modelId: "model-a" },
        }),
      ],
    });
    expect(backend.contexts).toEqual([
      { principal: principalA, authContext: undefined },
      { principal: principalA, authContext: undefined },
    ]);
  });

  it("projects provider auth readiness independently for each principal", async () => {
    const registry = new CoreModelBackendRegistry();
    const backend = new ScopedBackend("provider", ["model-a"]);
    registry.register(backend);
    const runtime = new DefaultCoreModelRuntime(registry, { ownerId: "owner" });

    const ready = await runtime.listCatalog({
      principal: principalA,
      authContext: undefined,
    });
    const blocked = await runtime.listCatalog({
      principal: principalB,
      authContext: undefined,
    });

    expect(ready.models[0]).toMatchObject({
      authenticated: true,
      readiness: { status: "ready" },
    });
    expect(blocked.models[0]).toMatchObject({
      authenticated: false,
      readiness: {
        status: "unavailable",
        reason: "principal_has_no_credential",
      },
    });
  });

  it("preserves a backend's more specific per-model readiness descriptor", async () => {
    class ConfigurableBackend extends ScopedBackend {
      override listModels(): CoreModelCatalogEntry[] {
        return [
          {
            ...super.listModels()[0]!,
            readiness: {
              status: "configuration_required",
              action: {
                kind: "configure_provider",
                providerId: this.providerId,
              },
            },
          },
        ];
      }
    }
    const registry = new CoreModelBackendRegistry();
    registry.register(new ConfigurableBackend("provider", ["model-a"]));
    const runtime = new DefaultCoreModelRuntime(registry, { ownerId: "owner" });

    await expect(
      runtime.listCatalog({ principal: principalA, authContext: undefined }),
    ).resolves.toMatchObject({
      models: [
        {
          authenticated: false,
          readiness: {
            status: "configuration_required",
            action: {
              kind: "configure_provider",
              providerId: "provider",
            },
          },
        },
      ],
    });
  });

  it("keeps auth, stream, and complete scope isolated per operation", async () => {
    const registry = new CoreModelBackendRegistry();
    const backend = new ScopedBackend("provider", ["model-a"]);
    registry.register(backend);
    const runtime = new DefaultCoreModelRuntime(registry, { ownerId: "owner" });

    await expect(
      runtime.getAuthStatus({ principal: principalA, authContext: undefined }),
    ).resolves.toEqual({
      provider: { authenticated: true, authSource: "host" },
    });
    await expect(
      runtime.getAuthStatus({ principal: principalB, authContext: undefined }),
    ).resolves.toEqual({
      provider: {
        authenticated: false,
        authSource: "unavailable",
        unavailableReason: "principal_has_no_credential",
      },
    });

    for await (const _event of runtime.stream({
      principal: principalA,
      authContext: undefined,
      model: { providerId: "provider", modelId: "model-a" },
      request: modelRequest(),
    })) {
      // Consume the stream to prove context reaches the backend.
    }
    await expect(
      runtime.complete({
        principal: principalB,
        authContext: undefined,
        model: "model-a",
        request: modelRequest(),
      }),
    ).resolves.toEqual({ text: "tenant-b:model-a" });

    expect(backend.contexts.slice(-2)).toEqual([
      { principal: principalA, authContext: undefined },
      { principal: principalB, authContext: undefined },
    ]);
  });

  it("keeps refreshed routing isolated between principals", async () => {
    class PrincipalCatalogBackend extends ScopedBackend {
      override async listAvailableModels(
        request: CoreModelRequestContext,
      ): Promise<CoreModelCatalogEntry[]> {
        this.contexts.push(request);
        const id =
          request.principal.tenantId === "tenant-a" ? "model-a" : "model-b";
        return [
          {
            id,
            displayName: id,
            providerId: this.providerId,
            contextWindow: CAPS.contextWindow,
            maxOutputTokens: CAPS.maxOutputTokens,
            authenticated: true,
          },
        ];
      }
    }
    const registry = new CoreModelBackendRegistry();
    registry.register(new PrincipalCatalogBackend("provider", ["base-model"]));
    const runtime = new DefaultCoreModelRuntime(registry, { ownerId: "owner" });

    await runtime.refreshCatalog({
      principal: principalA,
      authContext: undefined,
    });
    await runtime.refreshCatalog({
      principal: principalB,
      authContext: undefined,
    });

    expect(
      runtime.resolveModel({
        principal: principalA,
        authContext: undefined,
        model: "model-a",
      }).modelId,
    ).toBe("model-a");
    expect(
      runtime.resolveModel({
        principal: principalB,
        authContext: undefined,
        model: "model-b",
      }).modelId,
    ).toBe("model-b");
    expect(
      runtime.tryResolveModel({
        principal: principalA,
        authContext: undefined,
        model: "model-b",
      }),
    ).toBeUndefined();
    expect(
      runtime.tryResolveModel({
        principal: principalB,
        authContext: undefined,
        model: "model-a",
      }),
    ).toBeUndefined();
    expect(
      runtime.resolveModel({
        principal: principalA,
        authContext: undefined,
        model: "base-model",
      }).modelId,
    ).toBe("base-model");
  });

  it("rejects foreign provider catalog declarations", async () => {
    class ForeignCatalogBackend extends ScopedBackend {
      override listModels(): CoreModelCatalogEntry[] {
        return [
          {
            id: "model-a",
            displayName: "Model A",
            providerId: "other-provider",
            contextWindow: CAPS.contextWindow,
            maxOutputTokens: CAPS.maxOutputTokens,
            authenticated: true,
          },
        ];
      }
    }
    const registry = new CoreModelBackendRegistry();
    const existing = new ScopedBackend("existing", ["existing-model"]);
    registry.register(existing);
    expect(() =>
      registry.register(new ForeignCatalogBackend("provider", ["model-a"])),
    ).toThrow(
      'Model "model-a" declared provider "other-provider" but was returned by "provider"',
    );
    expect(registry.resolveModel("existing-model").provider).toBe(existing);
    expect(registry.listModels()).toHaveLength(1);
  });

  it("returns undefined when indexed capabilities cannot be resolved", () => {
    class MissingCapabilitiesBackend extends ScopedBackend {
      override getCapabilities(): CoreModelCapabilities {
        throw new Error("missing capabilities");
      }
    }
    const registry = new CoreModelBackendRegistry();
    registry.register(new MissingCapabilitiesBackend("provider", ["model-a"]));
    expect(
      registry.tryResolveModel({ providerId: "provider", modelId: "model-a" }),
    ).toBeUndefined();
  });

  it("defers stream lookup failures until iteration", async () => {
    const registry = new CoreModelBackendRegistry();
    registry.register(new ScopedBackend("provider", ["model-a"]));
    const runtime = new DefaultCoreModelRuntime(registry, { ownerId: "owner" });
    const stream = runtime.stream({
      principal: principalA,
      authContext: undefined,
      model: "missing",
      request: modelRequest(),
    });
    await expect(stream.next()).rejects.toThrow(
      'Unknown model "missing". Available models: provider/model-a',
    );
  });

  it("forwards a request auth resolver without ambient runtime state", async () => {
    const resolveCredential = vi.fn();
    const authContext = { credentialResolver: { resolveCredential } };
    const registry = new CoreModelBackendRegistry();
    const backend = new ScopedBackend("provider", ["model-a"]);
    registry.register(backend);
    const runtime = new DefaultCoreModelRuntime(registry, { ownerId: "owner" });

    await runtime.getAuthStatus({ principal: principalA, authContext });
    expect(backend.contexts.at(-1)).toEqual({
      principal: principalA,
      authContext,
    });
  });
});
