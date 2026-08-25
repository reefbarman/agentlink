import * as vscode from "vscode";

import {
  ElicitationCompleteNotificationSchema,
  ElicitRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolResult,
  ElicitRequestURLParams,
  Prompt,
  Resource,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchema, ToolDefinition } from "./providers/types.js";
import { McpOAuthError, McpOAuthProvider } from "./McpOAuthProvider.js";
import {
  McpAuthCoordinator,
  mcpServerIdentityHash,
  type McpAuthorizationAttempt,
  type McpAuthMode,
  type McpAuthTrigger,
} from "./mcpAuthCoordinator.js";
import { randomUUID } from "crypto";
import {
  buildAgentExecutionEnv,
  inheritProcessEnv,
} from "../process/agentExecutionPolicy.js";
import { isMcpToolName, parseMcpToolName } from "./mcpToolNames.js";
import { agentLinkLongPollingFetch } from "../util/httpDispatcher.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServerConfig } from "./mcpConfig.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { resolveMcpRequestTimeout } from "../shared/mcpTimeout.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolResult } from "../shared/types.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  validateMcpElicitationUrl,
  type McpUrlElicitationRequest,
} from "../shared/mcpUrlElicitation.js";
import { normalizeMcpToolResult } from "./mcpToolResult.js";
import { createAgentPluginMcpFetch } from "./agentPluginHttpFetch.js";
import { buildAgentPluginStdioEnvironment } from "./agentPluginMcpRuntime.js";
import { AgentPluginSseClientTransport } from "./AgentPluginSseClientTransport.js";
import {
  normalizeMcpElicitationSchema,
  type McpFormElicitationInput,
} from "../shared/mcpElicitation.js";

export type McpServerStatus =
  | "connecting"
  | "connected"
  | "error"
  | "disconnected"
  | "disabled";

export interface McpToolInfo {
  name: string;
  description?: string;
}

export interface McpServerInfo {
  name: string;
  status: McpServerStatus;
  error?: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  tools: McpToolInfo[];
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export type UrlElicitationAction = "accept" | "cancel" | "decline";

export interface McpConnectOptions {
  readonly interactiveForNewServers?: boolean;
  readonly interactiveServerNames?: ReadonlySet<string>;
  readonly trigger?: McpAuthTrigger;
  readonly userInitiated?: boolean;
}

interface ConnectServerOptions {
  retryCount?: number;
  afterAuth?: boolean;
  authMode?: McpAuthMode;
  trigger?: McpAuthTrigger;
  userInitiated?: boolean;
  rootAttemptId?: string;
  parentAttemptId?: string;
}

type McpCatalogKind = "tools" | "resources" | "prompts";

type McpOutputValidator = (
  input: unknown,
) =>
  | { valid: true; data: Record<string, unknown>; errorMessage: undefined }
  | { valid: false; data: undefined; errorMessage: string };

export interface McpToolAuthorizationRequest {
  readonly serverName: string;
  readonly bareToolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly config: Readonly<McpServerConfig>;
  readonly approvedByCaller: boolean;
}

export interface McpClientHubOptions {
  readonly isConfigCurrent?: (
    config: Readonly<McpServerConfig>,
  ) => boolean | Promise<boolean>;
  readonly onBeforeToolCall?: (
    request: Readonly<McpToolAuthorizationRequest>,
  ) => "allow" | "deny" | Promise<"allow" | "deny">;
  readonly authCoordinator?: McpAuthCoordinator;
  readonly hubScope?: string;
  readonly hubGeneration?: number;
}

interface McpSchemaValidatorProvider {
  getValidator<T>(
    schema: object,
  ): (
    input: unknown,
  ) =>
    | { valid: true; data: T; errorMessage: undefined }
    | { valid: false; data: undefined; errorMessage: string };
}

interface CatalogRefreshState {
  running: boolean;
  dirty: boolean;
  scheduled?: ReturnType<typeof setTimeout>;
}

interface ConnectedServer {
  name: string;
  config: McpServerConfig;
  client: Client;
  tools: ToolDefinition[];
  /** Bare tool names whose MCP annotations declare read-only behavior. */
  parallelSafeToolNames: Set<string>;
  outputValidators: Map<string, McpOutputValidator>;
  resources: McpResource[];
  prompts: McpPrompt[];
  catalogRefresh: Record<McpCatalogKind, CatalogRefreshState>;
  status: McpServerStatus;
  error?: string;
  retryCount: number;
  retryTimer?: ReturnType<typeof setTimeout>;
}

/**
 * OAuth credentials are stored per server identity and shared by every hub in
 * this extension host, so concurrent connects to the same server (e.g. the Ask
 * Agent hub and a project hub both hosting a global server) must not race:
 * a token refresh rotates the refresh token, and a parallel refresh with the
 * superseded token fails and falls back to interactive auth. Serializing the
 * connect (which embeds any SDK-driven refresh) per server URL lets the second
 * connect reuse the tokens the first one just saved.
 */
const httpConnectQueues = new Map<string, Promise<unknown>>();
const MAX_MCP_CATALOG_PAGES = 100;
const MAX_MCP_CATALOG_ITEMS = 10_000;

function isCallToolResult(value: unknown): value is CallToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    Array.isArray(value.content)
  );
}

function unknownCompletionResult(
  error: string,
  server: string,
  tool: string,
  message: string,
  timeoutMs?: number,
): ToolResult {
  const detail = {
    error,
    server,
    tool,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    completionState: "unknown",
    retrySafe: false,
    guidance:
      "The MCP operation may have reached the server. Check server-provided status before retrying a potentially mutating call.",
  };
  return {
    data: detail,
    content: [{ type: "text", text: JSON.stringify(detail) }],
    isError: true,
    error: { kind: error, message },
  };
}

function describeMcpTransportFailure(
  error: unknown,
  serverName: string,
  toolName: string,
  timeout: number,
): ToolResult | undefined {
  if (!(error instanceof McpError)) return undefined;

  const kind =
    error.code === ErrorCode.RequestTimeout
      ? "mcp_request_timeout"
      : error.code === ErrorCode.ConnectionClosed
        ? "mcp_connection_closed"
        : undefined;
  if (!kind) return undefined;

  return unknownCompletionResult(
    kind,
    serverName,
    toolName,
    kind === "mcp_request_timeout"
      ? `MCP tool '${toolName}' timed out after ${timeout}ms.`
      : `MCP connection closed while calling '${toolName}'.`,
    kind === "mcp_request_timeout" ? timeout : undefined,
  );
}

function describeOutputSchemaError(
  error: unknown,
  toolName: string,
): string | undefined {
  if (!(error instanceof McpError)) return undefined;
  const message = error.message.replace(/^MCP error -?\d+: /, "");
  if (
    error.code === ErrorCode.InvalidRequest &&
    message ===
      `Tool ${toolName} has an output schema but did not return structured content`
  ) {
    return `MCP tool '${toolName}' declares an output schema but returned no structured content.`;
  }
  if (
    error.code === ErrorCode.InvalidParams &&
    (message.startsWith(
      "Structured content does not match the tool's output schema:",
    ) ||
      message.startsWith("Failed to validate structured content:"))
  ) {
    return `MCP tool '${toolName}' returned structured content that does not match its output schema. ${message}`;
  }
  return undefined;
}

async function withHttpConnectLock<T>(
  url: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = httpConnectQueues.get(url) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.catch(() => {});
  httpConnectQueues.set(url, tail);
  void tail.finally(() => {
    if (httpConnectQueues.get(url) === tail) httpConnectQueues.delete(url);
  });
  return run;
}

/**
 * McpClientHub manages connections to external MCP servers.
 *
 * Tool names are prefixed with the server name to avoid collisions: `servername__toolname`
 */
export class McpClientHub {
  private servers = new Map<string, ConnectedServer>();
  private disabledServers = new Map<string, McpServerConfig>();
  private oauthProviders = new Map<string, McpOAuthProvider>();
  private globalState?: vscode.Memento;
  private authFailureCounts = new Map<string, number>();
  private invalidRedirectRecoveryAttempted = new Set<string>();
  private runtimeReconnectPending = new Set<string>();
  private interactiveAuthUseCounts = new Map<string, number>();
  private static readonly MAX_AUTH_RETRIES = 3;
  private schemaValidator: McpSchemaValidatorProvider | undefined;

