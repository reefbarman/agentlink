import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";

import type {
  CreateNodeHostMcpRemoteToolsOptions,
  CreateNodeHostMcpStdioToolsOptions,
  NodeHostMcpFormElicitationHandler,
  NodeHostMcpRemoteServer,
  NodeHostMcpResourcePromptProvider,
  NodeHostMcpStdioServer,
  ResolveNodeHostMcpRemoteOAuthProvider,
} from "@agentlink/node-host" with { "resolution-mode": "import" };
import {
  McpClientHub,
  McpOperationRegistry,
  authorizeMcpToolCall,
  type McpHubHost,
} from "@agentlink/node-host";
import { StandaloneMcpHubOAuthProvider } from "./StandaloneMcpHubOAuthProvider.js";
import type {
  AgentPrincipal,
  AgentResolvedModelSelection,
  HostTool,
  HostToolResult,
} from "@agentlink/core";
import type { CoreModelToolDefinition } from "@agentlink/core/model-runtime";
import type { ToolResult } from "@agentlink/protocol/tool-result";

import {
  loadAskAgentMcpConfigs,
  type McpServerConfig,
} from "../../agent/mcpConfig.js";
import {
  CALL_MCP_TOOL_DEFINITION,
  MCP_META_TOOL_DEFINITIONS,
} from "../../shared/mcpToolDefinitions.js";
import {
  isSafeStandaloneMcpOAuthDestination,
  createStandaloneMcpOAuthPinnedFetch,
} from "./standaloneMcpOAuthPolicy.js";

const STANDALONE_MCP_PRINCIPAL: AgentPrincipal = {
  tenantId: "agentlink-desktop",
  subjectId: "ask-agent",
};
const DEFAULT_MCP_TIMEOUT_MS = 60_000;
const FIND_MCP_TOOLS_DEFINITION = MCP_META_TOOL_DEFINITIONS.find(
  (tool) => tool.name === "find_mcp_tools",
)!;
const MCP_RESOURCE_PROMPT_DEFINITIONS = MCP_META_TOOL_DEFINITIONS.filter(
  (tool) => tool.name !== "find_mcp_tools",
);

export interface StandaloneAskAgentMcpApprovalRequirement {
  readonly serverName: string;
  readonly bareToolName: string;
  readonly input: Record<string, unknown>;
}

export interface StandaloneAskAgentMcpTurn {
  readonly sessionId: string;
  readonly turnId: string;
  readonly tools: readonly CoreModelToolDefinition[];
  readonly parallelSafeToolNames: readonly string[];
  readonly parallelSafeServerNames: readonly string[];
  getApprovalRequirement?(
    toolName: string,
    input: Record<string, unknown>,
  ): StandaloneAskAgentMcpApprovalRequirement | undefined;
  execute(
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    invocation: { readonly sessionId: string; readonly turnId: string },
    approved?: boolean,
  ): Promise<ToolResult>;
}

export interface PrepareStandaloneAskAgentMcpTurnRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly signal?: AbortSignal;
  readonly onElicitation?: NodeHostMcpFormElicitationHandler;
}

interface StandaloneAskAgentMcpRuntimeOptions {
  readonly loadConfigs?: () => Promise<McpServerConfig[]>;
  readonly createStdioTools?: (
    options: CreateNodeHostMcpStdioToolsOptions,
  ) => import("@agentlink/core").HostToolResolver;
  readonly createRemoteTools?: (
    options: CreateNodeHostMcpRemoteToolsOptions,
  ) => import("@agentlink/core").HostToolResolver;
  readonly createStdioResourcePrompts?: (
    options: CreateNodeHostMcpStdioToolsOptions,
    request: import("@agentlink/node-host", {
      with: { "resolution-mode": "import" },
    }).NodeHostMcpResourcePromptContext,
  ) => Promise<NodeHostMcpResourcePromptProvider>;
  readonly createRemoteResourcePrompts?: (
    options: CreateNodeHostMcpRemoteToolsOptions,
    request: import("@agentlink/node-host", {
      with: { "resolution-mode": "import" },
    }).NodeHostMcpResourcePromptContext,
  ) => Promise<NodeHostMcpResourcePromptProvider>;
  readonly resolveExecutable?: (command: string) => Promise<string | undefined>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly temporaryDirectory?: string;
  readonly clientVersion?: string;
  readonly resolveOAuthProvider?: ResolveNodeHostMcpRemoteOAuthProvider;
  readonly createHub?: (
    host: McpHubHost,
    clientVersion: string,
    options: ConstructorParameters<typeof McpClientHub>[2],
  ) => McpClientHub;
}

/**
 * Desktop-only projectless MCP runtime. The shared Ask Agent config selects
 * servers. Tools using the default `ask` policy remain fail-closed until the
 * helper supplies explicit call authority. Browser Ask Agent keeps its existing
 * VS Code bridge.
 */
