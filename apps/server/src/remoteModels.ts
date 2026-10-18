import type {
  AgentPrincipal,
  CoreModelBackend,
  CoreModelCapabilities,
  CoreModelCompleteRequest,
  CoreModelCompleteResult,
  CoreModelRequestContext,
  CoreModelStreamEvent,
  CoreModelStreamRequest,
} from "@agentlink/core";
import type { RunnerHttpClient, RunnerRouteHandler } from "./runnerProtocol.js";

import type { CoreModelCatalogEntry } from "@agentlink/protocol/model-catalog";
import { HttpError } from "./httpJson.js";
import type { PromptProfile } from "@agentlink/protocol/prompt-profile";

/**
 * The model proxy: a session runner holds no provider sign-ins, so its
 * model calls come back to the control plane, which makes them with its own
 * backends. The runner registers one remote backend per control-plane
 * backend, described once when it starts (catalog, capabilities and prompt
 * profiles, which the engine reads synchronously); `stream` and `complete`
 * are forwarded per call.
 *
 * What crosses is the provider-neutral request. In-process state does not:
 * the abort signal becomes the HTTP request's lifetime, execution controls
 * become their numbers (enforced again on the control plane), and Codex's
 * in-memory turn routing and conversation state are left out, so a runner's
 * Codex calls send the full history each time.
 */

export interface RemoteModelProviderDescription {
  readonly providerId: string;
  readonly displayName: string;
  readonly condenseModel: string;
  readonly models: readonly CoreModelCatalogEntry[];
  readonly routableModelIds?: readonly string[];
  readonly capabilities: Readonly<Record<string, CoreModelCapabilities>>;
  readonly promptProfiles: Readonly<Record<string, PromptProfile>>;
  /** Whether the backend reports sign-in status / its live model list. */
  readonly authStatus: boolean;
  readonly availableModels: boolean;
}

export function describeModelBackend(
  backend: CoreModelBackend,
): RemoteModelProviderDescription {
  const models = backend.listModels();
  const routable = backend.listRoutableModelIds?.();
  const capabilities: Record<string, CoreModelCapabilities> = {};
  const promptProfiles: Record<string, PromptProfile> = {};
  for (const id of new Set([
    ...models.map((model) => model.id),
    ...(routable ?? []),
  ])) {
    try {
      capabilities[id] = backend.getCapabilities(id);
    } catch {
      continue;
    }
    const profile = backend.getPromptProfile?.(id);
    if (profile) promptProfiles[id] = profile;
  }
  return {
    providerId: backend.providerId,
    displayName: backend.displayName,
    condenseModel: backend.condenseModel,
    models,
    ...(routable ? { routableModelIds: routable } : {}),
    capabilities,
    promptProfiles,
    authStatus: typeof backend.getAuthStatus === "function",
    availableModels: typeof backend.listAvailableModels === "function",
  };
}

