import type { HostToolResolver } from "@agentlink/core";
import type { CodexResolvedAuthForClient } from "@agentlink/core/codex";
import type { CoreNativeWebToolResult } from "@agentlink/core/native-web-tools";
import {
  createWorkspaceWebTools,
  type WorkspaceWebAccess,
} from "@agentlink/workspace-host";

import {
  executeCodexStandaloneWeb,
  type CodexStandaloneWebRequest,
} from "../../../src/core/model/providers/codex/standaloneWeb.js";
import type { NetworkPolicy } from "./egressPolicy.js";
import { fetchWebPage, WebFetchError, type WebConnector } from "./webFetch.js";

export {
  formatPage,
  searxngSearch,
  WEB_FETCH_DEFAULT_LENGTH,
  WEB_FETCH_MAX_LENGTH,
} from "@agentlink/workspace-host";

/**
 * Web tools for assistant chats, governed by the project's network preset:
 *
 * - `off`: no web tools.
 * - `dependencies`: `web_fetch` only, limited to the dependency hosts and
 *   the project's extra sites (the same rules its commands get).
 * - `open`: `web_fetch` for any public site, and `web_search`.
 *
 * The tools themselves are shared with the CLI (`createWorkspaceWebTools`);
 * this adapter supplies the project's policy, the checked connector and the
 * server's Codex sign-in. Search is only offered on the open preset: a query
 * leaves the server whatever the project allows.
 */

export interface WebToolsOptions {
  /** The project's current policy, read every turn and every call. */
  readonly policy: () => NetworkPolicy;
  readonly connector: WebConnector;
  /** Codex hosted search, for models of these providers. */
  readonly codex?: {
    readonly providerIds: ReadonlySet<string>;
    readonly resolveAuth: () => Promise<CodexResolvedAuthForClient | null>;
    /** Test seam. */
    readonly search?: (
      request: CodexStandaloneWebRequest,
    ) => Promise<CoreNativeWebToolResult>;
  };
  /** SearXNG base URL, for every other model. */
  readonly searxngUrl?: string;
  /** Test seams. */
  readonly fetchPage?: typeof fetchWebPage;
  readonly fetch?: typeof globalThis.fetch;
}

function access(policy: NetworkPolicy): WorkspaceWebAccess {
  if (policy.preset === "off") return "off";
  return policy.preset === "open" ? "fetch_and_search" : "fetch";
}

export function createWebTools(options: WebToolsOptions): HostToolResolver {
  const fetchPage = options.fetchPage ?? fetchWebPage;
  const codex = options.codex;
  return createWorkspaceWebTools({
    access: () => access(options.policy()),
    fetchPage: ({ url, signal }) =>
      fetchPage({
        url,
        policy: options.policy(),
        connector: options.connector,
        ...(signal ? { signal } : {}),
      }),
    describeFetchError: (error) =>
      error instanceof WebFetchError ? error.message : undefined,
    fetchDescription:
      "Read a public web page (HTTPS, port 443) as text. HTML is converted to readable text with links kept as `text (url)`. Long pages are returned in parts: pass `start_index` from the previous result to continue. The project's network settings decide which sites can be read.",
    ...(codex
      ? {
          codex: {
            providerIds: codex.providerIds,
            resolveAuth: codex.resolveAuth,
            search: codex.search ?? executeCodexStandaloneWeb,
            signInMessage:
              "Codex web search needs a ChatGPT sign-in (run `agentlink-server codex-login`)",
          },
        }
      : {}),
    ...(options.searxngUrl ? { searxngUrl: options.searxngUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    searchUnavailableMessage:
      "Web search is not available for this model: it needs a Codex model, or a SearXNG server set in the assistant's web.searxngUrl",
    searchDisabledMessage:
      "Web search is only available on the Open web preset",
  });
}