export class StandaloneAskAgentMcpRuntime {
  private readonly loadConfigs: () => Promise<McpServerConfig[]>;
  private readonly createStdioTools:
    | StandaloneAskAgentMcpRuntimeOptions["createStdioTools"]
    | undefined;
  private readonly createRemoteTools:
    | StandaloneAskAgentMcpRuntimeOptions["createRemoteTools"]
    | undefined;
  private readonly createStdioResourcePrompts:
    | StandaloneAskAgentMcpRuntimeOptions["createStdioResourcePrompts"]
    | undefined;
  private readonly createRemoteResourcePrompts:
    | StandaloneAskAgentMcpRuntimeOptions["createRemoteResourcePrompts"]
    | undefined;
  private readonly resolveExecutable: (
    command: string,
  ) => Promise<string | undefined>;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly homeDirectory: string;
  private readonly temporaryDirectory: string;
  private readonly clientVersion: string;
  private readonly resolveOAuthProvider:
    | ResolveNodeHostMcpRemoteOAuthProvider
    | undefined;
  private readonly createHub: NonNullable<
    StandaloneAskAgentMcpRuntimeOptions["createHub"]
  >;
  private readonly hubs = new Map<
    string,
    {
      hub: McpClientHub;
      fingerprint: string;
      activeTurn?: PrepareStandaloneAskAgentMcpTurnRequest;
      operations: McpOperationRegistry<PrepareStandaloneAskAgentMcpTurnRequest>;
    }
  >();
  private readonly preparations = new Map<string, Promise<void>>();
  private readonly sessionGenerations = new Map<string, number>();
  private disposed = false;
  private reauthenticating = false;
  private readonly oauthFetch = createStandaloneMcpOAuthPinnedFetch();

  constructor(options: StandaloneAskAgentMcpRuntimeOptions = {}) {
    this.loadConfigs = options.loadConfigs ?? loadAskAgentMcpConfigs;
    this.createStdioTools = options.createStdioTools;
    this.createRemoteTools = options.createRemoteTools;
    this.createStdioResourcePrompts = options.createStdioResourcePrompts;
    this.createRemoteResourcePrompts = options.createRemoteResourcePrompts;
    this.environment = options.environment ?? process.env;
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    this.temporaryDirectory = options.temporaryDirectory ?? os.tmpdir();
    this.clientVersion = options.clientVersion?.trim() || "dev";
    this.resolveOAuthProvider = options.resolveOAuthProvider;
    this.createHub =
      options.createHub ?? ((...args) => new McpClientHub(...args));
    this.resolveExecutable =
      options.resolveExecutable ??
      ((command) => resolveConfiguredExecutable(command, this.environment));
  }

