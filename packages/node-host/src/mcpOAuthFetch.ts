import {
  auth,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";

interface ProviderBinding {
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
  pending?: Promise<void>;
}

const providerBindings = new WeakMap<OAuthClientProvider, ProviderBinding>();

export function registerMcpOAuthFetch(
  provider: OAuthClientProvider,
  fetch: typeof globalThis.fetch,
  signal?: AbortSignal,
): void {
  providerBindings.set(provider, { fetch, signal });
}

/** Keep MCP transport requests and OAuth negotiation on separately authorized fetches. */
export function createMcpOAuthTransportFetch(
  provider: OAuthClientProvider,
  serverUrl: URL,
  mcpFetch: typeof globalThis.fetch,
): typeof globalThis.fetch | undefined {
  const binding = providerBindings.get(provider);
  if (!binding) return undefined;
  return async (input, init) => {
    const request = new Request(input, init);
    const send = async () => {
      binding.signal?.throwIfAborted();
      request.signal.throwIfAborted();
      const headers = new Headers(request.headers);
      const tokens = await provider.tokens();
      if (tokens) headers.set("Authorization", `Bearer ${tokens.access_token}`);
      return {
        token: tokens?.access_token,
        response: await mcpFetch(new Request(request.clone(), { headers })),
      };
    };
    const { response, token } = await send();
    const challenge = extractWWWAuthenticateParams(response);
    if (
      response.status !== 401 &&
      !(response.status === 403 && challenge.error === "insufficient_scope")
    ) {
      return response;
    }
    await response.body?.cancel().catch(() => undefined);
    binding.signal?.throwIfAborted();
    request.signal.throwIfAborted();
    // POST and SSE requests can reject the same token together. Share one refresh
    // and reuse tokens already renewed by a request that finished ahead of us.
    if (binding.pending) {
      await binding.pending;
    } else if ((await provider.tokens())?.access_token === token) {
      // Recheck after the asynchronous credential read before claiming the slot.
      if (!binding.pending) {
        binding.pending = negotiate();
        void binding.pending
          .finally(() => {
            binding.pending = undefined;
          })
          .catch(() => undefined);
      }
      await binding.pending;
    }
    if (!(await provider.tokens())) throw new Error("mcp_oauth_tokens_missing");
    return (await send()).response;

    async function negotiate(): Promise<void> {
      const signal = binding!.signal ?? request.signal;
      let networkFailure: unknown;
      const guardedFetch: typeof globalThis.fetch = async (url, options) => {
        signal.throwIfAborted();
        if (networkFailure) throw networkFailure;
        try {
          return await binding!.fetch(url, {
            ...options,
            signal: options?.signal
              ? AbortSignal.any([signal, options.signal])
              : signal,
          });
        } catch (error) {
          networkFailure = error;
          throw error;
        }
      };
      // The SDK swallows some refresh/discovery failures before attempting a browser flow.
      const guardedProvider = new Proxy(provider, {
        get(target, key) {
          if (key === "redirectToAuthorization") {
            return async (url: URL) => {
              signal.throwIfAborted();
              if (networkFailure) throw networkFailure;
              await target.redirectToAuthorization(url);
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      signal.throwIfAborted();
      await auth(guardedProvider, {
        serverUrl,
        resourceMetadataUrl: challenge.resourceMetadataUrl,
        scope: challenge.scope,
        fetchFn: guardedFetch,
      });
      signal.throwIfAborted();
      if (networkFailure) throw networkFailure;
    }
  };
}