/** The serializable part of a model request. */
export function toWireModelRequest(
  request: CoreModelStreamRequest | CoreModelCompleteRequest,
): Record<string, unknown> {
  const {
    signal: _signal,
    executionControls,
    onProviderRequestAttempt: _attempt,
    onTransportActivity: _activity,
    providerHints,
    ...rest
  } = request;
  const codex = providerHints?.codex;
  return {
    ...JSON.parse(JSON.stringify(rest)),
    ...(executionControls
      ? {
          executionControls: {
            maxRetries: executionControls.maxRetries,
            maxOutputBytes: executionControls.maxOutputBytes,
          },
        }
      : {}),
    ...(providerHints
      ? {
          providerHints: {
            ...(providerHints.sessionId
              ? { sessionId: providerHints.sessionId }
              : {}),
            ...(codex
              ? {
                  codex: {
                    ...(codex.sessionId ? { sessionId: codex.sessionId } : {}),
                    ...(codex.fullHistory ? { fullHistory: true } : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

function fromWireModelRequest(
  value: unknown,
  signal: AbortSignal,
): CoreModelStreamRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "model_request_invalid");
  }
  const request = value as Record<string, unknown>;
  if (typeof request.model !== "string" || !Array.isArray(request.messages)) {
    throw new HttpError(400, "model_request_invalid");
  }
  const controls = request.executionControls as
    | { maxRetries?: unknown; maxOutputBytes?: unknown }
    | undefined;
  return {
    ...(request as unknown as CoreModelStreamRequest),
    ...(controls
      ? {
          executionControls: {
            maxRetries: Number(controls.maxRetries) || 0,
            maxOutputBytes: Number(controls.maxOutputBytes) || 1024 * 1024,
            beforeModelDispatch: () => undefined,
          },
        }
      : {}),
    signal,
  };
}

/**
 * Control-plane routes for one runner. `principal` is the runner's
 * project principal; the runner cannot choose another.
 */
export function modelProxyRoutes(options: {
  readonly backends: readonly CoreModelBackend[];
  readonly principal: AgentPrincipal;
}): Record<string, RunnerRouteHandler> {
  const byId = new Map(
    options.backends.map((backend) => [backend.providerId, backend]),
  );
  const context: CoreModelRequestContext = {
    principal: options.principal,
    authContext: undefined,
  };
  const backendFor = (body: Record<string, unknown>) => {
    const backend =
      typeof body.providerId === "string"
        ? byId.get(body.providerId)
        : undefined;
    if (!backend) throw new HttpError(404, "model_provider_not_found");
    return backend;
  };
  return {
    "/models/describe": async () =>
      options.backends.map((backend) => describeModelBackend(backend)),
    "/models/stream": async (body, { signal, stream }) => {
      const backend = backendFor(body);
      const request = fromWireModelRequest(body.request, signal);
      const write = stream();
      for await (const event of backend.stream(request, context)) {
        write({ type: "event", event });
      }
      return undefined;
    },
    "/models/complete": async (body, { signal }) =>
      await backendFor(body).complete(
        fromWireModelRequest(body.request, signal),
        context,
      ),
    "/models/auth-status": async (body) =>
      (await backendFor(body).getAuthStatus?.(context)) ?? null,
    "/models/available": async (body) =>
      (await backendFor(body).listAvailableModels?.(context)) ?? null,
  };
}

/**
 * The runner's backends: one per control-plane backend, as described when
 * the runner started.
 */
export async function openRemoteModelBackends(
  client: RunnerHttpClient,
): Promise<CoreModelBackend[]> {
  const described = await client.call<RemoteModelProviderDescription[]>(
    "/models/describe",
    {},
  );
  return described.map((description) =>
    remoteModelBackend(client, description),
  );
}

export function remoteModelBackend(
  client: RunnerHttpClient,
  description: RemoteModelProviderDescription,
): CoreModelBackend {
  const { providerId } = description;
  const capabilitiesOf = (modelId: string) => {
    const capabilities = description.capabilities[modelId];
    if (!capabilities) {
      throw new Error(`Unknown model ${providerId}/${modelId}`);
    }
    return structuredClone(capabilities);
  };
  const beforeDispatch = (
    request: CoreModelStreamRequest | CoreModelCompleteRequest,
  ) => {
    // The physical request happens on the control plane; these local hooks
    // see the forwarded call instead.
    request.executionControls?.beforeModelDispatch({ model: request.model });
    request.onProviderRequestAttempt?.({ model: request.model });
  };
  return {
    providerId,
    displayName: description.displayName,
    condenseModel: description.condenseModel,
    listModels: () => structuredClone([...description.models]),
    ...(description.routableModelIds
      ? { listRoutableModelIds: () => [...description.routableModelIds!] }
      : {}),
    getCapabilities: capabilitiesOf,
    getPromptProfile: (modelId) =>
      description.promptProfiles[modelId]
        ? structuredClone(description.promptProfiles[modelId])
        : undefined,
    ...(description.authStatus
      ? {
          async getAuthStatus() {
            return (await client.call("/models/auth-status", {
              providerId,
            })) as never;
          },
        }
      : {}),
    ...(description.availableModels
      ? {
          async listAvailableModels() {
            const models = await client.call<CoreModelCatalogEntry[] | null>(
              "/models/available",
              { providerId },
            );
            return models ?? structuredClone([...description.models]);
          },
        }
      : {}),
    async *stream(request) {
      beforeDispatch(request);
      for await (const line of client.stream(
        "/models/stream",
        { providerId, request: toWireModelRequest(request) },
        request.signal,
      )) {
        request.onTransportActivity?.({
          kind: "provider_event",
          at: Date.now(),
        });
        if (line.type === "event") yield line.event as CoreModelStreamEvent;
      }
    },
    async complete(request) {
      beforeDispatch(request);
      return await client.call<CoreModelCompleteResult>(
        "/models/complete",
        { providerId, request: toWireModelRequest(request) },
        request.signal,
      );
    },
  };
}
