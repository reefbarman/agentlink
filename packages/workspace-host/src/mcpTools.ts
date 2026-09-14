import type { AgentPrincipal, HostToolResolver } from "@agentlink/core";
import {
  createNodeHostMcpRemoteTools,
  createNodeHostMcpStdioTools,
  type NodeHostMcpRemoteNetworkRequest,
  type NodeHostMcpRemoteServer,
  type NodeHostMcpRemoteOAuthRequest,
  type NodeHostMcpStdioLaunchRequest,
  type NodeHostMcpStdioServer,
  type ResolveNodeHostMcpRemoteOAuthProvider,
  type ResolveNodeHostMcpRemoteServersRequest,
  type ResolveNodeHostMcpStdioServersRequest,
} from "@agentlink/node-host";
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  loadWorkspaceMcpConfiguration,
  type LoadWorkspaceMcpConfigurationOptions,
  type WorkspaceMcpConfiguration,
  type WorkspaceMcpCredentialReference,
  type WorkspaceMcpRemoteDeclaration,
  type WorkspaceMcpStdioDeclaration,
} from "./mcpConfig.js";

export type WorkspaceMcpRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> = ResolveNodeHostMcpStdioServersRequest<TPrincipal>;

export interface ResolveWorkspaceMcpCredentialRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> extends WorkspaceMcpRequest<TPrincipal> {
  readonly serverId: string;
  readonly source: "global" | "project";
  readonly usage: "environment" | "header";
  readonly name: string;
  readonly credential: string;
}

export type ResolveWorkspaceMcpCredential<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> = (
  request: ResolveWorkspaceMcpCredentialRequest<TPrincipal>,
) => string | Promise<string>;

export interface WorkspaceMcpLaunchProposal {
  readonly kind: "mcp_stdio_launch";
  readonly serverId: string;
  readonly source: "global" | "project";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environmentKeys: readonly string[];
  readonly credentialIds: readonly string[];
  readonly timeoutMs?: number;
  readonly unsandboxed: true;
  /** HMAC over the complete resolved launch, including secret values. */
  readonly operationDigest: string;
}

export interface WorkspaceMcpNetworkProposal {
  readonly kind: "mcp_network_destination";
  readonly serverId: string;
  readonly source: "global" | "project";
  readonly configuredEndpoint: string;
  readonly destination: string;
  readonly headerNames: readonly string[];
  readonly credentialIds: readonly string[];
  readonly oauth: boolean;
  /** HMAC over the configured server and exact requested destination. */
  readonly operationDigest: string;
}

export interface WorkspaceMcpAuthorizationRequest<
  TProposal,
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> extends WorkspaceMcpRequest<TPrincipal> {
  readonly proposal: TProposal;
}

export interface WorkspaceMcpToolApprovalDisplay {
  readonly kind: "mcp_tool_call";
  readonly toolName: string;
  readonly serverId: string;
  readonly serverToolName: string;
  readonly source: "global" | "project";
  readonly inputDigest: string;
  readonly configurationDigest: string;
  readonly operationDigest: string;
  readonly unsandboxed: true;
}

export interface WorkspaceMcpOAuthProviderRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> extends WorkspaceMcpRequest<TPrincipal> {
  readonly serverId: string;
  readonly source: "global" | "project";
  readonly server: Readonly<NodeHostMcpRemoteServer>;
  readonly url: URL;
  readonly fetch: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

export type ResolveWorkspaceMcpOAuthProvider<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> = (
  request: WorkspaceMcpOAuthProviderRequest<TPrincipal>,
) => ReturnType<ResolveNodeHostMcpRemoteOAuthProvider<TPrincipal>>;

export interface CreateWorkspaceMcpToolsOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> extends LoadWorkspaceMcpConfigurationOptions {
  readonly resolveCredential: ResolveWorkspaceMcpCredential<TPrincipal>;
  /** Host-private HMAC key. It must not be persisted in proposals or transcripts. */
  readonly operationDigestSecret: string;
  /** Omission is default deny. Tool-call authorization remains an upstream concern. */
  readonly authorizeLaunch?: (
    request: WorkspaceMcpAuthorizationRequest<
      WorkspaceMcpLaunchProposal,
      TPrincipal
    >,
  ) => boolean | Promise<boolean>;
  /** Omission is default deny. Called for each exact MCP URL request. */
  readonly authorizeNetwork?: (
    request: WorkspaceMcpAuthorizationRequest<
      WorkspaceMcpNetworkProposal,
      TPrincipal
    >,
  ) => boolean | Promise<boolean>;
  readonly resolveOAuthProvider?: ResolveWorkspaceMcpOAuthProvider<TPrincipal>;
  readonly authorizeOAuthNetwork?: (
    request: WorkspaceMcpAuthorizationRequest<
      WorkspaceMcpNetworkProposal,
      TPrincipal
    >,
  ) => boolean | Promise<boolean>;
  readonly fetch?: typeof globalThis.fetch;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

export interface WorkspaceMcpTools<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly resolveTools: HostToolResolver<TPrincipal>;
  readonly resolveStdioServers: (
    request: ResolveNodeHostMcpStdioServersRequest<TPrincipal>,
  ) => Promise<readonly NodeHostMcpStdioServer[]>;
  readonly resolveRemoteServers: (
    request: ResolveNodeHostMcpRemoteServersRequest<TPrincipal>,
  ) => Promise<readonly NodeHostMcpRemoteServer[]>;
  readonly authorizeStdioLaunch: (
    request: NodeHostMcpStdioLaunchRequest<TPrincipal>,
  ) => Promise<boolean>;
  readonly authorizeRemoteNetwork: (
    request: NodeHostMcpRemoteNetworkRequest<TPrincipal>,
  ) => Promise<boolean>;
  readonly authorizeRemoteOAuthNetwork: (
    request: NodeHostMcpRemoteNetworkRequest<TPrincipal>,
  ) => Promise<boolean>;
  readonly snapshot: () => Promise<WorkspaceMcpConfiguration>;
}

/**
 * Compose CLI-owned MCP declarations into Node-host dynamic resolvers. The
 * returned tools still declare `authorization: required`; this module only
 * gates launches and destinations and does not authorize individual tool calls.
 */
export function createWorkspaceMcpToolApproval(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  configuration: WorkspaceMcpConfiguration,
  secret: string,
): WorkspaceMcpToolApprovalDisplay | undefined {
  const declaration = [...configuration.servers]
    .sort((left, right) => right.id.length - left.id.length)
    .find((server) => toolName.startsWith(`${server.id}__`));
  if (!declaration) return undefined;
  const serverId = declaration.id;
  const serverToolName = toolName.slice(serverId.length + 2);
  if (!serverToolName) return undefined;
  const inputDigest = operationDigest(secret, input);
  const configurationDigest = operationDigest(secret, configuration.servers);
  return {
    kind: "mcp_tool_call",
    toolName,
    serverId,
    serverToolName,
    source: declaration.source,
    inputDigest,
    configurationDigest,
    operationDigest: operationDigest(secret, {
      toolName,
      inputDigest,
      configurationDigest,
    }),
    unsandboxed: true,
  };
}

export function isWorkspaceMcpToolApprovalDisplay(
  value: unknown,
): value is WorkspaceMcpToolApprovalDisplay {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const display = value as Partial<WorkspaceMcpToolApprovalDisplay>;
  return (
    display.kind === "mcp_tool_call" &&
    typeof display.toolName === "string" &&
    typeof display.serverId === "string" &&
    typeof display.serverToolName === "string" &&
    (display.source === "global" || display.source === "project") &&
    typeof display.inputDigest === "string" &&
    typeof display.configurationDigest === "string" &&
    typeof display.operationDigest === "string" &&
    display.unsandboxed === true
  );
}

export function validateWorkspaceMcpToolApproval(
  display: WorkspaceMcpToolApprovalDisplay,
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  configuration: WorkspaceMcpConfiguration,
  secret: string,
): boolean {
  const current = createWorkspaceMcpToolApproval(
    toolName,
    input,
    configuration,
    secret,
  );
  return Boolean(
    current &&
    equalDigest(current.operationDigest, display.operationDigest) &&
    equalDigest(current.inputDigest, display.inputDigest) &&
    equalDigest(current.configurationDigest, display.configurationDigest),
  );
}

function equalDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function createWorkspaceMcpTools<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: CreateWorkspaceMcpToolsOptions<TPrincipal>,
): WorkspaceMcpTools<TPrincipal> {
  if (options.operationDigestSecret.length < 32) {
    throw new Error(
      "MCP operation digest secret must be at least 32 characters",
    );
  }
  const snapshot = () => loadWorkspaceMcpConfiguration(options);
  const resolveStdioServers = async (
    request: ResolveNodeHostMcpStdioServersRequest<TPrincipal>,
  ): Promise<readonly NodeHostMcpStdioServer[]> => {
    const configuration = await snapshot();
    return await Promise.all(
      configuration.servers
        .filter(
          (server): server is WorkspaceMcpStdioDeclaration =>
            server.transport === "stdio",
        )
        .map(async (server) => ({
          id: server.id,
          command: server.command,
          args: [...server.args],
          cwd: server.cwd,
          env: await resolveReferenceMap(
            server.env,
            "environment",
            server,
            request,
            options.resolveCredential,
          ),
          ...(server.timeoutMs === undefined
            ? {}
            : { timeoutMs: server.timeoutMs }),
        })),
    );
  };
  const resolveRemoteServers = async (
    request: ResolveNodeHostMcpRemoteServersRequest<TPrincipal>,
  ): Promise<readonly NodeHostMcpRemoteServer[]> => {
    const configuration = await snapshot();
    return await Promise.all(
      configuration.servers
        .filter(
          (server): server is WorkspaceMcpRemoteDeclaration =>
            server.transport === "streamable-http",
        )
        .map(async (server) => ({
          id: server.id,
          transport: "streamable-http" as const,
          url: server.url,
          headers: await resolveReferenceMap(
            server.headers,
            "header",
            server,
            request,
            options.resolveCredential,
          ),
          ...(server.timeoutMs === undefined
            ? {}
            : { timeoutMs: server.timeoutMs }),
        })),
    );
  };

  const authorizeStdioLaunch = async (
    request: NodeHostMcpStdioLaunchRequest<TPrincipal>,
  ): Promise<boolean> => {
    const declaration = await findStdioDeclaration(snapshot, request.server.id);
    if (!declaration || !sameStdioServer(declaration, request.server))
      return false;
    const proposal = launchProposal(
      declaration,
      request.server,
      options.operationDigestSecret,
    );
    const allowed =
      (await options.authorizeLaunch?.({
        principal: request.principal,
        sessionId: request.sessionId,
        turnId: request.turnId,
        proposal,
      })) === true;
    if (!allowed) return false;
    const current = await findStdioDeclaration(snapshot, request.server.id);
    if (!current || !sameStdioServer(current, request.server)) return false;
    const currentProposal = launchProposal(
      current,
      request.server,
      options.operationDigestSecret,
    );
    return equalDigest(
      currentProposal.operationDigest,
      proposal.operationDigest,
    );
  };
  const authorizeRemoteNetwork = (
    request: NodeHostMcpRemoteNetworkRequest<TPrincipal>,
  ) => authorizeNetworkRequest(request, snapshot, options, false);
  const authorizeRemoteOAuthNetwork = (
    request: NodeHostMcpRemoteNetworkRequest<TPrincipal>,
  ) => authorizeNetworkRequest(request, snapshot, options, true);

  const resolveOAuthProvider = options.resolveOAuthProvider
    ? async (request: NodeHostMcpRemoteOAuthRequest<TPrincipal>) => {
        const declaration = await findRemoteDeclaration(
          snapshot,
          request.server.id,
        );
        if (
          !declaration?.oauth ||
          !sameRemoteServer(declaration, request.server)
        ) {
          return undefined;
        }
        return await options.resolveOAuthProvider!({
          principal: request.principal,
          sessionId: request.sessionId,
          turnId: request.turnId,
          serverId: declaration.id,
          source: declaration.source,
          server: request.server,
          url: request.url,
          fetch: request.fetch,
          signal: request.signal,
        });
      }
    : undefined;

  const stdioTools = createNodeHostMcpStdioTools({
    resolveServers: resolveStdioServers,
    authorizeLaunch: authorizeStdioLaunch,
    clientName: options.clientName,
    clientVersion: options.clientVersion,
  });
  const remoteTools = createNodeHostMcpRemoteTools({
    resolveServers: resolveRemoteServers,
    authorizeNetwork: authorizeRemoteNetwork,
    authorizeOAuthNetwork: authorizeRemoteOAuthNetwork,
    resolveOAuthProvider,
    fetch: options.fetch,
    clientName: options.clientName,
    clientVersion: options.clientVersion,
  });
  const resolveTools: HostToolResolver<TPrincipal> = async (request) => {
    const [stdio, remote] = await Promise.all([
      stdioTools(request),
      remoteTools(request),
    ]);
    return [...stdio, ...remote];
  };
  return {
    resolveTools,
    resolveStdioServers,
    resolveRemoteServers,
    authorizeStdioLaunch,
    authorizeRemoteNetwork,
    authorizeRemoteOAuthNetwork,
    snapshot,
  };
}