  private readonly options: Readonly<McpClientHubOptions>;
  private readonly authCoordinator: McpAuthCoordinator;

  constructor(
    globalState?: vscode.Memento,
    private readonly clientVersion = "unknown",
    options:
      | Readonly<McpClientHubOptions>
      | McpClientHubOptions["isConfigCurrent"] = {},
  ) {
    this.globalState = globalState;
    this.options =
      typeof options === "function" ? { isConfigCurrent: options } : options;
    this.authCoordinator =
      this.options.authCoordinator ??
      new McpAuthCoordinator({ log: (message) => this.log(message) });
  }

  onLog?: (message: string) => void;

  private log(message: string): void {
    this.onLog?.(message);
  }

  private summarizeUnknown(value: unknown): string {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (value instanceof Error) {
      return `${value.name}: ${value.message}`;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private describeError(err: unknown): string {
    if (!(err instanceof Error)) {
      return `non-error thrown: ${this.summarizeUnknown(err)}`;
    }

    const e = err as Error & {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
      cause?: unknown;
      data?: unknown;
      body?: unknown;
      response?: {
        status?: unknown;
        statusText?: unknown;
        data?: unknown;
        body?: unknown;
      };
    };

    const parts = [`name=${e.name}`, `message=${e.message}`];
    if (e.code !== undefined)
      parts.push(`code=${this.summarizeUnknown(e.code)}`);
    if (e.status !== undefined)
      parts.push(`status=${this.summarizeUnknown(e.status)}`);
    if (e.statusCode !== undefined)
      parts.push(`statusCode=${this.summarizeUnknown(e.statusCode)}`);
    if (e.cause !== undefined)
      parts.push(`cause=${this.summarizeUnknown(e.cause)}`);
    if (e.data !== undefined)
      parts.push(`data=${this.summarizeUnknown(e.data)}`);
    if (e.body !== undefined)
      parts.push(`body=${this.summarizeUnknown(e.body)}`);
    if (e.response) {
      parts.push(`response.status=${this.summarizeUnknown(e.response.status)}`);
      parts.push(
        `response.statusText=${this.summarizeUnknown(e.response.statusText)}`,
      );
      if (e.response.data !== undefined) {
        parts.push(`response.data=${this.summarizeUnknown(e.response.data)}`);
      }
      if (e.response.body !== undefined) {
        parts.push(`response.body=${this.summarizeUnknown(e.response.body)}`);
      }
    }

    return parts.join(" | ");
  }

  private showReauthenticateNotification(
    serverName: string,
    message: string,
  ): void {
    const action = "Reauthenticate";
    void vscode.window
      .showErrorMessage(`AgentLink: ${message}`, action)
      .then((selection) => {
        if (selection !== action) return;
        void this.reauthenticateServer(serverName).catch((error) => {
          this.log(
            `[mcp:${serverName}] notification-triggered reauthentication failed: ${this.describeError(error)}`,
          );
        });
      });
  }

  private async onBeforeAuthorizationOpen(
    request: Readonly<McpAuthorizationAttempt>,
  ) {
    const decision = await this.authCoordinator.beforeBrowserOpen(request);
    if (!decision.allowed) {
      const entry = this.servers.get(request.serverName);
      const message = `Authentication for '${request.serverName}' was paused (${decision.reason}). Use Reauthenticate to try again.`;
      if (entry) {
        entry.status = "error";
        entry.error = message;
      }
      if (decision.reason === "blocked_dialog_cap") {
        void this.oauthProviders
          .get(request.serverName)
          ?.debugStateSnapshot("at repeated oauth authorization request");
      }
      this.log(`[mcp:${request.serverName}] ${message}`);
      this.onStatusChange?.(this.getServerInfos());
    }
    return decision;
  }

  onStatusChange?: (servers: McpServerInfo[]) => void;

  /**
   * Called when an MCP server requests elicitation (a form for user input).
   * Resolve with the filled values, or reject/cancel to abort.
   */
  onElicitation?: (
    request: McpFormElicitationInput,
    resolve: (values: Record<string, unknown>) => void,
    cancel: () => void,
  ) => void;

  /** Called when an MCP server requests URL-mode elicitation. */
  onUrlElicitation?: (
    request: McpUrlElicitationRequest,
    resolve: (action: UrlElicitationAction) => void,
  ) => void;

  /** Called when an MCP server reports a URL elicitation completed out-of-band. */
  onUrlElicitationComplete?: (
    serverName: string,
    elicitationId: string,
  ) => void;

  /** Connect to all configured servers, replacing existing connections. */
  async connect(
    configs: McpServerConfig[],
    options: McpConnectOptions = {},
  ): Promise<void> {
    const existingNames = new Set([
      ...this.servers.keys(),
      ...this.disabledServers.keys(),
    ]);
    const newNames = new Set(configs.map((config) => config.name));
    for (const name of this.servers.keys()) {
      if (!newNames.has(name)) await this.disconnectServer(name);
    }
    for (const name of this.disabledServers.keys()) {
      if (!newNames.has(name)) this.disabledServers.delete(name);
    }
    await Promise.all(
      configs.map(async (cfg) => {
        if (cfg.disabled) {
          await this.disconnectServer(cfg.name);
          this.disabledServers.set(cfg.name, cfg);
          return;
        }
        this.disabledServers.delete(cfg.name);
        const isInteractive = options.interactiveServerNames
          ? options.interactiveServerNames.has(cfg.name)
          : Boolean(
              options.interactiveForNewServers && !existingNames.has(cfg.name),
            );
        await this.connectServer(cfg, {
          authMode: isInteractive ? "interactive" : "noninteractive",
          trigger: options.trigger ?? "startup",
          userInitiated: options.userInitiated ?? false,
        });
      }),
    );
    this.onStatusChange?.(this.getServerInfos());
  }

  private createCatalogRefreshState(): Record<
    McpCatalogKind,
    CatalogRefreshState
  > {
    return {
      tools: { running: false, dirty: false },
      resources: { running: false, dirty: false },
      prompts: { running: false, dirty: false },
    };
  }

  private async walkCatalog<T>(
    entry: ConnectedServer,
    kind: McpCatalogKind,
    loadPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
  ): Promise<T[]> {
    const items: T[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < MAX_MCP_CATALOG_PAGES; page += 1) {
      const result = await loadPage(cursor);
      const remaining = MAX_MCP_CATALOG_ITEMS - items.length;
      items.push(...result.items.slice(0, remaining));
      if (result.items.length > remaining) {
        this.log(
          `[mcp:${entry.name}] ${kind} catalog reached ${MAX_MCP_CATALOG_ITEMS} item safety limit; retaining collected items`,
        );
        return items;
      }

      const nextCursor = result.nextCursor;
      if (!nextCursor) return items;
      if (seenCursors.has(nextCursor)) {
        this.log(
          `[mcp:${entry.name}] ${kind} catalog repeated cursor '${nextCursor.slice(0, 120)}'; retaining collected items`,
        );
        return items;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    this.log(
      `[mcp:${entry.name}] ${kind} catalog reached ${MAX_MCP_CATALOG_PAGES} page safety limit; retaining collected items`,
    );
    return items;
  }

  private async getSchemaValidator(): Promise<McpSchemaValidatorProvider> {
    if (!this.schemaValidator) {
      const { AjvJsonSchemaValidator } =
        await import("@modelcontextprotocol/sdk/validation/ajv");
      this.schemaValidator = new AjvJsonSchemaValidator();
    }
    return this.schemaValidator;
  }

  private async loadCatalog(
    entry: ConnectedServer,
    kind: McpCatalogKind,
  ): Promise<
    | {
        tools: ToolDefinition[];
        parallelSafeToolNames: Set<string>;
        outputValidators: Map<string, McpOutputValidator>;
      }
    | McpResource[]
    | McpPrompt[]
  > {
    if (kind === "tools") {
      const tools = await this.walkCatalog<Tool>(
        entry,
        kind,
        async (cursor) => {
          const result = await entry.client.listTools(
            cursor ? { cursor } : undefined,
          );
          return { items: result.tools, nextCursor: result.nextCursor };
        },
      );
      const outputValidators = new Map<string, McpOutputValidator>();
      const toolsWithOutputSchema = tools.filter((tool) => tool.outputSchema);
      const schemaValidator =
        toolsWithOutputSchema.length > 0
          ? await this.getSchemaValidator()
          : undefined;
      for (const tool of toolsWithOutputSchema) {
        if (tool.outputSchema && schemaValidator) {
          outputValidators.set(
            tool.name,
            schemaValidator.getValidator<Record<string, unknown>>(
              tool.outputSchema,
            ),
          );
        }
      }
      return {
        tools: tools.map((tool) => ({
          name: `${entry.name}__${tool.name}`,
          description: tool.description ?? tool.name,
          input_schema: (tool.inputSchema ?? {
            type: "object",
            properties: {},
          }) as JsonSchema,
        })),
        parallelSafeToolNames: new Set(
          tools
            .filter((tool) => tool.annotations?.readOnlyHint === true)
            .map((tool) => tool.name),
        ),
        outputValidators,
      };
    }

    if (kind === "resources") {
      const resources = await this.walkCatalog<Resource>(
        entry,
        kind,
        async (cursor) => {
          const result = await entry.client.listResources(
            cursor ? { cursor } : undefined,
          );
          return { items: result.resources, nextCursor: result.nextCursor };
        },
      );
      return resources.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      }));
    }

    const prompts = await this.walkCatalog<Prompt>(
      entry,
      kind,
      async (cursor) => {
        const result = await entry.client.listPrompts(
          cursor ? { cursor } : undefined,
        );
        return { items: result.prompts, nextCursor: result.nextCursor };
      },
    );
    return prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments,
    }));
  }

  private async refreshCatalog(
    entry: ConnectedServer,
    kind: McpCatalogKind,
    publish: boolean,
  ): Promise<boolean> {
    try {
      const catalog = await this.loadCatalog(entry, kind);
      if (this.servers.get(entry.name) !== entry) return false;
      if (kind === "tools") {
        const toolCatalog = catalog as {
          tools: ToolDefinition[];
          parallelSafeToolNames: Set<string>;
          outputValidators: Map<string, McpOutputValidator>;
        };
        entry.tools = toolCatalog.tools;
        entry.parallelSafeToolNames = toolCatalog.parallelSafeToolNames;
        entry.outputValidators = toolCatalog.outputValidators;
      } else if (kind === "resources") {
        entry.resources = catalog as McpResource[];
      } else entry.prompts = catalog as McpPrompt[];
      if (publish) this.onStatusChange?.(this.getServerInfos());
      return true;
    } catch (error) {
      this.log(
        `[mcp:${entry.name}] failed to refresh ${kind} catalog; retaining previous snapshot: ${this.describeError(error)}`,
      );
      return false;
    }
  }

  private scheduleCatalogRefresh(
    entry: ConnectedServer,
    kind: McpCatalogKind,
  ): void {
    if (this.servers.get(entry.name) !== entry) return;
    const state = entry.catalogRefresh[kind];
    state.dirty = true;
    if (state.running || state.scheduled) return;
    state.scheduled = setTimeout(() => {
      state.scheduled = undefined;
      void this.drainCatalogRefresh(entry, kind);
    }, 0);
  }

  private async drainCatalogRefresh(
    entry: ConnectedServer,
    kind: McpCatalogKind,
  ): Promise<void> {
    const state = entry.catalogRefresh[kind];
    if (state.running) return;
    state.running = true;
    try {
      while (state.dirty && this.servers.get(entry.name) === entry) {
        state.dirty = false;
        await this.refreshCatalog(entry, kind, true);
      }
    } finally {
      state.running = false;
    }
  }

  private resolveAuthMode(
    cfg: McpServerConfig,
    authMode: McpAuthMode,
  ): McpAuthMode {
    return authMode === "interactive" ||
      (this.interactiveAuthUseCounts.get(cfg.name) ?? 0) > 0
      ? "interactive"
      : "noninteractive";
  }

  private async withInteractiveAuthForUse<T>(
    serverName: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const current = this.interactiveAuthUseCounts.get(serverName) ?? 0;
    this.interactiveAuthUseCounts.set(serverName, current + 1);
    try {
      return await fn();
    } finally {
      const next = (this.interactiveAuthUseCounts.get(serverName) ?? 1) - 1;
      if (next > 0) {
        this.interactiveAuthUseCounts.set(serverName, next);
      } else {
        this.interactiveAuthUseCounts.delete(serverName);
      }
    }
  }

  private async connectServer(
    cfg: McpServerConfig,
    options: ConnectServerOptions = {},
  ): Promise<void> {
    if (!(await this.configIsCurrent(cfg))) {
      this.disabledServers.delete(cfg.name);
      await this.disconnectServer(cfg.name);
      this.onStatusChange?.(this.getServerInfos());
      return;
    }
    const retryCount = options.retryCount ?? 0;
    const afterAuth = options.afterAuth ?? false;
    const authMode = this.resolveAuthMode(
      cfg,
      options.authMode ?? "noninteractive",
    );
    const attemptId = randomUUID();
    const rootAttemptId = options.rootAttemptId ?? attemptId;
    const trigger = options.trigger ?? "startup";
    const serverIdentityHash = cfg.url
      ? mcpServerIdentityHash(cfg.name, cfg.url)
      : "stdio";
    const authorizationAttempt: McpAuthorizationAttempt = {
      serverName: cfg.name,
      serverUrl: cfg.url ?? "",
      serverIdentityHash,
      trigger,
      userInitiated: options.userInitiated ?? false,
      authMode,
      attemptId,
      rootAttemptId,
      parentAttemptId: options.parentAttemptId,
      retryCount,
      hubScope: this.options.hubScope,
      hubGeneration: this.options.hubGeneration,
      tokenGenerationBefore:
        await this.authCoordinator.readTokenGeneration(serverIdentityHash),
    };
    const existing = this.servers.get(cfg.name);
    if (existing?.status === "connected") return;
    if (existing?.status === "connecting") {
      this.log(`[mcp:${cfg.name}] skip connect; already connecting`);
      return;
    }

    if (
      this.authCoordinator.isManualReauthRequired(serverIdentityHash) &&
      !afterAuth &&
      !authorizationAttempt.userInitiated
    ) {
      this.log(
        `[mcp:${cfg.name}] manual reauthenticate required; skipping auto-connect`,
      );
      return;
    }

    // Cancel any pending retry
    if (existing?.retryTimer) clearTimeout(existing.retryTimer);

    // Get or create OAuth provider for HTTP servers
    let oauthProvider: McpOAuthProvider | undefined;
    const isHttpServer =
      cfg.type === "sse" ||
      cfg.type === "streamable-http" ||
      cfg.type === "http";
    if (isHttpServer && cfg.url && this.globalState) {
      oauthProvider = this.oauthProviders.get(cfg.name);
      if (!oauthProvider) {
        oauthProvider = new McpOAuthProvider(
          cfg.name,
          cfg.url,
          this.globalState,
        );
        oauthProvider.onLog = (message) => this.log(message);
        oauthProvider.onBeforeAuthorizationOpen = (request) =>
          this.onBeforeAuthorizationOpen(request);
        oauthProvider.onTokensSaved = async (request) => {
          await this.authCoordinator.incrementTokenGeneration(
            request.serverIdentityHash,
          );
        };
        oauthProvider.readTokenGeneration = (identity) =>
          this.authCoordinator.readTokenGeneration(identity);
        oauthProvider.onAuthEvent = (event) =>
          this.authCoordinator.record(event);
        this.oauthProviders.set(cfg.name, oauthProvider);
      }
      oauthProvider.authorizationAttempt = authorizationAttempt;
      oauthProvider.suppressRefreshTokenReauthPrompt = !afterAuth;
      await oauthProvider.start();
    }

    const entry: ConnectedServer = {
      name: cfg.name,
      config: cfg,
      client: undefined as unknown as Client,
      tools: [],
      parallelSafeToolNames: new Set(),
      outputValidators: new Map(),
      resources: [],
      prompts: [],
      catalogRefresh: this.createCatalogRefreshState(),
      status: "connecting",
      retryCount,
    };
    entry.client = new Client(
      { name: "agentlink", title: "AgentLink", version: this.clientVersion },
      {
        capabilities: {
          elicitation: { form: { applyDefaults: true }, url: {} },
        },
        listChanged: {
          tools: {
            autoRefresh: false,
            onChanged: () => this.scheduleCatalogRefresh(entry, "tools"),
          },
          resources: {
            autoRefresh: false,
            onChanged: () => this.scheduleCatalogRefresh(entry, "resources"),
          },
          prompts: {
            autoRefresh: false,
            onChanged: () => this.scheduleCatalogRefresh(entry, "prompts"),
          },
        },
      },
    );
    this.servers.set(cfg.name, entry);
    this.onStatusChange?.(this.getServerInfos());

    try {
      const transport = this.createTransport(cfg, oauthProvider);

      // Reconnect on unexpected close (only after a successful connected state).
      transport.onclose = () => {
        const current = this.servers.get(cfg.name);
        if (!current || current.status === "disconnected") return;
        if (current.status !== "connected") {
          this.log(
            `[mcp:${cfg.name}] transport closed while status=${current.status}; skipping onclose reconnect`,
          );
          return;
        }
        current.status = "disconnected";
        this.onStatusChange?.(this.getServerInfos());
        this.scheduleReconnect(
          cfg,
          (current.retryCount ?? 0) + 1,
          "transport-error",
        );
      };

      // Register elicitation handler
      entry.client.setRequestHandler(ElicitRequestSchema, async (req) => {
        const params = (req as { params: unknown }).params as {
          mode?: string;
          message?: string;
          elicitationId?: string;
          url?: string;
          task?: { ttl?: number };
          requestedSchema?: {
            type: string;
            properties?: Record<string, unknown>;
            required?: string[];
          };
        };

        if (params.mode === "url") {
          if (!this.onUrlElicitation) {
            return { action: "decline" as const };
          }
          if (
            typeof params.url !== "string" ||
            typeof params.message !== "string" ||
            typeof params.elicitationId !== "string"
          ) {
            this.log(
              `[mcp:${cfg.name}] declined malformed URL elicitation request`,
            );
            return { action: "decline" as const };
          }
          const urlParams = params as ElicitRequestURLParams;
          const validated = validateMcpElicitationUrl(urlParams.url);
          if (!validated.ok) {
            this.log(
              `[mcp:${cfg.name}] declined URL elicitation ${urlParams.elicitationId}: ${validated.error}`,
            );
            return { action: "decline" as const };
          }

          const request: McpUrlElicitationRequest = {
            id: `url_elicit_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            serverName: cfg.name,
            message: urlParams.message,
            url: validated.value.url,
            elicitationId: urlParams.elicitationId,
            origin: validated.value.origin,
            host: validated.value.host,
            isLocalAddress: validated.value.isLocalAddress,
          };

          return new Promise((resolve) => {
            this.onUrlElicitation!(request, (action) => resolve({ action }));
          });
        }

        if (!this.onElicitation) {
          return { action: "cancel" as const };
        }
        const normalized = normalizeMcpElicitationSchema(
          params.requestedSchema,
        );
        if (!normalized.ok) {
          this.log(
            `[mcp:${cfg.name}] declined malformed form elicitation request: ${normalized.error}`,
          );
          return { action: "decline" as const };
        }
        return new Promise((resolve) => {
          this.onElicitation!(
            {
              serverName: cfg.name,
              message: params.message ?? "Please provide the required input.",
              fields: normalized.schema.fields,
            },
            (values) => resolve({ action: "accept" as const, content: values }),
            () => resolve({ action: "cancel" as const }),
          );
        });
      });

      entry.client.setNotificationHandler(
        ElicitationCompleteNotificationSchema,
        (notification) => {
          this.onUrlElicitationComplete?.(
            cfg.name,
            notification.params.elicitationId,
          );
        },
      );

      this.authCoordinator.record({
        type: "connect_start",
        serverName: cfg.name,
        serverIdentityHash,
        trigger,
        authMode,
        userInitiated: authorizationAttempt.userInitiated,
        attemptId,
        rootAttemptId,
        parentAttemptId: authorizationAttempt.parentAttemptId,
        hubScope: authorizationAttempt.hubScope,
        hubGeneration: authorizationAttempt.hubGeneration,
        retryCount,
        tokenGenerationBefore: authorizationAttempt.tokenGenerationBefore,
      });
      this.log(
        `[mcp:${cfg.name}] connect start type=${cfg.type ?? "stdio"} retryCount=${retryCount} afterAuth=${afterAuth} authMode=${authMode} trigger=${trigger} attemptId=${attemptId} rootAttemptId=${rootAttemptId}`,
      );
      if (isHttpServer && cfg.url) {
        await withHttpConnectLock(cfg.url, () =>
          entry.client.connect(transport),
        );
      } else {
        await entry.client.connect(transport);
      }
      this.log(`[mcp:${cfg.name}] connect succeeded`);
      this.authCoordinator.record({
        type: "connect_success",
        serverName: cfg.name,
        serverIdentityHash,
        trigger,
        authMode,
        userInitiated: authorizationAttempt.userInitiated,
        attemptId,
        rootAttemptId,
        parentAttemptId: authorizationAttempt.parentAttemptId,
        hubScope: authorizationAttempt.hubScope,
        hubGeneration: authorizationAttempt.hubGeneration,
        retryCount,
        tokenGenerationBefore: authorizationAttempt.tokenGenerationBefore,
        tokenGenerationAfter:
          await this.authCoordinator.readTokenGeneration(serverIdentityHash),
      });
      entry.retryCount = 0;
      this.authFailureCounts.delete(cfg.name);
      this.invalidRedirectRecoveryAttempted.delete(cfg.name);
      this.authCoordinator.clearManualReauth(serverIdentityHash);
      this.authCoordinator.clearAttempt(attemptId);
      this.runtimeReconnectPending.delete(cfg.name);

      await Promise.all(
        (["tools", "resources", "prompts"] as const).map((kind) =>
          this.refreshCatalog(entry, kind, false),
        ),
      );

      if (oauthProvider) {
        oauthProvider.suppressRefreshTokenReauthPrompt = false;
      }
      entry.status = "connected";
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const normalizedErr = errMsg.toLowerCase();
      const hasSavedTokens = Boolean(await oauthProvider?.tokens());
      this.log(
        `[mcp:${cfg.name}] connect exception details: ${this.describeError(err)}`,
      );
      this.log(
        `[mcp:${cfg.name}] connect exception context type=${cfg.type ?? "stdio"} retryCount=${retryCount} afterAuth=${afterAuth} authMode=${authMode} trigger=${trigger} attemptId=${attemptId} manualReauthRequired=${this.authCoordinator.isManualReauthRequired(serverIdentityHash)} authFailureCount=${this.authFailureCounts.get(cfg.name) ?? 0} hasSavedTokens=${hasSavedTokens}`,
      );

      // After a 401, the SDK opens the browser via redirectToAuthorization (which
      // we await fully — it completes the token exchange before returning).
      // Tokens are now saved; retry once immediately without re-triggering auth.
      const isAuthFailure = this.isAuthFailureError(err);
      if (isAuthFailure) {
        this.authCoordinator.record({
          type: "connect_auth_failure",
          serverName: cfg.name,
          serverIdentityHash,
          trigger,
          authMode,
          userInitiated: authorizationAttempt.userInitiated,
          attemptId,
          rootAttemptId,
          parentAttemptId: authorizationAttempt.parentAttemptId,
          hubScope: authorizationAttempt.hubScope,
          hubGeneration: authorizationAttempt.hubGeneration,
          retryCount,
          tokenGenerationBefore: authorizationAttempt.tokenGenerationBefore,
          errorKind: this.authErrorKind(err),
        });
        const nextCount = (this.authFailureCounts.get(cfg.name) ?? 0) + 1;
        this.authFailureCounts.set(cfg.name, nextCount);

        this.log(
          `[mcp:${cfg.name}] auth failure detected attempt=${nextCount}/${McpClientHub.MAX_AUTH_RETRIES} message=${errMsg}`,
        );

        const credentialsUpdated =
          err instanceof McpOAuthError && err.kind === "credentials_updated";
        if (credentialsUpdated) {
          this.log(
            `[mcp:${cfg.name}] credentials changed during connect; retrying silently with shared tokens`,
          );
          this.authFailureCounts.delete(cfg.name);
          await this.disconnectServer(cfg.name);
          await this.connectServer(cfg, {
            authMode: "noninteractive",
            trigger: "scheduled-retry",
            rootAttemptId,
            parentAttemptId: attemptId,
          });
          return;
        }

        const isUnauthorized = normalizedErr === "unauthorized";
        const isStaleClientRedirect =
          err instanceof McpOAuthError && err.kind === "stale_client_redirect";
        const isInvalidRedirectUri =
          this.isRedirectMismatchMessage(normalizedErr);
        if (
          (isStaleClientRedirect || isInvalidRedirectUri) &&
          !this.invalidRedirectRecoveryAttempted.has(cfg.name)
        ) {
          this.invalidRedirectRecoveryAttempted.add(cfg.name);
          this.log(
            `[mcp:${cfg.name}] attempting one-time recovery for stale/invalid redirect URI by clearing cached oauth client registration`,
          );
          try {
            await oauthProvider?.invalidateCredentials("client");
          } catch (invalidateErr) {
            this.log(
              `[mcp:${cfg.name}] failed to clear oauth client registration during redirect recovery: ${invalidateErr}`,
            );
          }
          this.authFailureCounts.delete(cfg.name);
          entry.status = "error";
          entry.error = `Authentication did not succeed for '${cfg.name}' (redirect URI/client registration mismatch). Retrying once with fresh OAuth client registration…`;
          void vscode.window.showWarningMessage(
            `AgentLink: Authentication did not succeed for '${cfg.name}' (redirect URI/client registration mismatch). Retrying once with fresh OAuth client registration…`,
          );
          this.scheduleReconnect(cfg, retryCount + 1, "auth-failure");
          this.onStatusChange?.(this.getServerInfos());
          return;
        }

        if (isUnauthorized && hasSavedTokens && !afterAuth) {
          this.log(
            `[mcp:${cfg.name}] unauthorized immediately after token save; retrying silently with saved tokens`,
          );
          this.authFailureCounts.delete(cfg.name);
          this.invalidRedirectRecoveryAttempted.delete(cfg.name);
          await this.disconnectServer(cfg.name);
          this.onStatusChange?.(this.getServerInfos());
          // Preserve the original caller intent: startup/reload retries stay
          // noninteractive, while explicit/manual/tool-use paths stay interactive.
          await this.connectServer(cfg, {
            afterAuth: true,
            authMode,
            trigger,
            userInitiated: authorizationAttempt.userInitiated,
            rootAttemptId,
            parentAttemptId: attemptId,
          });
          return;
        }

        const wasUserCancel =
          normalizedErr.includes("access_denied") ||
          normalizedErr.includes("cancel");
        const isTransientCoordinationBlock =
          normalizedErr.includes("blocked_active_lease") ||
          normalizedErr.includes("blocked_cooldown");
        if (isTransientCoordinationBlock) {
          const message = `Authentication for '${cfg.name}' is already active or recently completed in another connection. Use Reauthenticate after the active flow finishes.`;
          entry.status = "error";
          entry.error = message;
          this.authFailureCounts.delete(cfg.name);
          this.log(`[mcp:${cfg.name}] ${message}`);
          this.onStatusChange?.(this.getServerInfos());
          return;
        }

        const isManualReauthBlocked =
          normalizedErr.includes("manual reauthentication required") ||
          normalizedErr.includes("blocked_manual_reauth") ||
          normalizedErr.includes("blocked_dialog_cap");

        if (
          isManualReauthBlocked ||
          wasUserCancel ||
          nextCount >= McpClientHub.MAX_AUTH_RETRIES
        ) {
          const reason = isManualReauthBlocked
            ? "Authentication is in manual reauthenticate mode"
            : wasUserCancel
              ? "Authentication was cancelled by the user"
              : `Automatic reauthentication stopped after ${McpClientHub.MAX_AUTH_RETRIES} attempts`;
          const message = `${reason} for '${cfg.name}'. Use Reauthenticate to try again.`;
          entry.status = "error";
          entry.error = message;
          this.authFailureCounts.delete(cfg.name);
          this.authCoordinator.requireManualReauth(serverIdentityHash);
          this.showReauthenticateNotification(cfg.name, message);
          this.log(`[mcp:${cfg.name}] ${message}`);
          this.onStatusChange?.(this.getServerInfos());
          return;
        }

        entry.status = "error";
        entry.error = `Authentication did not succeed for '${cfg.name}' (attempt ${nextCount}/${McpClientHub.MAX_AUTH_RETRIES}). Retrying automatically…`;
        void vscode.window.showWarningMessage(
          `AgentLink: Authentication did not succeed for '${cfg.name}' (attempt ${nextCount}/${McpClientHub.MAX_AUTH_RETRIES}). Retrying automatically…`,
        );
        this.scheduleReconnect(cfg, retryCount + 1, "auth-failure");
      } else {
        this.log(`[mcp:${cfg.name}] non-auth error: ${errMsg}`);

        const normalizedErr = errMsg.toLowerCase();
        const hasOpenOauthDialog = authMode === "interactive";
        const isConnectTimeout =
          normalizedErr.includes("request timed out") ||
          normalizedErr.includes("timed out");

        if (isHttpServer && hasOpenOauthDialog && isConnectTimeout) {
          const message = `Authentication for '${cfg.name}' did not complete before timeout. Automatic retries are paused to avoid repeated browser prompts. Use Reauthenticate when ready.`;
          entry.status = "error";
          entry.error = message;
          this.authFailureCounts.delete(cfg.name);
          this.invalidRedirectRecoveryAttempted.delete(cfg.name);
          this.authCoordinator.requireManualReauth(serverIdentityHash);
          this.showReauthenticateNotification(cfg.name, message);
          this.log(`[mcp:${cfg.name}] ${message}`);
          this.onStatusChange?.(this.getServerInfos());
          return;
        }

        this.authFailureCounts.delete(cfg.name);
        entry.status = "error";
        entry.error = errMsg;
        this.scheduleReconnect(cfg, retryCount + 1, "transport-error");
      }
    }

    this.onStatusChange?.(this.getServerInfos());
  }

  private authErrorKind(
    err: unknown,
  ): import("../telemetry/McpAuthTelemetry.js").McpAuthErrorKind {
    if (err instanceof McpOAuthError) {
      if (err.kind === "callback_timeout") return "callback_timeout";
      if (err.kind === "callback_missing_code") return "callback_missing_code";
      if (err.kind === "stale_client_redirect") return "redirect_mismatch";
      return "authorization_error";
    }
    if (err instanceof UnauthorizedError) return "unauthorized";
    const normalized = (
      err instanceof Error ? err.message : String(err)
    ).toLowerCase();
    if (normalized.includes("timeout")) return "request_timeout";
    if (normalized.includes("forbidden")) return "forbidden";
    if (normalized.includes("network")) return "network";
    return "unknown";
  }

  private isRedirectMismatchMessage(normalizedMessage: string): boolean {
    return (
      normalizedMessage.includes("invalid redirect uri") ||
      normalizedMessage.includes("redirect_uri_mismatch") ||
      normalizedMessage.includes("does not match the active redirect uri") ||
      normalizedMessage.includes("redirect uri/client registration mismatch")
    );
  }

  private isAuthFailureError(err: unknown): boolean {
    if (err instanceof UnauthorizedError) return true;
    if (err instanceof McpOAuthError) return true;
    const msg = err instanceof Error ? err.message : String(err);
    const normalized = msg.toLowerCase();
    return (
      normalized.includes("oauth timeout waiting for callback") ||
      normalized.includes("did not include an authorization code") ||
      normalized.includes("oauth authorization failed") ||
      this.isRedirectMismatchMessage(normalized)
    );
  }

  private triggerRuntimeReconnect(cfg: McpServerConfig): void {
    if (this.runtimeReconnectPending.has(cfg.name)) {
      this.log(
        `[mcp:${cfg.name}] runtime auth recovery reconnect already pending; skipping duplicate trigger`,
      );
      return;
    }

    this.runtimeReconnectPending.add(cfg.name);
    if (cfg.url) {
      this.authCoordinator.record({
        type: "runtime_reconnect",
        serverName: cfg.name,
        serverIdentityHash: mcpServerIdentityHash(cfg.name, cfg.url),
        trigger: "runtime-reconnect",
        authMode: "interactive",
        userInitiated: false,
      });
    }
    this.log(
      `[mcp:${cfg.name}] runtime auth recovery scheduling immediate reconnect`,
    );
    void (async () => {
      try {
        await this.disconnectServer(cfg.name);
        await this.connectServer(cfg, {
          authMode: "interactive",
          trigger: "runtime-reconnect",
        });
      } catch (reconnectErr) {
        this.log(
          `[mcp:${cfg.name}] runtime auth recovery reconnect failed: ${this.describeError(reconnectErr)}`,
        );
      } finally {
        this.runtimeReconnectPending.delete(cfg.name);
        this.onStatusChange?.(this.getServerInfos());
      }
    })();
  }

  private async handleRuntimeAuthFailure(
    serverName: string,
    err: unknown,
  ): Promise<string> {
    const errMsg = err instanceof Error ? err.message : String(err);
    const entry = this.servers.get(serverName);
    if (!entry) return errMsg;

    const normalizedErr = errMsg.toLowerCase();
    if (!this.isAuthFailureError(err)) {
      return errMsg;
    }

    const isStaleClientRedirect =
      err instanceof McpOAuthError && err.kind === "stale_client_redirect";
    const isInvalidRedirectUri = this.isRedirectMismatchMessage(normalizedErr);

    if (
      (isStaleClientRedirect || isInvalidRedirectUri) &&
      !this.invalidRedirectRecoveryAttempted.has(serverName)
    ) {
      this.invalidRedirectRecoveryAttempted.add(serverName);
      this.log(
        `[mcp:${serverName}] runtime auth failure indicates stale/invalid redirect URI; clearing cached oauth client registration and reconnecting`,
      );
      try {
        await this.oauthProviders
          .get(serverName)
          ?.invalidateCredentials("client");
      } catch (invalidateErr) {
        this.log(
          `[mcp:${serverName}] failed to clear oauth client registration during runtime redirect recovery: ${invalidateErr}`,
        );
      }

      this.authFailureCounts.delete(serverName);
      entry.status = "error";
      entry.error = `Authentication did not succeed for '${serverName}' (redirect URI/client registration mismatch). Retrying once with fresh OAuth client registration…`;
      this.onStatusChange?.(this.getServerInfos());
      this.triggerRuntimeReconnect(entry.config);
      return entry.error;
    }

    const wasUserCancel =
      normalizedErr.includes("access_denied") ||
      normalizedErr.includes("cancel");
    const isTransientCoordinationBlock =
      normalizedErr.includes("blocked_active_lease") ||
      normalizedErr.includes("blocked_cooldown");
    if (isTransientCoordinationBlock) {
      const message = `Authentication for '${serverName}' is already active or recently completed in another connection. Use Reauthenticate after the active flow finishes.`;
      entry.status = "error";
      entry.error = message;
      this.authFailureCounts.delete(serverName);
      this.onStatusChange?.(this.getServerInfos());
      this.log(`[mcp:${serverName}] ${message}`);
      return message;
    }

    const isManualReauthBlocked =
      normalizedErr.includes("manual reauthentication required") ||
      normalizedErr.includes("blocked_manual_reauth") ||
      normalizedErr.includes("blocked_dialog_cap");

    if (isManualReauthBlocked || wasUserCancel) {
      const reason = isManualReauthBlocked
        ? "Authentication is in manual reauthenticate mode"
        : "Authentication was cancelled by the user";
      const message = `${reason} for '${serverName}'. Use Reauthenticate to try again.`;
      entry.status = "error";
      entry.error = message;
      this.authFailureCounts.delete(serverName);
      if (entry.config.url) {
        this.authCoordinator.requireManualReauth(
          mcpServerIdentityHash(serverName, entry.config.url),
        );
      }
      this.onStatusChange?.(this.getServerInfos());
      this.showReauthenticateNotification(serverName, message);
      this.log(`[mcp:${serverName}] ${message}`);
      return message;
    }

    const message = `Authentication did not succeed for '${serverName}'. Reconnecting automatically…`;
    entry.status = "error";
    entry.error = message;
    this.authFailureCounts.delete(serverName);
    this.onStatusChange?.(this.getServerInfos());
    void vscode.window.showWarningMessage(`AgentLink: ${message}`);
    this.log(`[mcp:${serverName}] ${message}`);
    this.triggerRuntimeReconnect(entry.config);
    return message;
  }

  private scheduleReconnect(
    cfg: McpServerConfig,
    attempt: number,
    reason: "auth-failure" | "transport-error",
  ): void {
    const serverIdentity = cfg.url
      ? mcpServerIdentityHash(cfg.name, cfg.url)
      : "stdio";
    if (
      reason === "auth-failure" &&
      this.authCoordinator.isManualReauthRequired(serverIdentity)
    ) {
      this.log(
        `[mcp:${cfg.name}] not scheduling reconnect (${reason}); manual reauthenticate required`,
      );
      return;
    }

    const MAX_RETRIES = 5;
    if (attempt > MAX_RETRIES) return;
    const delay = Math.min(1000 * 2 ** (attempt - 1), 30000); // 1s, 2s, 4s, 8s, 16s, cap 30s
    const entry = this.servers.get(cfg.name);
    if (!entry) return;
    this.log(
      `[mcp:${cfg.name}] scheduling reconnect reason=${reason} attempt=${attempt} delayMs=${delay}`,
    );
    entry.retryTimer = setTimeout(() => {
      this.connectServer(cfg, {
        retryCount: attempt,
        authMode: "noninteractive",
        trigger: "scheduled-retry",
      });
    }, delay);
  }

  private createTransport(
    cfg: McpServerConfig,
    authProvider?: McpOAuthProvider,
  ) {
    const type = cfg.type ?? "stdio";

    if (type === "stdio") {
      if (!cfg.command)
        throw new Error(`Server '${cfg.name}' is stdio but missing 'command'`);
      const baseEnvironment = {
        ...inheritProcessEnv(),
        ...buildAgentExecutionEnv(),
      };
      const env =
        cfg.provenance?.kind === "agent-plugin"
          ? cfg.pluginRoot && cfg.pluginData
            ? buildAgentPluginStdioEnvironment(baseEnvironment, cfg.env, {
                pluginRoot: cfg.pluginRoot,
                pluginData: cfg.pluginData,
              })
            : (() => {
                throw new Error(
                  `Plugin MCP server '${cfg.name}' is missing its authorized root/data boundary.`,
                );
              })()
          : { ...baseEnvironment, ...cfg.env };
      return new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env,
        ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
      });
    }

    if (type === "sse") {
      if (!cfg.url)
        throw new Error(`Server '${cfg.name}' is sse but missing 'url'`);
      const isPlugin = cfg.provenance?.kind === "agent-plugin";
      if (isPlugin) {
        return new AgentPluginSseClientTransport(new URL(cfg.url), {
          authProvider,
          mcpFetch: createAgentPluginMcpFetch(
            cfg.url,
            cfg.headers,
            agentLinkLongPollingFetch,
          ),
          oauthFetch: agentLinkLongPollingFetch,
        });
      }
      const headers: Record<string, string> = {};
      if (cfg.headers) Object.assign(headers, cfg.headers);
      return new SSEClientTransport(new URL(cfg.url), {
        authProvider,
        fetch: agentLinkLongPollingFetch,
        requestInit: Object.keys(headers).length ? { headers } : undefined,
      });
    }

    if (type === "streamable-http" || type === "http") {
      if (!cfg.url)
        throw new Error(
          `Server '${cfg.name}' is streamable-http but missing 'url'`,
        );
      const isPlugin = cfg.provenance?.kind === "agent-plugin";
      const headers: Record<string, string> = {};
      if (!isPlugin && cfg.headers) Object.assign(headers, cfg.headers);
      return new StreamableHTTPClientTransport(new URL(cfg.url), {
        authProvider,
        fetch: isPlugin
          ? createAgentPluginMcpFetch(
              cfg.url,
              cfg.headers,
              agentLinkLongPollingFetch,
            )
          : agentLinkLongPollingFetch,
        requestInit: Object.keys(headers).length ? { headers } : undefined,
      });
    }

    throw new Error(
      `Unknown transport type '${type}' for server '${cfg.name}'`,
    );
  }

  private async disconnectServer(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry) return;
    this.runtimeReconnectPending.delete(name);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    for (const state of Object.values(entry.catalogRefresh)) {
      if (state.scheduled) clearTimeout(state.scheduled);
      state.scheduled = undefined;
      state.dirty = false;
    }
    entry.status = "disconnected";
    try {
      await entry.client.close();
    } catch {
      // best effort
    }
    this.servers.delete(name);
    this.oauthProviders.get(name)?.stop();
    this.oauthProviders.delete(name);
  }

  private async configIsCurrent(
    config: Readonly<McpServerConfig>,
  ): Promise<boolean> {
    return (await this.options.isConfigCurrent?.(config)) ?? true;
  }

  /** Return the stored config for a connected or disabled server. */
  getServerConfig(
    serverName: string,
  ): import("./mcpConfig.js").McpServerConfig | undefined {
    return (
      this.servers.get(serverName)?.config ??
      this.disabledServers.get(serverName)
    );
  }

  /** Whether a server has explicitly opted into concurrent tool calls. */
  supportsParallelToolCalls(serverName: string): boolean {
    return this.getServerConfig(serverName)?.supportsParallelToolCalls === true;
  }

  /**
   * Whether one MCP tool may overlap other parallel-safe calls. A server-wide
   * opt-in wins; otherwise trust the protocol's explicit read-only annotation.
   */
  isToolParallelSafe(serverName: string, toolName: string): boolean {
    return (
      this.supportsParallelToolCalls(serverName) ||
      (this.servers.get(serverName)?.parallelSafeToolNames.has(toolName) ??
        false)
    );
  }

  /** Connected servers that explicitly permit concurrent tool calls. */
  getParallelToolCallServerNames(): string[] {
    return Array.from(this.servers.values())
      .filter(
        (server) =>
          server.status === "connected" &&
          server.config.supportsParallelToolCalls === true,
      )
      .map((server) => server.name);
  }

  /**
   * Clear stored OAuth tokens for a server (e.g. before /mcp-refresh when
   * auth is suspected to be broken).
   */
  async clearServerTokens(name: string): Promise<void> {
    await this.oauthProviders.get(name)?.clearTokens();
  }

  /** Disable a server in-memory. Callers must persist the config separately. */
  async disableServer(name: string): Promise<void> {
    const config = this.getServerConfig(name);
    await this.disconnectServer(name);
    if (config) this.disabledServers.set(name, { ...config, disabled: true });
    this.onStatusChange?.(this.getServerInfos());
  }

  /** Reconnect a server by name using its stored config. */
  async reconnectServer(name: string): Promise<void> {
    const entry = this.servers.get(name);
    const cfg = entry?.config;
    if (!cfg) return;
    this.authFailureCounts.delete(name);
    this.invalidRedirectRecoveryAttempted.delete(name);
    this.runtimeReconnectPending.delete(name);
    if (cfg.url) {
      this.authCoordinator.clearManualReauth(
        mcpServerIdentityHash(cfg.name, cfg.url),
      );
    }
    await this.disconnectServer(name);
    await this.connectServer(cfg, {
      authMode: "noninteractive",
      trigger: "manual-reconnect",
      userInitiated: true,
    });
    this.onStatusChange?.(this.getServerInfos());
  }

  /** Force a fresh OAuth browser flow then reconnect. */
  async reauthenticateServer(name: string): Promise<void> {
    const entry = this.servers.get(name);
    const cfg = entry?.config;
    if (!cfg) return;

    this.authFailureCounts.delete(name);
    this.invalidRedirectRecoveryAttempted.delete(name);
    this.runtimeReconnectPending.delete(name);
    const serverIdentityHash = cfg.url
      ? mcpServerIdentityHash(cfg.name, cfg.url)
      : "stdio";
    this.authCoordinator.clearManualReauth(serverIdentityHash);
    await this.disconnectServer(name);

    const isHttpServer =
      cfg.type === "sse" ||
      cfg.type === "streamable-http" ||
      cfg.type === "http";
    if (isHttpServer && cfg.url && this.globalState) {
      // Create a fresh provider with a clean slate, run the full browser flow
      const provider = new McpOAuthProvider(
        cfg.name,
        cfg.url,
        this.globalState,
      );
      provider.onLog = (message) => this.log(message);
      provider.onBeforeAuthorizationOpen = (request) =>
        this.onBeforeAuthorizationOpen(request);
      provider.onTokensSaved = async (request) => {
        await this.authCoordinator.incrementTokenGeneration(
          request.serverIdentityHash,
        );
      };
      provider.readTokenGeneration = (identity) =>
        this.authCoordinator.readTokenGeneration(identity);
      provider.onAuthEvent = (event) => this.authCoordinator.record(event);
      const attemptId = randomUUID();
      provider.authorizationAttempt = {
        serverName: cfg.name,
        serverUrl: cfg.url,
        serverIdentityHash,
        trigger: "manual-reauth",
        userInitiated: true,
        authMode: "interactive",
        attemptId,
        rootAttemptId: attemptId,
        retryCount: 0,
        hubScope: this.options.hubScope,
        hubGeneration: this.options.hubGeneration,
        tokenGenerationBefore:
          await this.authCoordinator.readTokenGeneration(serverIdentityHash),
      };
      await provider.start();
      try {
        await withHttpConnectLock(cfg.url, () => provider.forceReauth());
      } catch (err) {
        provider.stop();
        throw err;
      }
      // Keep the callback server alive for the immediate reconnect handoff.
      // connectServer reuses this provider and avoids callback redirectUrl churn.
      this.oauthProviders.set(cfg.name, provider);
    }

    try {
      // forceReauth already completed an explicit browser flow. If the freshly
      // saved tokens are still rejected during reconnect, suppress another
      // automatic fallback prompt and enter manual reauth mode instead.
      await this.connectServer(cfg, {
        authMode: "interactive",
        trigger: "manual-reauth",
        userInitiated: true,
      });
    } finally {
      const current = this.servers.get(cfg.name);
      if (!current || current.status !== "connected") {
        this.oauthProviders.get(cfg.name)?.stop();
      }
    }
    this.onStatusChange?.(this.getServerInfos());
  }

  /** Disconnect all servers. */
  async disconnectAll(): Promise<void> {
    await Promise.all(
      Array.from(this.servers.keys()).map((n) => this.disconnectServer(n)),
    );
    this.disabledServers.clear();
    this.onStatusChange?.(this.getServerInfos());
  }

  /** All tool definitions from connected servers (prefixed). */
  getToolDefs(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const server of this.servers.values()) {
      if (server.status === "connected") tools.push(...server.tools);
    }
    return tools;
  }

  /** Tools explicitly annotated read-only by their MCP servers. */
  getReadOnlyToolDefs(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const server of this.servers.values()) {
      if (server.status !== "connected") continue;
      tools.push(
        ...server.tools.filter((tool) => {
          const parsed = parseMcpToolName(tool.name);
          return Boolean(
            parsed && server.parallelSafeToolNames.has(parsed.bareToolName),
          );
        }),
      );
    }
    return tools;
  }

  /** Whether a tool is explicitly annotated read-only by its MCP server. */
  isToolReadOnly(serverName: string, toolName: string): boolean {
    return (
      this.servers.get(serverName)?.parallelSafeToolNames.has(toolName) ?? false
    );
  }

  /** Get tool names only (for mode filtering). */
  getToolNames(): string[] {
    return this.getToolDefs().map((t) => t.name);
  }

  /** All resources from connected servers, keyed as `servername__uri`. */
  getAllResources(): Array<McpResource & { serverName: string }> {
    const resources: Array<McpResource & { serverName: string }> = [];
    for (const server of this.servers.values()) {
      if (server.status === "connected") {
        for (const r of server.resources) {
          resources.push({ ...r, serverName: server.name });
        }
      }
    }
    return resources;
  }

  /** All prompts from connected servers. */
  getAllPrompts(): Array<McpPrompt & { serverName: string }> {
    const prompts: Array<McpPrompt & { serverName: string }> = [];
    for (const server of this.servers.values()) {
      if (server.status === "connected") {
        for (const p of server.prompts) {
          prompts.push({ ...p, serverName: server.name });
        }
      }
    }
    return prompts;
  }

  getServerInfos(): McpServerInfo[] {
    return [
      ...Array.from(this.servers.values()).map((server) => ({
        name: server.name,
        status: server.status,
        error: server.error,
        toolCount: server.tools.length,
        resourceCount: server.resources.length,
        promptCount: server.prompts.length,
        tools: server.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
      })),
      ...Array.from(this.disabledServers.values()).map((config) => ({
        name: config.name,
        status: "disabled" as const,
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
        tools: [],
      })),
    ];
  }

  /**
   * Dispatch a tool call to the appropriate MCP server.
   * Returns full ToolResult including image content where applicable.
   */
  async callTool(
    prefixedName: string,
    input: Record<string, unknown>,
    options?: Pick<RequestOptions, "signal"> & {
      readonly authorizedByCaller?: boolean;
    },
  ): Promise<ToolResult> {
    const parsed = parseMcpToolName(prefixedName);
    if (!parsed) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Invalid MCP tool name: ${prefixedName}`,
            }),
          },
        ],
      };
    }

    const { serverName, bareToolName: toolName } = parsed;
    const server = this.servers.get(serverName);

    if (!server || server.status !== "connected") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `MCP server '${serverName}' is not connected`,
            }),
          },
        ],
      };
    }

    if (!(await this.configIsCurrent(server.config))) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `MCP server '${serverName}' is no longer authorized by the current plugin catalog`,
            }),
          },
        ],
        isError: true,
        error: {
          kind: "mcp_catalog_changed",
          message: `MCP server '${serverName}' is no longer current.`,
        },
      };
    }

    const authorization =
      (await this.options.onBeforeToolCall?.({
        serverName,
        bareToolName: toolName,
        input,
        config: server.config,
        approvedByCaller: options?.authorizedByCaller === true,
      })) ?? "allow";
    if (authorization !== "allow") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `MCP tool '${prefixedName}' is not authorized by the current policy`,
            }),
          },
        ],
        isError: true,
        error: {
          kind: "mcp_tool_not_authorized",
          message: `MCP tool '${prefixedName}' is not authorized.`,
        },
      };
    }

    const timeout = resolveMcpRequestTimeout(server.config.timeout);
    try {
      const result = await this.withInteractiveAuthForUse(serverName, () =>
        server.client.callTool(
          {
            name: toolName,
            arguments: input,
          },
          undefined,
          {
            ...options,
            timeout,
            onprogress: () => {},
            resetTimeoutOnProgress: true,
          },
        ),
      );
      if (!isCallToolResult(result)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error:
                  "MCP server returned a task-based tool result, which AgentLink does not support.",
              }),
            },
          ],
          isError: true,
          error: {
            kind: "mcp_tool_error",
            message:
              "MCP server returned an unsupported task-based tool result.",
          },
        };
      }
      const outputValidator = server.outputValidators.get(toolName);
      if (outputValidator && !result.isError) {
        if (!result.structuredContent) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `MCP tool '${toolName}' declares an output schema but returned no structured content.`,
                }),
              },
            ],
            isError: true,
            error: {
              kind: "mcp_protocol_error",
              message: `MCP tool '${toolName}' returned no structured content.`,
            },
          };
        }
        const validation = outputValidator(result.structuredContent);
        if (!validation.valid) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `MCP tool '${toolName}' returned structured content that does not match its output schema.`,
                  details: validation.errorMessage,
                }),
              },
            ],
            isError: true,
            error: {
              kind: "mcp_protocol_error",
              message: `MCP tool '${toolName}' returned invalid structured content.`,
            },
          };
        }
      }
      return normalizeMcpToolResult(result, (message) =>
        this.log(`[mcp:${serverName}] ${message}`),
      );
    } catch (err) {
      if (options?.signal?.aborted) {
        return unknownCompletionResult(
          "mcp_request_cancelled",
          serverName,
          toolName,
          `MCP tool '${toolName}' was cancelled.`,
        );
      }
      const transportFailure = describeMcpTransportFailure(
        err,
        serverName,
        toolName,
        timeout,
      );
      if (transportFailure) return transportFailure;
      const outputSchemaError = describeOutputSchemaError(err, toolName);
      if (outputSchemaError) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: outputSchemaError }),
            },
          ],
          isError: true,
          error: {
            kind: "mcp_protocol_error",
            message: outputSchemaError,
          },
        };
      }
      const msg = await this.handleRuntimeAuthFailure(serverName, err);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
      };
    }
  }

  /**
   * Read a specific resource from an MCP server.
   * Pass `servername__uri` or just `uri` if serverName is provided separately.
   */
  async readResource(serverName: string, uri: string): Promise<ToolResult> {
    const server = this.servers.get(serverName);
    if (!server || server.status !== "connected") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Server '${serverName}' not connected`,
            }),
          },
        ],
      };
    }
    try {
      const result = await this.withInteractiveAuthForUse(serverName, () =>
        server.client.readResource({ uri }),
      );
      const parts: ToolResult["content"] = [];
      for (const c of result.contents) {
        if ("text" in c && c.text !== undefined) {
          parts.push({ type: "text", text: c.text });
        } else if ("blob" in c && c.blob) {
          const mime = c.mimeType ?? "";
          if (mime.startsWith("image/")) {
            parts.push({ type: "image", data: c.blob, mimeType: mime });
          } else {
            parts.push({ type: "text", text: `[Binary: ${uri}]` });
          }
        }
      }
      return { content: parts.length ? parts : [{ type: "text", text: "" }] };
    } catch (err) {
      const msg = await this.handleRuntimeAuthFailure(serverName, err);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
      };
    }
  }

  /**
   * Get a prompt from an MCP server and return its messages as text.
   */
  async getPrompt(
    serverName: string,
    promptName: string,
    args?: Record<string, string>,
  ): Promise<ToolResult> {
    const server = this.servers.get(serverName);
    if (!server || server.status !== "connected") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `Server '${serverName}' not connected`,
            }),
          },
        ],
      };
    }
    try {
      const result = await this.withInteractiveAuthForUse(serverName, () =>
        server.client.getPrompt({
          name: promptName,
          arguments: args,
        }),
      );
      const text = result.messages
        .map((m) => {
          const content =
            m.content.type === "text" ? m.content.text : `[${m.content.type}]`;
          return `${m.role}: ${content}`;
        })
        .join("\n\n");
      return { content: [{ type: "text", text: text || "" }] };
    } catch (err) {
      const msg = await this.handleRuntimeAuthFailure(serverName, err);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
      };
    }
  }

  /** True if a tool name belongs to an MCP server (contains '__'). */
  static isMcpTool(name: string): boolean {
    return isMcpToolName(name);
  }
}