  async prepareTurn(
    request: PrepareStandaloneAskAgentMcpTurnRequest,
  ): Promise<StandaloneAskAgentMcpTurn> {
    if (this.disposed) throw new Error("standalone_mcp_runtime_disposed");
    const sessionGeneration =
      this.sessionGenerations.get(request.sessionId) ?? 0;
    const configs = (await this.loadConfigs()).filter(
      (config) => !config.disabled && isSafeServerName(config.name),
    );
    const configByName = new Map(
      configs.map((config) => [config.name, config]),
    );
    if (
      !this.createStdioTools &&
      !this.createRemoteTools &&
      !this.createStdioResourcePrompts &&
      !this.createRemoteResourcePrompts
    ) {
      return this.prepareSharedTurn(request, configs, sessionGeneration);
    }
    const stdioServers = await this.resolveStdioServers(configs);
    const remoteServers = resolveRemoteServers(configs);
    const resolverRequest = {
      principal: STANDALONE_MCP_PRINCIPAL,
      sessionId: request.sessionId,
      turnId: request.turnId,
      input: { text: "", attachments: undefined },
      signal: request.signal,
    };
    const nodeHost =
      this.createStdioTools &&
      this.createRemoteTools &&
      this.createStdioResourcePrompts &&
      this.createRemoteResourcePrompts
        ? undefined
        : await import("@agentlink/node-host");
    const createStdioTools =
      this.createStdioTools ?? nodeHost!.createNodeHostMcpStdioTools;
    const createRemoteTools =
      this.createRemoteTools ?? nodeHost!.createNodeHostMcpRemoteTools;
    const createStdioResourcePrompts =
      this.createStdioResourcePrompts ??
      nodeHost!.createNodeHostMcpStdioResourcePrompts;
    const createRemoteResourcePrompts =
      this.createRemoteResourcePrompts ??
      nodeHost!.createNodeHostMcpRemoteResourcePrompts;
    const stdioOptions: CreateNodeHostMcpStdioToolsOptions = {
      resolveServers: () => stdioServers,
      authorizeLaunch: ({ server }) =>
        stdioServers.some((candidate) => sameStdioServer(candidate, server)),
      clientName: "agentlink-desktop",
      clientVersion: this.clientVersion,
      onElicitation: request.onElicitation,
    };
    const remoteOptions: CreateNodeHostMcpRemoteToolsOptions = {
      resolveServers: () => remoteServers,
      authorizeNetwork: ({ serverId, url }) =>
        remoteServers.some(
          (server) =>
            server.id === serverId &&
            safeOrigin(server.url) !== undefined &&
            safeOrigin(server.url) === url.origin,
        ),
      authorizeOAuthNetwork: async ({ serverId, url }) =>
        remoteServers.some((server) => server.id === serverId) &&
        (await isSafeStandaloneMcpOAuthDestination(url)),
      clientName: "agentlink-desktop",
      clientVersion: this.clientVersion,
      signal: request.signal,
      onElicitation: request.onElicitation,
      resolveOAuthProvider: this.resolveOAuthProvider,
    };
    const [stdioTools, stdioResources] = await waitForAbortable(
      Promise.all([
        createStdioTools(stdioOptions)(resolverRequest),
        createStdioResourcePrompts(stdioOptions, resolverRequest),
      ]),
      request.signal,
    );
    // Remote tool and resource discovery may both trigger OAuth. Run them in
    // sequence so one server cannot open competing authorization flows for the
    // same turn; the second connection reuses the credentials saved by the first.
    const remoteTools = await waitForAbortable(
      Promise.resolve(createRemoteTools(remoteOptions)(resolverRequest)),
      request.signal,
    );
    const remoteResources = await waitForAbortable(
      createRemoteResourcePrompts(remoteOptions, resolverRequest),
      request.signal,
    );
    const resourcePrompts = combineResourcePromptProviders([
      {
        provider: stdioResources,
        serverNames: stdioServers.map((server) => server.id),
      },
      {
        provider: remoteResources,
        serverNames: remoteServers.map((server) => server.id),
      },
    ]);
    const tools = deduplicateTools([...stdioTools, ...remoteTools]).filter(
      (tool) => isConfiguredTool(configByName, tool.definition.name),
    );
    const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
    const approvalByName = new Map(
      tools.map((tool) => [
        tool.definition.name,
        getConfiguredToolApproval(configByName, tool.definition.name),
      ]),
    );
    const parallelCapableServers = new Set(
      configs
        .filter((config) => config.supportsParallelToolCalls === true)
        .map((config) => config.name),
    );
    const parallelSafeServerNames = configs
      .filter(
        (config) =>
          config.supportsParallelToolCalls === true &&
          config.toolPolicy === "allow",
      )
      .map((config) => config.name);
    const model: AgentResolvedModelSelection = {
      model: { providerId: request.providerId, modelId: request.modelId },
      source: "turn",
    };

    return Object.freeze({
      sessionId: request.sessionId,
      turnId: request.turnId,
      tools: Object.freeze([
        ...tools.map((tool) => structuredClone(tool.definition)),
        structuredClone(FIND_MCP_TOOLS_DEFINITION),
        structuredClone(CALL_MCP_TOOL_DEFINITION),
        ...MCP_RESOURCE_PROMPT_DEFINITIONS.map((definition) =>
          structuredClone(definition),
        ),
      ]),
      parallelSafeToolNames: Object.freeze(
        tools
          .filter(
            (tool) =>
              approvalByName.get(tool.definition.name) === "allow" &&
              (tool.parallelSafe ||
                parallelCapableServers.has(
                  serverNameForTool(tool.definition.name),
                )),
          )
          .map((tool) => tool.definition.name),
      ),
      parallelSafeServerNames: Object.freeze(parallelSafeServerNames),
      getApprovalRequirement: (
        toolName: string,
        input: Record<string, unknown>,
      ) => {
        const call = resolveMcpToolCall(toolName, input);
        if (!call || approvalByName.get(call.toolName) !== "ask")
          return undefined;
        const names = splitMcpToolName(call.toolName);
        return names ? { ...names, input: call.input } : undefined;
      },
      execute: async (
        toolName: string,
        input: Record<string, unknown>,
        signal: AbortSignal,
        invocation: { readonly sessionId: string; readonly turnId: string },
        approved = false,
      ) => {
        if (
          invocation.sessionId !== request.sessionId ||
          invocation.turnId !== request.turnId
        ) {
          return toolError(
            "MCP tool invocation does not match the prepared turn",
          );
        }
        if (toolName === "find_mcp_tools") {
          return findMcpTools(tools, input);
        }
        if (toolName === "list_mcp_resources") {
          return jsonToolResult(resourcePrompts.listResources());
        }
        if (toolName === "read_mcp_resource") {
          const serverName = requiredInputText(input.server);
          const uri = requiredInputText(input.uri);
          if (!serverName || !uri)
            return toolError("MCP resource request is invalid");
          return await resourcePrompts.readResource({
            principal: STANDALONE_MCP_PRINCIPAL,
            ...invocation,
            signal,
            serverName,
            uri,
          });
        }
        if (toolName === "list_mcp_prompts") {
          return jsonToolResult(resourcePrompts.listPrompts());
        }
        if (toolName === "get_mcp_prompt") {
          const serverName = requiredInputText(input.server);
          const name = requiredInputText(input.name);
          const args = stringRecord(input.arguments);
          if (!serverName || !name || args === null) {
            return toolError("MCP prompt request is invalid");
          }
          return await resourcePrompts.getPrompt({
            principal: STANDALONE_MCP_PRINCIPAL,
            ...invocation,
            signal,
            serverName,
            name,
            ...(args ? { arguments: args } : {}),
          });
        }
        const call = resolveMcpToolCall(toolName, input);
        if (!call) return toolError("MCP tool request is invalid");
        const tool = byName.get(call.toolName);
        if (!tool) return toolError("MCP tool is not available");
        if (approvalByName.get(call.toolName) === "ask" && !approved) {
          return toolError("MCP tool requires user approval");
        }
        const validation = tool.validate(call.input);
        if (!validation.valid) return toolError("MCP tool input is invalid");
        const result = await tool.executeValidated(validation.input, {
          principal: STANDALONE_MCP_PRINCIPAL,
          sessionId: invocation.sessionId,
          turnId: invocation.turnId,
          model,
          signal,
        });
        return hostToolResultToToolResult(result);
      },
    });
  }

