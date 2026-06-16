import {
  Agent,
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  interceptors,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";

const KEEP_ALIVE_TIMEOUT_MS = 60_000;
const HEADERS_TIMEOUT_MS = 30_000;

let installed = false;
const dispatchers = new Map<boolean, Dispatcher>();

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
export function getAgentLinkHttpDispatcher(
  env: NodeJS.ProcessEnv = process.env,
): Dispatcher {
  const useProxy = hasProxyEnv(env);
  const cached = dispatchers.get(useProxy);
  if (cached) return cached;

  const options = {
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    headersTimeout: HEADERS_TIMEOUT_MS,
  };
  const dispatcher = useProxy
    ? new EnvHttpProxyAgent(options)
    : new Agent(options).compose(interceptors.dns());
  dispatchers.set(useProxy, dispatcher);
  return dispatcher;
}

export function installAgentLinkHttpDispatcher(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (installed) return;
  installed = true;
  setGlobalDispatcher(getAgentLinkHttpDispatcher(env));
}

export const agentLinkFetch: typeof globalThis.fetch = (input, init) => {
  return undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    {
      ...init,
      dispatcher: getAgentLinkHttpDispatcher(),
    } as Parameters<typeof undiciFetch>[1],
  ) as unknown as ReturnType<typeof globalThis.fetch>;
};
