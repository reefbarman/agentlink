import { AsyncLocalStorage } from "node:async_hooks";
import { MAX_CONCURRENT_MODEL_REQUESTS_PER_PROVIDER } from "@agentlink/core/model-request-scheduler";
import {
  Agent,
  EnvHttpProxyAgent,
  Response as UndiciResponse,
  fetch as undiciFetch,
  interceptors,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";

const KEEP_ALIVE_TIMEOUT_MS = 60_000;
const HEADERS_TIMEOUT_MS = 300_000;
const BODY_TIMEOUT_MS = 300_000;
const LONG_POLL_TIMEOUT_MS = 0;
// Must never cap below what the model-request scheduler can admit
// (`agentlink.provider.maxConcurrentRequests`): streaming turns hold a
// connection for their entire duration, so a lower socket cap queues whole
// turns inside undici with no admission-phase visibility. Undici opens
// connections lazily and reaps idle ones after KEEP_ALIVE_TIMEOUT_MS, so the
// high ceiling costs nothing while unused.
const CONNECTIONS_PER_ORIGIN = MAX_CONCURRENT_MODEL_REQUESTS_PER_PROVIDER;

export interface AgentLinkHttpActivity {
  kind: "headers" | "body";
  at: number;
  bytes?: number;
}

export type AgentLinkHttpActivityListener = (
  activity: AgentLinkHttpActivity,
) => void;

export interface AgentLinkHttpDiagnostics {
  totalRequests: number;
  activeRequests: number;
  peakActiveRequests: number;
  headerResponses: number;
  bodyChunks: number;
  bodyBytes: number;
  transportErrors: number;
}

const activityContext = new AsyncLocalStorage<AgentLinkHttpActivityListener>();
const diagnostics: AgentLinkHttpDiagnostics = {
  totalRequests: 0,
  activeRequests: 0,
  peakActiveRequests: 0,
  headerResponses: 0,
  bodyChunks: 0,
  bodyBytes: 0,
  transportErrors: 0,
};

let installed = false;
const dispatchers = new Map<boolean, Dispatcher>();
const longPollingDispatchers = new Map<boolean, Dispatcher>();

function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy,
  );
}

/**
 * Dispatcher instances are cached per direct/proxy mode for the extension
 * process. Proxy environment changes after activation require a window reload to
 * rebuild the underlying connection pools.
 */
function getCachedDispatcher(
  cache: Map<boolean, Dispatcher>,
  env: NodeJS.ProcessEnv,
  headersTimeout: number,
  bodyTimeout: number,
): Dispatcher {
  const useProxy = hasProxyEnv(env);
  const cached = cache.get(useProxy);
  if (cached) return cached;

  const options = {
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    headersTimeout,
    bodyTimeout,
    connections: CONNECTIONS_PER_ORIGIN,
    allowH2: true,
  };
  const dispatcher = useProxy
    ? new EnvHttpProxyAgent(options)
    : new Agent(options).compose(interceptors.dns());
  cache.set(useProxy, dispatcher);
  return dispatcher;
}

export function getAgentLinkHttpDispatcher(
  env: NodeJS.ProcessEnv = process.env,
): Dispatcher {
  return getCachedDispatcher(
    dispatchers,
    env,
    HEADERS_TIMEOUT_MS,
    BODY_TIMEOUT_MS,
  );
}

/**
 * Dispatcher for protocols such as MCP that define their own request deadline.
 * Undici's independent header/body deadlines must not preempt that contract.
 */
export function getAgentLinkLongPollingHttpDispatcher(
  env: NodeJS.ProcessEnv = process.env,
): Dispatcher {
  return getCachedDispatcher(
    longPollingDispatchers,
    env,
    LONG_POLL_TIMEOUT_MS,
    LONG_POLL_TIMEOUT_MS,
  );
}

export function withAgentLinkHttpActivity<T>(
  listener: AgentLinkHttpActivityListener | undefined,
  operation: () => T,
): T {
  return listener ? activityContext.run(listener, operation) : operation();
}

export function getAgentLinkHttpDiagnostics(): AgentLinkHttpDiagnostics {
  return { ...diagnostics };
}

function reportActivity(
  listener: AgentLinkHttpActivityListener | undefined,
  activity: AgentLinkHttpActivity,
): void {
  try {
    listener?.(activity);
  } catch {
    // Diagnostics must never be able to fail the provider request.
  }
}

function observeResponseBody(
  response: globalThis.Response,
  listener: AgentLinkHttpActivityListener | undefined,
  finalize: () => void,
): globalThis.Response {
  diagnostics.headerResponses++;
  reportActivity(listener, { kind: "headers", at: Date.now() });

  if (!listener) {
    finalize();
    return response;
  }

  if (!response.body) {
    finalize();
    return response;
  }

  const reader = response.body.getReader();
  const observedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finalize();
          controller.close();
          return;
        }
        const bytes = result.value?.byteLength ?? 0;
        diagnostics.bodyChunks++;
        diagnostics.bodyBytes += bytes;
        reportActivity(listener, { kind: "body", at: Date.now(), bytes });
        controller.enqueue(result.value);
      } catch (error) {
        finalize();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finalize();
      await reader.cancel(reason);
    },
  });

  const observed = new UndiciResponse(observedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
  });
  for (const property of ["url", "redirected", "type"] as const) {
    Object.defineProperty(observed, property, {
      configurable: true,
      enumerable: true,
      value: response[property],
    });
  }
  return observed as unknown as globalThis.Response;
}

export function installAgentLinkHttpDispatcher(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (installed) return;
  installed = true;
  setGlobalDispatcher(getAgentLinkHttpDispatcher(env));
}

export const agentLinkLongPollingFetch: typeof globalThis.fetch = async (
  input,
  init,
) =>
  (await undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    {
      ...init,
      dispatcher: getAgentLinkLongPollingHttpDispatcher(),
    } as Parameters<typeof undiciFetch>[1],
  )) as unknown as globalThis.Response;

export const agentLinkFetch: typeof globalThis.fetch = async (input, init) => {
  const listener = activityContext.getStore();
  diagnostics.totalRequests++;
  diagnostics.activeRequests++;
  diagnostics.peakActiveRequests = Math.max(
    diagnostics.peakActiveRequests,
    diagnostics.activeRequests,
  );
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    diagnostics.activeRequests = Math.max(0, diagnostics.activeRequests - 1);
  };

  try {
    const response = (await undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      {
        ...init,
        dispatcher: getAgentLinkHttpDispatcher(),
      } as Parameters<typeof undiciFetch>[1],
    )) as unknown as globalThis.Response;
    return observeResponseBody(response, listener, finalize);
  } catch (error) {
    diagnostics.transportErrors++;
    finalize();
    throw error;
  }
};