  private async prepareSharedTurn(
    request: PrepareStandaloneAskAgentMcpTurnRequest,
    configs: McpServerConfig[],
    sessionGeneration: number,
  ): Promise<StandaloneAskAgentMcpTurn> {
    const context = {
      principal: STANDALONE_MCP_PRINCIPAL,
      sessionId: request.sessionId,
      turnId: request.turnId,
    };
    // Resolving executables is intentionally done before connection approval.
    const resolved = await Promise.all(
      configs.map(async (config) => {
        if ((config.type ?? "stdio") !== "stdio" || !config.command)
          return config;
        const command = await this.resolveExecutable(config.command);
        return {
          ...config,
          command: command ?? "",
          cwd: this.homeDirectory,
        };
      }),
    );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(resolved))
      .digest("hex");
    const previous = this.preparations.get(request.sessionId);
    const isCurrent = () =>
      !this.disposed &&
      (this.sessionGenerations.get(request.sessionId) ?? 0) ===
        sessionGeneration;
    const preparation = (async () => {
      if (previous) await Promise.allSettled([previous]);
      if (!isCurrent()) throw new Error("standalone_mcp_session_disposed");
      let entry = this.hubs.get(request.sessionId);
      if (entry && entry.fingerprint !== fingerprint) {
        this.hubs.delete(request.sessionId);
        await entry.hub.disconnectAll();
        entry = undefined;
      }
      if (entry) {
        if (entry.activeTurn && entry.activeTurn !== request)
          entry.operations.cancelOwner(entry.activeTurn);
        entry.activeTurn = request;
      }
      if (!entry) {
        const operations =
          new McpOperationRegistry<PrepareStandaloneAskAgentMcpTurnRequest>();
        const configByName = new Map(
          resolved.map((config) => [config.name, config]),
        );
        const host: McpHubHost = {
          getRequestContext: () => {
            const active = this.hubs.get(request.sessionId)?.activeTurn;
            return active?.signal?.aborted
              ? undefined
              : active
                ? {
                    principal: STANDALONE_MCP_PRINCIPAL,
                    sessionId: active.sessionId,
                    turnId: active.turnId,
                  }
                : undefined;
          },
          authorizeNativeConnection: async (connection) => {
            const current = configByName.get(connection.config.name);
            if (
              !current ||
              current !== connection.config ||
              this.disposed ||
              !this.hubs.get(request.sessionId)?.activeTurn ||
              this.hubs.get(request.sessionId)?.activeTurn?.signal?.aborted
            )
              return false;
            const latest = (await this.loadConfigs()).find(
              (candidate) =>
                candidate.name === current.name && !candidate.disabled,
            );
            if (
              !latest ||
              JSON.stringify(latest) !==
                JSON.stringify(
                  configs.find((candidate) => candidate.name === current.name),
                )
            )
              return false;
            if (connection.transport === "stdio") {
              return (
                connection.command === current.command &&
                connection.cwd === this.homeDirectory &&
                JSON.stringify(connection.env) ===
                  JSON.stringify(
                    buildStandaloneMcpEnvironment(
                      this.environment,
                      current.env,
                      this.homeDirectory,
                      this.temporaryDirectory,
                    ),
                  )
              );
            }
            return (
              connection.url === current.url &&
              safeOrigin(connection.url) !== undefined
            );
          },
          createOAuthProvider: this.resolveOAuthProvider
            ? async (name, url) => {
                const config = configByName.get(name);
                if (!config || config.url !== url || !safeOrigin(url)) {
                  throw new Error("standalone_mcp_oauth_config_changed");
                }
                const active = this.hubs.get(request.sessionId)?.activeTurn;
                if (!active || active.signal?.aborted || this.disposed) {
                  throw new Error("standalone_mcp_oauth_no_active_turn");
                }
                const provider = await this.resolveOAuthProvider!({
                  principal: STANDALONE_MCP_PRINCIPAL,
                  sessionId: active.sessionId,
                  turnId: active.turnId,
                  server: {
                    id: name,
                    transport:
                      config.type === "sse" ? "sse" : "streamable-http",
                    url,
                  },
                  url: new URL(url),
                  fetch: (input, init) =>
                    this.oauthFetch.fetch(globalThis.fetch, input, init),
                });
                if (!provider)
                  throw new Error("standalone_mcp_oauth_provider_unavailable");
                return new StandaloneMcpHubOAuthProvider(
                  provider,
                  url,
                  (input, init) =>
                    this.oauthFetch.fetch(globalThis.fetch, input, init),
                  () => {
                    const currentTurn = this.hubs.get(
                      request.sessionId,
                    )?.activeTurn;
                    return (
                      !this.disposed &&
                      Boolean(currentTurn && !currentTurn.signal?.aborted)
                    );
                  },
                );
              }
            : undefined,
          notify: async () => undefined,
          baseEnvironment: () =>
            buildStandaloneMcpEnvironment(
              this.environment,
              undefined,
              this.homeDirectory,
              this.temporaryDirectory,
            ),
          buildPluginEnvironment: () => {
            throw new Error("No plugin MCP in Desktop");
          },
          fetch: globalThis.fetch,
          createNativeFetch: (config, baseFetch) => async (input, init) => {
            const current = configByName.get(config.name);
            const destination = new URL(
              input instanceof Request ? input.url : String(input),
            );
            if (
              !current ||
              current !== config ||
              safeOrigin(current.url ?? "") !== destination.origin
            ) {
              throw new Error("standalone_mcp_destination_not_authorized");
            }
            const response = await baseFetch(input, {
              ...init,
              redirect: "manual",
            });
            if (response.status >= 300 && response.status < 400) {
              await response.body?.cancel();
              throw new Error("standalone_mcp_redirect_not_authorized");
            }
            return response;
          },
          createPluginFetch: () => {
            throw new Error("No plugin MCP in Desktop");
          },
          createPluginSseTransport: () => {
            throw new Error("No plugin MCP in Desktop");
          },
          createSchemaValidator: async () => {
            const { AjvJsonSchemaValidator } =
              await import("@modelcontextprotocol/sdk/validation/ajv");
            return new AjvJsonSchemaValidator();
          },
        };
        const hub = this.createHub(host, this.clientVersion, {
          isConfigCurrent: async (config) => {
            if (this.disposed || configByName.get(config.name) !== config)
              return false;
            const latest = (await this.loadConfigs()).find(
              (candidate) =>
                candidate.name === config.name && !candidate.disabled,
            );
            return Boolean(
              latest &&
              JSON.stringify(latest) ===
                JSON.stringify(
                  configs.find((candidate) => candidate.name === config.name),
                ),
            );
          },
          onBeforeToolCall: ({ config, bareToolName, approvedByCaller }) =>
            authorizeMcpToolCall({
              config,
              bareToolName,
              approved: approvedByCaller,
            }),
        });
        hub.onElicitation = (elicitation, resolve, cancel) => {
          const claim = operations.claim(elicitation.serverName);
          const turn = claim?.owner;
          if (
            !claim ||
            !turn ||
            claim.signal.aborted ||
            turn.signal?.aborted ||
            this.hubs.get(request.sessionId)?.activeTurn !== turn ||
            !turn.onElicitation
          ) {
            cancel();
            return;
          }
          const signal = turn.signal
            ? AbortSignal.any([claim.signal, turn.signal])
            : claim.signal;
          let settled = false;
          const finish = (values?: Record<string, unknown>) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            if (values) resolve(values);
            else cancel();
          };
          const onAbort = () => finish();
          signal.addEventListener("abort", onAbort, { once: true });
          void Promise.resolve()
            .then(() =>
              turn.onElicitation!({
                ...context,
                turnId: turn.turnId,
                signal,
                ...elicitation,
              }),
            )
            .then(
              (response) => {
                if (
                  signal.aborted ||
                  this.hubs.get(request.sessionId)?.activeTurn !== turn
                )
                  finish();
                else if (response.action === "accept") finish(response.content);
                else finish();
              },
              () => finish(),
            );
        };
        entry = { hub, fingerprint, activeTurn: request, operations };
        this.hubs.set(request.sessionId, entry);
        try {
          // Connect separately to avoid simultaneous OAuth flows during discovery.
          // Retain previously configured servers so a later connect does not
          // disconnect a transport opened earlier in this session.
          const connected: McpServerConfig[] = [];
          for (const config of resolved) {
            if (!isCurrent() || request.signal?.aborted)
              throw new Error("standalone_mcp_session_disposed");
            connected.push(config);
            await hub.connect(connected, {
              interactiveServerNames: new Set([config.name]),
              trigger: "tool-use",
              userInitiated: true,
            });
            if (
              !isCurrent() ||
              request.signal?.aborted ||
              this.hubs.get(request.sessionId)?.hub !== hub
            )
              throw new Error("standalone_mcp_session_disposed");
          }
        } catch (error) {
          this.hubs.delete(request.sessionId);
          await hub.disconnectAll();
          throw error;
        }
      }
    })();
    this.preparations.set(request.sessionId, preparation);
    void preparation
      .finally(() => {
        if (this.preparations.get(request.sessionId) === preparation) {
          this.preparations.delete(request.sessionId);
        }
      })
      .catch(() => undefined);
    await waitForAbortable(preparation, request.signal);
    const hubEntry = this.hubs.get(request.sessionId);
    const hub = hubEntry?.hub;
    if (!hub || !hubEntry || this.disposed || request.signal?.aborted)
      throw new Error("standalone_mcp_session_disposed");
    const configByName = new Map(
      resolved.map((config) => [config.name, config]),
    );
    const definitions = hub.getToolDefs();
    const byName = new Map(
      definitions.map((definition) => [definition.name, definition]),
    );
    const parallelSafeServerNames = resolved
      .filter(
        (config) =>
          config.supportsParallelToolCalls && config.toolPolicy === "allow",
      )
      .map((config) => config.name);
    const approval = (name: string) =>
      getConfiguredToolApproval(configByName, name);
    const withOperation = (
      serverName: string,
      signal: AbortSignal,
      action: () => Promise<ToolResult>,
    ) => hubEntry.operations.run(serverName, request, signal, action);
    return Object.freeze({
      sessionId: request.sessionId,
      turnId: request.turnId,
      tools: Object.freeze([
        ...definitions.map((definition) => structuredClone(definition)),
        ...MCP_META_TOOL_DEFINITIONS.map((definition) =>
          structuredClone(definition),
        ),
      ]),
      parallelSafeToolNames: Object.freeze(
        definitions
          .filter((definition) => {
            const names = splitMcpToolName(definition.name);
            return (
              names &&
              approval(definition.name) === "allow" &&
              (hub.isToolReadOnly(names.serverName, names.bareToolName) ||
                configByName.get(names.serverName)
                  ?.supportsParallelToolCalls === true)
            );
          })
          .map((definition) => definition.name),
      ),
      parallelSafeServerNames: Object.freeze(parallelSafeServerNames),
      getApprovalRequirement: (
        toolName: string,
        input: Record<string, unknown>,
      ) => {
        if (
          this.hubs.get(request.sessionId)?.activeTurn !== request ||
          request.signal?.aborted
        )
          return undefined;
        const call = resolveMcpToolCall(toolName, input);
        if (
          !call ||
          !byName.has(call.toolName) ||
          approval(call.toolName) !== "ask"
        )
          return undefined;
        const names = splitMcpToolName(call.toolName);
        return names ? { ...names, input: call.input } : undefined;
      },
      execute: async (
        toolName: string,
        input: Record<string, unknown>,
        signal: AbortSignal,
        invocation: { readonly sessionId: string; readonly turnId: string },
        approved = false,
      ) => {
        if (
          invocation.sessionId !== request.sessionId ||
          invocation.turnId !== request.turnId ||
          this.hubs.get(request.sessionId)?.hub !== hub ||
          this.hubs.get(request.sessionId)?.activeTurn !== request ||
          request.signal?.aborted
        ) {
          return toolError(
            "MCP tool invocation does not match the prepared turn",
          );
        }
        if (toolName === "find_mcp_tools") {
          return findMcpToolDefinitions(definitions, input);
        }
        if (toolName === "list_mcp_resources")
          return jsonToolResult(hub.getAllResources());
        if (toolName === "list_mcp_prompts")
          return jsonToolResult(hub.getAllPrompts());
        if (toolName === "read_mcp_resource") {
          const server = requiredInputText(input.server);
          const uri = requiredInputText(input.uri);
          return server && uri
            ? withOperation(server, signal, () => hub.readResource(server, uri))
            : toolError("MCP resource request is invalid");
        }
        if (toolName === "get_mcp_prompt") {
          const server = requiredInputText(input.server);
          const name = requiredInputText(input.name);
          const args = stringRecord(input.arguments);
          return server && name && args !== null
            ? withOperation(server, signal, () =>
                hub.getPrompt(server, name, args),
              )
            : toolError("MCP prompt request is invalid");
        }
        const call = resolveMcpToolCall(toolName, input);
        if (!call || !byName.has(call.toolName))
          return toolError("MCP tool is not available");
        if (approval(call.toolName) === "ask" && !approved) {
          return toolError("MCP tool requires user approval");
        }
        const names = splitMcpToolName(call.toolName)!;
        return withOperation(names.serverName, signal, () =>
          hub.callTool(call.toolName, call.input, {
            signal,
            authorizedByCaller: approved,
            requestContext: context,
          }),
        );
      },
    });
  }

  async reauthenticateServer(
    serverName: string,
    confirm: (origin: string) => Promise<boolean>,
  ): Promise<void> {
    if (this.disposed || !this.resolveOAuthProvider)
      throw new Error("standalone_mcp_oauth_unavailable");
    if (this.reauthenticating)
      throw new Error("standalone_mcp_oauth_reauthentication_in_progress");
    this.reauthenticating = true;
    try {
      const config = (await this.loadConfigs()).find(
        (candidate) => candidate.name === serverName && !candidate.disabled,
      );
      if (
        !config?.url ||
        !["http", "sse", "streamable-http"].includes(config.type ?? "")
      )
        throw new Error("standalone_mcp_oauth_server_unavailable");
      const url = new URL(config.url);
      const origin = safeOrigin(config.url);
      if (!origin || !(await isSafeStandaloneMcpOAuthDestination(url)))
        throw new Error("standalone_mcp_oauth_destination_not_authorized");
      if (!(await confirm(origin)))
        throw new Error("standalone_mcp_oauth_reauthentication_denied");
      const latest = (await this.loadConfigs()).find(
        (candidate) => candidate.name === serverName,
      );
      if (JSON.stringify(latest) !== JSON.stringify(config))
        throw new Error("standalone_mcp_oauth_config_changed");
      const fetch: typeof globalThis.fetch = (input, init) =>
        this.oauthFetch.fetch(globalThis.fetch, input, init);
      const provider = await this.resolveOAuthProvider({
        principal: STANDALONE_MCP_PRINCIPAL,
        sessionId: "desktop-reauthenticate",
        turnId: "desktop-reauthenticate",
        server: {
          id: serverName,
          transport: config.type === "sse" ? "sse" : "streamable-http",
          url: config.url,
        },
        url,
        fetch,
      });
      if (!provider)
        throw new Error("standalone_mcp_oauth_provider_unavailable");
      await auth(
        { ...provider, tokens: async () => undefined },
        { serverUrl: url, fetchFn: fetch },
      );
      await Promise.all(
        [...this.hubs.keys()].map((sessionId) => this.retireSession(sessionId)),
      );
    } finally {
      this.reauthenticating = false;
    }
  }

  async retireSession(sessionId: string): Promise<void> {
    this.sessionGenerations.set(
      sessionId,
      (this.sessionGenerations.get(sessionId) ?? 0) + 1,
    );
    const pending = this.preparations.get(sessionId);
    if (pending) await Promise.allSettled([pending]);
    const entry = this.hubs.get(sessionId);
    this.hubs.delete(sessionId);
    if (entry) {
      if (entry.activeTurn) entry.operations.cancelOwner(entry.activeTurn);
      await entry.hub.disconnectAll();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled(this.preparations.values());
    await Promise.all(
      [...this.hubs.values()].map(({ hub, operations, activeTurn }) => {
        if (activeTurn) operations.cancelOwner(activeTurn);
        return hub.disconnectAll();
      }),
    );
    this.hubs.clear();
    await this.oauthFetch.dispose();
  }

  private async resolveStdioServers(
    configs: readonly McpServerConfig[],
  ): Promise<NodeHostMcpStdioServer[]> {
    const servers: NodeHostMcpStdioServer[] = [];
    for (const config of configs) {
      if ((config.type ?? "stdio") !== "stdio" || !config.command) continue;
      const command = await this.resolveExecutable(config.command);
      if (!command) continue;
      servers.push({
        id: config.name,
        command,
        args: Array.isArray(config.args) ? [...config.args] : [],
        cwd: this.homeDirectory,
        env: buildStandaloneMcpEnvironment(
          this.environment,
          config.env,
          this.homeDirectory,
          this.temporaryDirectory,
        ),
        timeoutMs: normalizeTimeout(config.timeout),
      });
    }
    return servers;
  }
}