async function authorizeNetworkRequest<TPrincipal extends AgentPrincipal>(
  request: NodeHostMcpRemoteNetworkRequest<TPrincipal>,
  snapshot: () => Promise<WorkspaceMcpConfiguration>,
  options: CreateWorkspaceMcpToolsOptions<TPrincipal>,
  oauth: boolean,
): Promise<boolean> {
  const declaration = await findRemoteDeclaration(snapshot, request.serverId);
  if (!declaration) return false;
  const resolvedHeaders = oauth
    ? {}
    : await resolveReferenceMap(
        declaration.headers,
        "header",
        declaration,
        request,
        options.resolveCredential,
      );
  const proposal = networkProposal(
    declaration,
    request.url,
    resolvedHeaders,
    options.operationDigestSecret,
  );
  const authorize = oauth
    ? options.authorizeOAuthNetwork
    : options.authorizeNetwork;
  const allowed =
    (await authorize?.({
      principal: request.principal,
      sessionId: request.sessionId,
      turnId: request.turnId,
      proposal,
    })) === true;
  if (!allowed) return false;
  const current = await findRemoteDeclaration(snapshot, request.serverId);
  if (!current) return false;
  const currentHeaders = oauth
    ? {}
    : await resolveReferenceMap(
        current.headers,
        "header",
        current,
        request,
        options.resolveCredential,
      );
  const currentProposal = networkProposal(
    current,
    request.url,
    currentHeaders,
    options.operationDigestSecret,
  );
  return equalDigest(currentProposal.operationDigest, proposal.operationDigest);
}

