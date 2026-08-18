import {
  auth,
  extractWWWAuthenticateParams,
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  FetchLike,
  Transport,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { EventSource } from "eventsource";

import { validateAgentPluginMcpHttpUrl } from "../core/agentPlugins/httpPolicy.js";

/**
 * Agent Plugins legacy SSE transport compatibility wrapper.
 *
 * Behavior is pinned to MCP 2024-11-05 and SDK 1.29.0, except endpoint events
 * are resolved against the final SSE response URL and may cross origins. The
 * supplied MCP fetch enforces per-hop URL/header policy. OAuth always uses the
 * separate unwrapped fetch.
 */
export class AgentPluginSseClientTransport implements Transport {
  private eventSource: EventSource | undefined;
  private endpoint: URL | undefined;
  private abortController: AbortController | undefined;
  private resourceMetadataUrl: URL | undefined;
  private scope: string | undefined;
  private protocolVersion: string | undefined;
  private currentSseResponseUrl: URL;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private readonly url: URL,
    private readonly options: {
      readonly authProvider?: OAuthClientProvider;
      readonly mcpFetch: FetchLike;
      readonly oauthFetch: FetchLike;
    },
  ) {
    this.currentSseResponseUrl = url;
  }

  async start(): Promise<void> {
    if (this.eventSource) {
      throw new Error("Agent Plugin SSE transport is already started.");
    }
    await this.startOrAuth();
  }

  async finishAuth(authorizationCode: string): Promise<void> {
    const authProvider = this.options.authProvider;
    if (!authProvider) throw new UnauthorizedError("No auth provider");
    const result = await auth(authProvider, {
      serverUrl: this.url,
      authorizationCode,
      resourceMetadataUrl: this.resourceMetadataUrl,
      scope: this.scope,
      fetchFn: this.options.oauthFetch,
    });
    if (result !== "AUTHORIZED") {
      throw new UnauthorizedError("Failed to authorize");
    }
  }

  async close(): Promise<void> {
    this.abortController?.abort();
    this.eventSource?.close();
    this.eventSource = undefined;
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.endpoint) throw new Error("Not connected");
    try {
      const headers = await this.commonHeaders();
      headers.set("content-type", "application/json");
      const response = await this.options.mcpFetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: this.abortController?.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => null);
        if (response.status === 401 && this.options.authProvider) {
          const { resourceMetadataUrl, scope } =
            extractWWWAuthenticateParams(response);
          this.resourceMetadataUrl = resourceMetadataUrl;
          this.scope = scope;
          const result = await auth(this.options.authProvider, {
            serverUrl: this.url,
            resourceMetadataUrl,
            scope,
            fetchFn: this.options.oauthFetch,
          });
          if (result !== "AUTHORIZED") throw new UnauthorizedError();
          return this.send(message);
        }
        throw new Error(
          `Error POSTing to Agent Plugin SSE endpoint (HTTP ${response.status}): ${text}`,
        );
      }
      await response.body?.cancel();
    } catch (error) {
      this.onerror?.(toError(error));
      throw error;
    }
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  private async authThenStart(): Promise<void> {
    const authProvider = this.options.authProvider;
    if (!authProvider) throw new UnauthorizedError("No auth provider");
    const result = await auth(authProvider, {
      serverUrl: this.url,
      resourceMetadataUrl: this.resourceMetadataUrl,
      scope: this.scope,
      fetchFn: this.options.oauthFetch,
    });
    if (result !== "AUTHORIZED") throw new UnauthorizedError();
    this.eventSource?.close();
    this.eventSource = undefined;
    await this.startOrAuth();
  }

  private async commonHeaders(): Promise<Headers> {
    const headers = new Headers();
    const tokens = await this.options.authProvider?.tokens();
    if (tokens) headers.set("authorization", `Bearer ${tokens.access_token}`);
    if (this.protocolVersion) {
      headers.set("mcp-protocol-version", this.protocolVersion);
    }
    return headers;
  }

  private startOrAuth(): Promise<void> {
    return new Promise((resolve, reject) => {
      const eventSource = new EventSource(this.url, {
        fetch: async (url, init) => {
          const headers = await this.commonHeaders();
          new Headers(init?.headers).forEach((value, name) =>
            headers.set(name, value),
          );
          headers.set("accept", "text/event-stream");
          const response = await this.options.mcpFetch(url, {
            ...init,
            headers,
          });
          this.currentSseResponseUrl = new URL(response.url || String(url));
          if (
            response.status === 401 &&
            response.headers.has("www-authenticate")
          ) {
            const { resourceMetadataUrl, scope } =
              extractWWWAuthenticateParams(response);
            this.resourceMetadataUrl = resourceMetadataUrl;
            this.scope = scope;
          }
          return response;
        },
      });
      this.eventSource = eventSource;
      this.abortController = new AbortController();
      eventSource.onerror = (event) => {
        if (event.code === 401 && this.options.authProvider) {
          void this.authThenStart().then(resolve, reject);
          return;
        }
        const error = new Error(
          `Agent Plugin SSE error${event.code ? ` (${event.code})` : ""}: ${event.message ?? "connection failed"}`,
        );
        reject(error);
        this.onerror?.(error);
      };
      eventSource.addEventListener("endpoint", (event) => {
        try {
          const data = (event as MessageEvent<string>).data;
          const endpoint = new URL(data, this.currentSseResponseUrl);
          const validationError = validateAgentPluginMcpHttpUrl(endpoint);
          if (validationError) {
            throw new Error(
              `Agent Plugin SSE endpoint rejected: ${validationError}`,
            );
          }
          this.endpoint = endpoint;
          resolve();
        } catch (error) {
          const normalized = toError(error);
          reject(normalized);
          this.onerror?.(normalized);
          void this.close();
        }
      });
      eventSource.onmessage = (event) => {
        try {
          this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(event.data)));
        } catch (error) {
          this.onerror?.(toError(error));
        }
      };
    });
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