function combineResourcePromptProviders(
  providers: readonly {
    readonly provider: NodeHostMcpResourcePromptProvider;
    readonly serverNames: readonly string[];
  }[],
): NodeHostMcpResourcePromptProvider {
  const byServer = (serverName: string) =>
    providers.find((entry) => entry.serverNames.includes(serverName))?.provider;
  return {
    listResources: () =>
      providers.flatMap((entry) => entry.provider.listResources()),
    listPrompts: () =>
      providers.flatMap((entry) => entry.provider.listPrompts()),
    readResource: (request) =>
      byServer(request.serverName)?.readResource(request) ??
      Promise.resolve(toolError("MCP resource server is not available")),
    getPrompt: (request) =>
      byServer(request.serverName)?.getPrompt(request) ??
      Promise.resolve(toolError("MCP prompt server is not available")),
  };
}

function resolveRemoteServers(
  configs: readonly McpServerConfig[],
): NodeHostMcpRemoteServer[] {
  return configs.flatMap((config) => {
    const type = config.type === "http" ? "streamable-http" : config.type;
    if (
      (type !== "sse" && type !== "streamable-http") ||
      !config.url ||
      !safeOrigin(config.url)
    ) {
      return [];
    }
    return [
      {
        id: config.name,
        transport: type,
        url: config.url,
        ...(config.headers ? { headers: { ...config.headers } } : {}),
        timeoutMs: normalizeTimeout(config.timeout),
      },
    ];
  });
}