async function resolveReferenceMap<TPrincipal extends AgentPrincipal>(
  references: Readonly<Record<string, WorkspaceMcpCredentialReference>>,
  usage: "environment" | "header",
  server: WorkspaceMcpStdioDeclaration | WorkspaceMcpRemoteDeclaration,
  request: WorkspaceMcpRequest<TPrincipal>,
  resolve: ResolveWorkspaceMcpCredential<TPrincipal>,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, reference] of Object.entries(references)) {
    const value = await resolve({
      ...request,
      serverId: server.id,
      source: server.source,
      usage,
      name,
      credential: reference.credential,
    });
    if (typeof value !== "string" || value.includes("\0")) {
      throw new Error(
        `Credential resolver returned an invalid value for ${server.id}.${name}`,
      );
    }
    result[name] = value;
  }
  return result;
}

async function findStdioDeclaration(
  snapshot: () => Promise<WorkspaceMcpConfiguration>,
  id: string,
): Promise<WorkspaceMcpStdioDeclaration | undefined> {
  return (await snapshot()).servers.find(
    (server): server is WorkspaceMcpStdioDeclaration =>
      server.id === id && server.transport === "stdio",
  );
}

async function findRemoteDeclaration(
  snapshot: () => Promise<WorkspaceMcpConfiguration>,
  id: string,
): Promise<WorkspaceMcpRemoteDeclaration | undefined> {
  return (await snapshot()).servers.find(
    (server): server is WorkspaceMcpRemoteDeclaration =>
      server.id === id && server.transport === "streamable-http",
  );
}

