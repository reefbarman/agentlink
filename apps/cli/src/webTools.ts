import type { HostToolResolver } from "@agentlink/core";
import type { CodexCredentialProvider } from "@agentlink/core/codex";
import type { CoreNativeWebToolResult } from "@agentlink/core/native-web-tools";
import {
  createPublicWebPageFetcher,
  WebImageError,
  type PublicWebPageFetcher,
} from "@agentlink/node-host";
import {
  createWorkspaceWebTools,
  type WorkspaceCodexWebSearchRequest,
} from "@agentlink/workspace-host";

import { executeCodexStandaloneWeb } from "../../../src/core/model/providers/codex/standaloneWeb.js";
import type { CliWebConfig } from "./types.js";

export interface CreateCliWebToolsOptions {
  readonly web: CliWebConfig;
  /** Codex provider IDs in this CLI's config; search uses Codex for them. */
  readonly codexProviderIds: ReadonlySet<string>;
  readonly codexCredentials?: CodexCredentialProvider<never>;
  /** Test seams. */
  readonly pageFetcher?: PublicWebPageFetcher;
  readonly codexSearch?: (
    request: WorkspaceCodexWebSearchRequest,
  ) => Promise<CoreNativeWebToolResult>;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * `web_fetch` and `web_search` for the CLI. Pages are read directly from
 * this machine through node-host's public-only transport (no private, local
 * or IP-address hosts; refused rather than bypassed when a proxy is set).
 * Search uses Codex's hosted search for Codex models (ChatGPT sign-in) and
 * the owner's `web.searxngUrl` for other models.
 */
export function createCliWebTools(
  options: CreateCliWebToolsOptions,
): HostToolResolver {
  let pageFetcher = options.pageFetcher;
  const codexCredentials = options.codexCredentials;
  const searxngUrl = options.web.searxngUrl;
  return createWorkspaceWebTools({
    access: () => "fetch_and_search",
    fetchPage: (request) => {
      // Created on first use; its idle sockets do not keep the CLI alive.
      pageFetcher ??= createPublicWebPageFetcher();
      return pageFetcher.fetchPage(request);
    },
    describeFetchError: (error) =>
      error instanceof WebImageError ? error.message : undefined,
    ...(codexCredentials && options.codexProviderIds.size > 0
      ? {
          codex: {
            providerIds: options.codexProviderIds,
            resolveAuth: () =>
              codexCredentials.resolveAuth({
                context: undefined as never,
                modelId: "",
                purpose: "nativeWeb",
              }),
            search: options.codexSearch ?? executeCodexStandaloneWeb,
            signInMessage:
              "Codex web search needs a ChatGPT sign-in (run `agentlink auth codex`)",
          },
        }
      : {}),
    ...(searxngUrl ? { searxngUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    searchUnavailableMessage:
      "Web search is not available for this model: it needs a Codex model, or a SearXNG server set in the CLI config's web.searxngUrl",
  });
}