function buildStandaloneMcpEnvironment(
  environment: NodeJS.ProcessEnv,
  configured: Readonly<Record<string, string>> | undefined,
  homeDirectory: string,
  temporaryDirectory: string,
): Record<string, string> {
  return {
    HOME: homeDirectory,
    TMPDIR: temporaryDirectory,
    PATH: environment.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    ...(environment.USER ? { USER: environment.USER } : {}),
    ...configured,
  };
}

async function resolveConfiguredExecutable(
  command: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const trimmed = command.trim();
  if (!trimmed || trimmed.includes("\0")) return undefined;
  const candidates = path.isAbsolute(trimmed)
    ? [trimmed]
    : (environment.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, trimmed));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching the explicitly inherited PATH.
    }
  }
  return undefined;
}

function isConfiguredTool(
  configByName: ReadonlyMap<string, McpServerConfig>,
  toolName: string,
): boolean {
  const parsed = splitMcpToolName(toolName);
  return Boolean(parsed && configByName.has(parsed.serverName));
}

function getConfiguredToolApproval(
  configByName: ReadonlyMap<string, McpServerConfig>,
  toolName: string,
): "allow" | "ask" {
  const parsed = splitMcpToolName(toolName);
  if (!parsed?.bareToolName) return "ask";
  const config = configByName.get(parsed.serverName);
  return config?.toolPolicy === "allow" ||
    config?.allowedTools?.some(
      (allowedTool) =>
        allowedTool.trim().length > 0 && allowedTool === parsed.bareToolName,
    )
    ? "allow"
    : "ask";
}