function launchProposal(
  declaration: WorkspaceMcpStdioDeclaration,
  server: Readonly<NodeHostMcpStdioServer>,
  secret: string,
): WorkspaceMcpLaunchProposal {
  const environmentKeys = Object.keys(server.env).sort();
  const credentialIds = sortedCredentialIds(declaration.env);
  return {
    kind: "mcp_stdio_launch",
    serverId: declaration.id,
    source: declaration.source,
    command: server.command,
    args: [...server.args],
    cwd: server.cwd,
    environmentKeys,
    credentialIds,
    ...(server.timeoutMs === undefined ? {} : { timeoutMs: server.timeoutMs }),
    unsandboxed: true,
    operationDigest: operationDigest(secret, {
      kind: "stdio",
      serverId: server.id,
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      env: sortedRecord(server.env),
      timeoutMs: server.timeoutMs ?? null,
    }),
  };
}

function networkProposal(
  declaration: WorkspaceMcpRemoteDeclaration,
  destination: URL,
  resolvedHeaders: Readonly<Record<string, string>>,
  secret: string,
): WorkspaceMcpNetworkProposal {
  const headerNames = Object.keys(declaration.headers).sort();
  const credentialIds = sortedCredentialIds(declaration.headers);
  return {
    kind: "mcp_network_destination",
    serverId: declaration.id,
    source: declaration.source,
    configuredEndpoint: declaration.url,
    destination: destination.toString(),
    headerNames,
    credentialIds,
    oauth: declaration.oauth,
    operationDigest: operationDigest(secret, {
      kind: "network",
      serverId: declaration.id,
      configuredEndpoint: declaration.url,
      destination: destination.toString(),
      headers: sortedRecord(resolvedHeaders),
      oauth: declaration.oauth,
    }),
  };
}

function sameStdioServer(
  declaration: WorkspaceMcpStdioDeclaration,
  server: Readonly<NodeHostMcpStdioServer>,
): boolean {
  return (
    declaration.command === server.command &&
    declaration.cwd === server.cwd &&
    JSON.stringify(declaration.args) === JSON.stringify(server.args) &&
    JSON.stringify(Object.keys(declaration.env).sort()) ===
      JSON.stringify(Object.keys(server.env).sort()) &&
    declaration.timeoutMs === server.timeoutMs
  );
}

function sameRemoteServer(
  declaration: WorkspaceMcpRemoteDeclaration,
  server: Readonly<NodeHostMcpRemoteServer>,
): boolean {
  return (
    declaration.url === server.url &&
    server.transport === "streamable-http" &&
    JSON.stringify(Object.keys(declaration.headers).sort()) ===
      JSON.stringify(Object.keys(server.headers ?? {}).sort()) &&
    declaration.timeoutMs === server.timeoutMs
  );
}

function sortedCredentialIds(
  references: Readonly<Record<string, WorkspaceMcpCredentialReference>>,
): string[] {
  return Object.values(references)
    .map((reference) => reference.credential)
    .sort();
}

function sortedRecord(
  value: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function operationDigest(secret: string, value: unknown): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(value))
    .digest("hex");
}
