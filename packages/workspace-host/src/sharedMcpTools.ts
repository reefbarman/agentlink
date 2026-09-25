import {
  defineTool,
  type AgentPrincipal,
  type CoreModelJsonSchema,
  type HostTool,
  type HostToolResolveRequest,
  type HostToolResolution,
} from "@agentlink/core";
import {
  authorizeMcpToolCall,
  McpClientHub,
  McpOperationRegistry,
  type McpServerInfo,
  type NodeHostMcpFormElicitationHandler,
  type McpHubOAuthProvider,
  type McpHubRequestContext,
  type McpNativeConnectionRequest,
  type McpServerConfig,
} from "@agentlink/node-host";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual } from "node:crypto";
import { parseMcpToolName } from "@agentlink/protocol/mcp-tool-identity";
import { validateAndCoerceMcpElicitationValues } from "@agentlink/protocol/mcp-elicitation";
import type { ToolResult } from "@agentlink/protocol/tool-result";

export interface WorkspaceSharedMcpAdmissionProposal {
  readonly kind: "shared_mcp_project_admission";
  readonly serverId: string;
  readonly projectRoot: string;
  readonly transport: "stdio" | "sse" | "streamable-http" | "http";
  readonly command?: string;
  readonly argumentCount: number;
  readonly configuredEndpoint?: string;
  readonly environmentKeys: readonly string[];
  readonly headerNames: readonly string[];
  readonly operationDigest: string;
}

export interface WorkspaceSharedMcpLaunchProposal {
  readonly kind: "shared_mcp_stdio_launch";
  readonly serverId: string;
  readonly command: string;
  readonly argumentCount: number;
  readonly cwd: string;
  readonly environmentKeys: readonly string[];
  readonly operationDigest: string;
}

export interface WorkspaceSharedMcpNetworkProposal {
  readonly kind: "shared_mcp_network_destination";
  readonly serverId: string;
  readonly configuredEndpoint: string;
  readonly destination: string;
  readonly headerNames: readonly string[];
  readonly oauth: boolean;
  readonly operationDigest: string;
}

export interface WorkspaceSharedMcpToolApproval {
  readonly kind: "shared_mcp_tool_call";
  readonly toolName: string;
  readonly serverId: string;
  readonly serverToolName: string;
  readonly configurationDigest: string;
  readonly inputDigest: string;
  readonly operationDigest: string;
  readonly unsandboxed: true;
}

type Turn = Pick<HostToolResolveRequest, "principal" | "sessionId" | "turnId">;

export interface CreateWorkspaceSharedMcpToolsOptions {
  readonly secret: string;
  readonly resolveConfigs: () => Promise<readonly McpServerConfig[]>;
  readonly baseEnvironment: () => Record<string, string>;
  readonly fetch: typeof globalThis.fetch;
  readonly nativeFetch?: typeof globalThis.fetch;
  readonly authorizeAdmission: (
    proposal: WorkspaceSharedMcpAdmissionProposal,
    request: Turn,
  ) => Promise<boolean>;
  readonly authorizeLaunch: (
    proposal: WorkspaceSharedMcpLaunchProposal,
    request: Turn,
  ) => Promise<boolean>;
  readonly authorizeNetwork: (
    proposal: WorkspaceSharedMcpNetworkProposal,
    request: Turn,
  ) => Promise<boolean>;
  readonly createOAuthProvider?: (
    config: Readonly<McpServerConfig>,
    request: Turn,
    fetch: typeof globalThis.fetch,
  ) => Promise<McpHubOAuthProvider>;
  readonly clientVersion: string;
  readonly onElicitation?: NodeHostMcpFormElicitationHandler;
  readonly onStatus?: (message: string) => void;
  readonly onServerStatus?: (
    sessionId: string,
    servers: McpServerInfo[],
  ) => void;
}

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_RESULT_CHARS = 100_000;

function digest(secret: string, value: unknown): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(value))
    .digest("hex");
}

function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}

function publicUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function createWorkspaceSharedMcpTools(
  options: CreateWorkspaceSharedMcpToolsOptions,
) {
  const operations = new AsyncLocalStorage<Readonly<McpHubRequestContext>>();
  const sessions = new Map<
    string,
    {
      hub: McpClientHub;
      active?: Readonly<McpHubRequestContext>;
      configDigest: string;
      pending: McpOperationRegistry<Readonly<McpHubRequestContext>>;
    }
  >();
  const closeSession = async (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    if (session.active) session.pending.cancelOwner(session.active);
    session.active = undefined;
    await session.hub.disconnectAll();
  };
  const close = async () => {
    await Promise.all([...sessions.keys()].map(closeSession));
  };
  const toolApproval = async (
    toolName: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<WorkspaceSharedMcpToolApproval | undefined> => {
    const parsed = parseMcpToolName(toolName);
    if (!parsed?.serverName || !parsed.bareToolName) return undefined;
    const config = (await options.resolveConfigs()).find(
      (candidate) =>
        !candidate.disabled && candidate.name === parsed.serverName,
    );
    if (!config) return undefined;
    const serverToolName = parsed.bareToolName;
    const configurationDigest = digest(options.secret, config);
    const inputDigest = digest(options.secret, input);
    return {
      kind: "shared_mcp_tool_call",
      toolName,
      serverId: config.name,
      serverToolName,
      configurationDigest,
      inputDigest,
      operationDigest: digest(options.secret, {
        toolName,
        configurationDigest,
        inputDigest,
      }),
      unsandboxed: true,
    };
  };

  const toolPolicy = async (
    proposal: WorkspaceSharedMcpToolApproval,
  ): Promise<"allow" | "ask" | "deny"> => {
    const config = (await options.resolveConfigs()).find(
      (candidate) => candidate.name === proposal.serverId,
    );
    if (
      !config ||
      !sameDigest(
        digest(options.secret, config),
        proposal.configurationDigest,
      ) ||
      config.disabled ||
      (config.provenance?.kind !== "agent-plugin" &&
        (config.pluginRoot !== undefined || config.pluginData !== undefined))
    ) {
      return "deny";
    }
    return authorizeMcpToolCall({
      config,
      bareToolName: proposal.serverToolName,
      approved: false,
    }) === "allow"
      ? "allow"
      : "ask";
  };

  const modelResult = (result: ToolResult) => ({
    modelContent: result.content
      .map((item) => (item.type === "text" ? item.text : `[${item.type}]`))
      .join("\n")
      .slice(0, MAX_RESULT_CHARS),
    isError: result.isError,
  });

  const resolveTools = async (
    request: HostToolResolveRequest,
  ): Promise<HostToolResolution> => {
    const configs = [...(await options.resolveConfigs())];
    const fingerprint = digest(options.secret, configs);
    const existing = sessions.get(request.sessionId);
    if (existing?.active) {
      throw new Error("mcp_session_operation_already_active");
    }
    if (existing && existing.configDigest !== fingerprint) {
      await closeSession(request.sessionId);
    }
    const activeContext = () => sessions.get(request.sessionId)?.active;
    const operationContext = () => {
      const operation = operations.getStore();
      return operation && operation === activeContext() ? operation : undefined;
    };
    const current = async (config: Readonly<McpServerConfig>) =>
      (await options.resolveConfigs()).some(
        (candidate) =>
          !candidate.disabled &&
          candidate.name === config.name &&
          sameDigest(
            digest(options.secret, candidate),
            digest(options.secret, config),
          ),
      );
    const authorizeConnection = async (
      connection: McpNativeConnectionRequest,
    ) => {
      if (
        !connection.context ||
        connection.context !== operationContext() ||
        !(await current(connection.config))
      )
        return false;
      const config = connection.config;
      for (const projectRoot of config.sourceProjectRoots ?? []) {
        const approved = await options.authorizeAdmission(
          {
            kind: "shared_mcp_project_admission",
            serverId: config.name,
            projectRoot,
            transport: config.type ?? "stdio",
            command: config.command,
            argumentCount: config.args?.length ?? 0,
            configuredEndpoint: config.url ? publicUrl(config.url) : undefined,
            environmentKeys: Object.keys(config.env ?? {}).sort(),
            headerNames: Object.keys(config.headers ?? {}).sort(),
            operationDigest: digest(options.secret, { projectRoot, config }),
          },
          connection.context,
        );
        if (
          !approved ||
          connection.context !== operationContext() ||
          !(await current(config))
        ) {
          return false;
        }
      }
      if (connection.transport === "stdio") {
        if (
          connection.remoteServerUrl &&
          !(await authorizeNetwork(
            config,
            connection.remoteServerUrl,
            connection.context,
            false,
          ))
        ) {
          return false;
        }
        const approved = await options.authorizeLaunch(
          {
            kind: "shared_mcp_stdio_launch",
            serverId: config.name,
            command: connection.command,
            argumentCount: connection.args.length,
            cwd: connection.cwd ?? "",
            environmentKeys: Object.keys(connection.env).sort(),
            operationDigest: digest(options.secret, {
              config,
              command: connection.command,
              args: connection.args,
              cwd: connection.cwd,
              env: connection.env,
            }),
          },
          connection.context,
        );
        return (
          approved &&
          connection.context === operationContext() &&
          (await current(config))
        );
      }
      return await authorizeNetwork(
        config,
        connection.url,
        connection.context,
        false,
      );
    };
    const authorizeNetwork = async (
      config: Readonly<McpServerConfig>,
      destination: string,
      turn: Turn,
      oauth: boolean,
    ): Promise<boolean> => {
      if (turn !== operationContext() || !(await current(config))) return false;
      const url = new URL(destination);
      if (
        url.username ||
        url.password ||
        (oauth
          ? url.protocol !== "https:"
          : !["https:", "http:"].includes(url.protocol))
      ) {
        return false;
      }
      const approved = await options.authorizeNetwork(
        {
          kind: "shared_mcp_network_destination",
          serverId: config.name,
          configuredEndpoint: publicUrl(config.url ?? destination),
          destination: publicUrl(destination),
          headerNames: Object.keys(config.headers ?? {}).sort(),
          oauth,
          operationDigest: digest(options.secret, {
            config,
            destination,
            oauth,
          }),
        },
        turn,
      );
      return approved && turn === operationContext() && (await current(config));
    };
    const authorizedFetch =
      (
        config: Readonly<McpServerConfig>,
        oauth: boolean,
        connectionFetch?: typeof globalThis.fetch,
      ): typeof globalThis.fetch =>
      async (input, init) => {
        const destination =
          input instanceof Request ? input.url : input.toString();
        const turn = operationContext();
        if (
          !turn ||
          !(await authorizeNetwork(config, destination, turn, oauth))
        ) {
          throw new Error("mcp_remote_destination_not_authorized");
        }
        if (turn !== operationContext()) {
          throw new Error("mcp_remote_destination_not_authorized");
        }
        const requestInit = { ...init, redirect: "error" as const };
        const response = await (
          oauth
            ? options.fetch
            : (connectionFetch ?? options.nativeFetch ?? options.fetch)
        )(
          input instanceof Request ? new Request(input, requestInit) : input,
          requestInit,
        );
        if (
          response.redirected ||
          (response.status >= 300 && response.status < 400)
        ) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error("mcp_remote_redirect_not_allowed");
        }
        return response;
      };
    const pending =
      existing && existing.configDigest === fingerprint
        ? existing.pending
        : new McpOperationRegistry<Readonly<McpHubRequestContext>>();
    const hub =
      existing && existing.configDigest === fingerprint
        ? existing.hub
        : new McpClientHub(
            {
              getRequestContext: operationContext,
              authorizeNativeConnection: authorizeConnection,
              createOAuthProvider: options.createOAuthProvider
                ? async (name, url) => {
                    const config = configs.find(
                      (candidate) => candidate.name === name,
                    );
                    if (
                      !config ||
                      config.url !== url ||
                      !(await current(config))
                    ) {
                      throw new Error("mcp_oauth_server_config_changed");
                    }
                    const turn = operationContext();
                    if (!turn) throw new Error("mcp_oauth_no_active_turn");
                    return await options.createOAuthProvider!(
                      config,
                      turn,
                      authorizedFetch(config, true),
                    );
                  }
                : undefined,
              notify: async (_level, message) => {
                options.onStatus?.(message);
                return undefined;
              },
              baseEnvironment: options.baseEnvironment,
              buildPluginEnvironment: () => {
                throw new Error(
                  "Plugin MCP servers are not configured in the CLI",
                );
              },
              fetch: options.nativeFetch ?? options.fetch,
              createNativeFetch: (config, baseFetch) =>
                authorizedFetch(config, false, baseFetch),
              createPluginFetch: () => {
                throw new Error(
                  "Plugin MCP fetch is not configured in the CLI",
                );
              },
              createPluginSseTransport: () => {
                throw new Error(
                  "Plugin MCP transport is not configured in the CLI",
                );
              },
              createSchemaValidator: async () => {
                const { AjvJsonSchemaValidator } =
                  await import("@modelcontextprotocol/sdk/validation/ajv");
                return new AjvJsonSchemaValidator();
              },
            },
            options.clientVersion,
            {
              isConfigCurrent: current,
              onBeforeToolCall: ({
                context,
                config,
                bareToolName,
                approvedByCaller,
              }) =>
                context &&
                context.sessionId === activeContext()?.sessionId &&
                context.turnId === activeContext()?.turnId &&
                context.principal.tenantId ===
                  activeContext()?.principal.tenantId &&
                context.principal.subjectId ===
                  activeContext()?.principal.subjectId
                  ? authorizeMcpToolCall({
                      config,
                      bareToolName,
                      approved: approvedByCaller,
                    })
                  : "deny",
            },
          );
    const session =
      existing && existing.configDigest === fingerprint
        ? existing
        : {
            hub,
            configDigest: fingerprint,
            active: undefined as Turn | undefined,
            pending,
          };
    sessions.set(request.sessionId, session);
    session.active = request;
    hub.onStatusChange = (servers) =>
      options.onServerStatus?.(request.sessionId, servers);
    hub.onElicitation = (elicitation, resolve, cancel) => {
      const claim = pending.claim(elicitation.serverName);
      if (
        !claim ||
        claim.signal.aborted ||
        session.active !== claim.owner ||
        !options.onElicitation
      ) {
        cancel();
        return;
      }
      const owner = claim.owner;
      let settled = false;
      const finish = (values?: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        claim.signal.removeEventListener("abort", onAbort);
        if (values) resolve(values);
        else cancel();
      };
      const onAbort = () => finish();
      claim.signal.addEventListener("abort", onAbort, { once: true });
      void Promise.resolve()
        .then(() =>
          options.onElicitation!({
            ...owner,
            ...elicitation,
            signal: claim.signal,
          }),
        )
        .then(
          (response) => {
            if (claim.signal.aborted || session.active !== owner) {
              finish();
            } else if (response.action === "accept") {
              const validated = validateAndCoerceMcpElicitationValues(
                elicitation.fields,
                response.content,
              );
              finish(validated.ok ? validated.values : undefined);
            } else {
              finish();
            }
          },
          () => finish(),
        );
    };
    try {
      await operations.run(request, () =>
        hub.connect(configs, {
          interactiveForNewServers: true,
          trigger: "tool-use",
          userInitiated: true,
        }),
      );
      const validContext = async (
        context: Pick<Turn, "principal" | "sessionId" | "turnId">,
        serverName?: string,
      ) => {
        if (
          context.sessionId !== request.sessionId ||
          context.turnId !== request.turnId ||
          context.principal.tenantId !== request.principal.tenantId ||
          context.principal.subjectId !== request.principal.subjectId ||
          session.active !== request
        )
          return false;
        if (!serverName) return true;
        const config = configs.find((item) => item.name === serverName);
        return Boolean(config && (await current(config)));
      };
      const tools: HostTool<AgentPrincipal>[] = hub
        .getToolDefs()
        .filter((definition) => TOOL_NAME.test(definition.name))
        .map((definition) => {
          const [serverId, ...parts] = definition.name.split("__");
          const bareName = parts.join("__");
          return defineTool({
            name: definition.name,
            description: definition.description,
            inputSchema: definition.input_schema as CoreModelJsonSchema,
            effect: "external",
            authorization: "required",
            displayInput: () => ({ server: serverId, tool: bareName }),
            handler: async (input, context) => {
              const serverConfig = configs.find(
                (config) => config.name === serverId,
              );
              if (
                context.sessionId !== request.sessionId ||
                context.turnId !== request.turnId ||
                context.principal.tenantId !== request.principal.tenantId ||
                context.principal.subjectId !== request.principal.subjectId ||
                activeContext()?.turnId !== request.turnId ||
                !serverConfig ||
                !(await current(serverConfig))
              ) {
                return {
                  modelContent: "MCP tool context or configuration changed",
                  isError: true,
                };
              }
              const result = await pending.run(
                serverId,
                request,
                context.signal,
                () =>
                  operations.run(request, () =>
                    hub.callTool(definition.name, input, {
                      signal: context.signal,
                      authorizedByCaller: true,
                      requestContext: request,
                    }),
                  ),
              );
              const text = result.content
                .map((item) =>
                  item.type === "text" ? item.text : `[${item.type}]`,
                )
                .join("\n");
              return {
                modelContent: text.slice(0, MAX_RESULT_CHARS),
                displayContent: {
                  server: serverId,
                  tool: bareName,
                  isError: result.isError,
                },
                isError: result.isError,
              };
            },
          });
        });
      const catalog = (
        name: string,
        description: string,
        value: () => Array<{ serverName: string }>,
      ) =>
        defineTool({
          name,
          description,
          inputSchema: { type: "object", properties: {} },
          effect: "read",
          handler: async (_input, context) => {
            if (!(await validContext(context)))
              return { modelContent: "MCP turn has changed", isError: true };
            const available = await Promise.all(
              value().map(async (item) => ({
                item,
                current: await validContext(context, item.serverName),
              })),
            );
            return {
              modelContent: JSON.stringify(
                available
                  .filter((entry) => entry.current)
                  .map((entry) => entry.item),
              ).slice(0, MAX_RESULT_CHARS),
            };
          },
        });
      const read = (
        name: string,
        description: string,
        properties: CoreModelJsonSchema["properties"],
        required: string[],
        action: (
          server: string,
          input: Record<string, unknown>,
        ) => Promise<ToolResult>,
        validInput: (input: Record<string, unknown>) => boolean,
      ) =>
        defineTool({
          name,
          description,
          inputSchema: { type: "object", properties, required },
          effect: "read",
          handler: async (input, context) => {
            const server = input.server;
            if (
              typeof server !== "string" ||
              !server.trim() ||
              !validInput(input) ||
              !(await validContext(context, server))
            )
              return {
                modelContent: "MCP turn or server configuration changed",
                isError: true,
              };
            return modelResult(
              await pending.run(server, request, context.signal, () =>
                operations.run(request, () => action(server, input)),
              ),
            );
          },
        });
      tools.push(
        catalog(
          "list_mcp_resources",
          "List all resources available from connected MCP servers.",
          () => hub.getAllResources(),
        ),
        read(
          "read_mcp_resource",
          "Read a resource from an MCP server by URI.",
          { server: { type: "string" }, uri: { type: "string" } },
          ["server", "uri"],
          (server, input) => hub.readResource(server, input.uri as string),
          (input) =>
            typeof input.uri === "string" && input.uri.trim().length > 0,
        ),
        catalog(
          "list_mcp_prompts",
          "List all prompt templates available from connected MCP servers.",
          () => hub.getAllPrompts(),
        ),
        read(
          "get_mcp_prompt",
          "Get a prompt template from an MCP server, optionally filling in arguments.",
          {
            server: { type: "string" },
            name: { type: "string" },
            arguments: { type: "object" },
          },
          ["server", "name"],
          (server, input) =>
            hub.getPrompt(
              server,
              input.name as string,
              input.arguments as Record<string, string> | undefined,
            ),
          (input) =>
            typeof input.name === "string" &&
            input.name.trim().length > 0 &&
            (input.arguments === undefined ||
              (typeof input.arguments === "object" &&
                input.arguments !== null &&
                !Array.isArray(input.arguments) &&
                Object.values(input.arguments).every(
                  (value) => typeof value === "string",
                ))),
        ),
      );
      return {
        tools,
        dispose: async () => {
          if (session.active === request) {
            session.active = undefined;
            pending.cancelOwner(request);
          }
        },
      };
    } catch (error) {
      await closeSession(request.sessionId);
      throw error;
    }
  };
  return { resolveTools, toolApproval, toolPolicy, closeSession, close };
}

export function isWorkspaceSharedMcpToolApproval(
  value: unknown,
): value is WorkspaceSharedMcpToolApproval {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const display = value as Partial<WorkspaceSharedMcpToolApproval>;
  return (
    display.kind === "shared_mcp_tool_call" &&
    typeof display.toolName === "string" &&
    typeof display.serverId === "string" &&
    typeof display.serverToolName === "string" &&
    typeof display.configurationDigest === "string" &&
    typeof display.inputDigest === "string" &&
    typeof display.operationDigest === "string" &&
    display.unsandboxed === true
  );
}

export function sameWorkspaceSharedMcpToolApproval(
  left: WorkspaceSharedMcpToolApproval,
  right: WorkspaceSharedMcpToolApproval | undefined,
): boolean {
  return Boolean(
    right && sameDigest(left.operationDigest, right.operationDigest),
  );
}