function deduplicateTools(tools: readonly HostTool[]): HostTool[] {
  const byName = new Map<string, HostTool>();
  for (const tool of tools) {
    if (!byName.has(tool.definition.name))
      byName.set(tool.definition.name, tool);
  }
  return [...byName.values()];
}

function hostToolResultToToolResult(result: HostToolResult): ToolResult {
  const content: ToolResult["content"] = [];
  if (typeof result.modelContent === "string") {
    content.push({ type: "text", text: result.modelContent });
  } else {
    for (const block of result.modelContent) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        content.push({
          type: "image",
          data: block.source.data,
          mimeType: block.source.media_type,
        });
      }
    }
  }
  const normalizedContent =
    content.length > 0 ? content : [{ type: "text" as const, text: "" }];
  return {
    content: normalizedContent,
    ...(result.displayContent !== undefined
      ? { data: result.displayContent }
      : {}),
    ...(result.isError
      ? {
          isError: true,
          error: {
            kind: "mcp_tool_error",
            message:
              normalizedContent.find(
                (
                  item,
                ): item is Extract<
                  ToolResult["content"][number],
                  { type: "text" }
                > => item.type === "text",
              )?.text || "MCP tool failed",
          },
        }
      : {}),
  };
}

function findMcpToolDefinitions(
  definitions: readonly CoreModelToolDefinition[],
  input: Record<string, unknown>,
): ToolResult {
  const query =
    typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
  const server =
    typeof input.server === "string" ? input.server.trim().toLowerCase() : "";
  const includeSchemas = input.includeSchemas === true;
  const limit = boundedInteger(input.limit, 50, 1, 200);
  const schemaLimit = includeSchemas
    ? boundedInteger(input.schemaLimit, 1, 1, 20)
    : 0;
  const matched = definitions.filter(
    (definition) =>
      (!server ||
        serverNameForTool(definition.name).toLowerCase() === server) &&
      (!query ||
        definition.name.toLowerCase().includes(query) ||
        definition.description.toLowerCase().includes(query)),
  );
  return jsonToolResult({
    tools: matched.slice(0, limit).map((definition, index) => ({
      name: definition.name,
      description: definition.description,
      ...(index < schemaLimit ? { input_schema: definition.input_schema } : {}),
    })),
    total: matched.length,
  });
}

