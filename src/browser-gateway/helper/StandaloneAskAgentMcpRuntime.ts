import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  CreateNodeHostMcpRemoteToolsOptions,
  CreateNodeHostMcpStdioToolsOptions,
  NodeHostMcpFormElicitationHandler,
  NodeHostMcpRemoteServer,
  NodeHostMcpResourcePromptProvider,
  NodeHostMcpStdioServer,
  ResolveNodeHostMcpRemoteOAuthProvider,
} from "@agentlink/node-host" with { "resolution-mode": "import" };
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
import { isSafeStandaloneMcpOAuthDestination } from "./standaloneMcpOAuthPolicy.js";

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
    this.resolveExecutable =
      options.resolveExecutable ??
      ((command) => resolveConfiguredExecutable(command, this.environment));
  }

  async prepareTurn(
    request: PrepareStandaloneAskAgentMcpTurnRequest,
  ): Promise<StandaloneAskAgentMcpTurn> {
    const configs = (await this.loadConfigs()).filter(
      (config) => !config.disabled && isSafeServerName(config.name),
    );
    const configByName = new Map(
      configs.map((config) => [config.name, config]),
    );
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