function findMcpTools(
  tools: readonly HostTool[],
  input: Record<string, unknown>,
): ToolResult {
  const query =
    typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
  const server =
    typeof input.server === "string" ? input.server.trim().toLowerCase() : "";
  const includeSchemas = input.includeSchemas === true;
  const limit = boundedInteger(input.limit, 50, 1, 200);
  const schemaLimit = includeSchemas
    ? boundedInteger(input.schemaLimit, 1, 1, 20)
    : 0;
  const matched = tools.filter((tool) => {
    const definition = tool.definition;
    const candidateServer = serverNameForTool(definition.name).toLowerCase();
    return (
      (!server || candidateServer === server) &&
      (!query ||
        definition.name.toLowerCase().includes(query) ||
        definition.description.toLowerCase().includes(query))
    );
  });
  return jsonToolResult({
    tools: matched.slice(0, limit).map((tool, index) => ({
      name: tool.definition.name,
      description: tool.definition.description,
      ...(index < schemaLimit
        ? { input_schema: tool.definition.input_schema }
        : {}),
    })),
    total: matched.length,
  });
}

function resolveMcpToolCall(
  toolName: string,
  input: Record<string, unknown>,
): { toolName: string; input: Record<string, unknown> } | undefined {
  return toolName === "call_mcp_tool"
    ? parseCallMcpTool(input)
    : { toolName, input };
}

function splitMcpToolName(
  toolName: string,
): Omit<StandaloneAskAgentMcpApprovalRequirement, "input"> | undefined {
  const separator = toolName.indexOf("__");
  if (separator <= 0) return undefined;
  return {
    serverName: toolName.slice(0, separator),
    bareToolName: toolName.slice(separator + 2),
  };
}

function parseCallMcpTool(input: Record<string, unknown>):
  | {
      toolName: string;
      input: Record<string, unknown>;
    }
  | undefined {
  const server = typeof input.server === "string" ? input.server.trim() : "";
  const tool = typeof input.tool === "string" ? input.tool.trim() : "";
  const composedName = `${server}__${tool}`;
  if (
    !isSafeServerName(server) ||
    !/^[A-Za-z0-9_-]+$/.test(tool) ||
    composedName.length > 64
  ) {
    return undefined;
  }
  const nested = input.input;
  if (!nested || typeof nested !== "object" || Array.isArray(nested))
    return undefined;
  return {
    toolName: composedName,
    input: nested as Record<string, unknown>,
  };
}

async function waitForAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason ?? new Error("aborted");

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function jsonToolResult(payload: unknown): ToolResult {
  const serialized = JSON.stringify(payload, null, 2);
  return {
    data: JSON.parse(serialized) as unknown,
    content: [{ type: "text", text: serialized }],
  };
}

function toolError(message: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
    error: { kind: "mcp_tool_error", message },
  };
}

function sameStdioServer(
  left: Readonly<NodeHostMcpStdioServer>,
  right: Readonly<NodeHostMcpStdioServer>,
): boolean {
  return (
    left.id === right.id &&
    left.command === right.command &&
    left.cwd === right.cwd &&
    JSON.stringify(left.args) === JSON.stringify(right.args) &&
    JSON.stringify(left.env) === JSON.stringify(right.env)
  );
}

function serverNameForTool(toolName: string): string {
  const separator = toolName.indexOf("__");
  return separator > 0 ? toolName.slice(0, separator) : "";
}

function safeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.trunc(value)))
    : fallback;
}

function normalizeTimeout(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! > 0
    ? Math.min(value!, DEFAULT_MCP_TIMEOUT_MS)
    : DEFAULT_MCP_TIMEOUT_MS;
}

function requiredInputText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function stringRecord(
  value: unknown,
): Record<string, string> | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every(([, item]) => typeof item === "string")) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

function isSafeServerName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(value) && !value.includes("__");
}
