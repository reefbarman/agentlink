import {
  createCodexOAuthRuntime,
  SessionPreferencesStore,
  type CodexOAuthManager,
  type NodeHostMcpOAuthAuthorizationRequest,
  type NodeHostMcpFormElicitationRequest,
  type NodeHostMcpFormElicitationResponse,
  type McpServerInfo,
} from "@agentlink/node-host";
import type { CodexCredentialProvider } from "@agentlink/core/codex";
import { validateAndCoerceMcpElicitationValues } from "@agentlink/protocol/mcp-elicitation";
import {
  acquireWorkspaceOwnership,
  createWorkspaceHost,
  disableManagedTypeScriptForProject,
  enableManagedTypeScriptForProject,
  getManagedTypeScriptStatus,
  inspectWorkspaceMcpProjectDeclarations,
  installManagedTypeScriptLanguageServer,
  isWorkspaceCommandApprovalDisplay,
  isWorkspaceMcpToolApprovalDisplay,
  isWorkspaceSharedMcpToolApproval,
  loadWorkspaceMcpConfiguration,
  readManagedTypeScriptProjectEnablement,
  removeManagedTypeScriptLanguageServer,
  resolveWorkspaceProject,
  updateManagedTypeScriptLanguageServer,
  type WorkspaceCommandApprovalDisplay,
  type WorkspaceFileApprovalDisplay,
  type WorkspaceHost,
  type WorkspaceMcpLaunchProposal,
  type WorkspaceMcpNetworkProposal,
  type WorkspaceMcpToolApprovalDisplay,
  type WorkspaceSharedMcpAdmissionProposal,
  type WorkspaceSharedMcpLaunchProposal,
  type WorkspaceSharedMcpNetworkProposal,
  type WorkspaceSharedMcpToolApproval,
  type WorkspaceOwnershipHandle,
  type WorkspaceProviderConfig,
  type WorkspaceQuestionRequest,
} from "@agentlink/workspace-host";
import { randomUUID } from "node:crypto";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Command, CommanderError } from "commander";
import { render } from "ink";
import { InkPictureProvider } from "ink-picture";
import React from "react";

import {
  compatibleCredentialAccount,
  getApiKey,
  OPENAI_API_KEY_ACCOUNT,
  parseCliConfig,
  publicConfig,
  readCliConfig,
  setApiKey,
  writeCliConfig,
} from "./config.js";
import {
  cliMcpGlobalConfigPath,
  cliMcpProjectConfigPath,
  ensureCliMcpGlobalConfig,
  inspectCliMcpProjectConfig,
  inspectCliSharedMcpServers,
  loadCliSharedMcpServerConfigs,
  resolveCliMcpCredential,
  setCliMcpCredential,
  trustCliProjectMcpServer,
} from "./mcpConfig.js";
import {
  attachmentPathsFromText,
  resolveCliAttachments,
} from "./attachments.js";
import { CliMcpHubOAuthProvider } from "./CliMcpHubOAuthProvider.js";
import {
  CliMcpOAuthRuntime,
  isSafePublicHttpsDestination,
} from "./mcpOAuthRuntime.js";
import {
  InkChatApp,
  controllerStatus,
  type InkChatSubmitResult,
} from "./tui/InkChatApp.js";
import {
  parseTuiCommand,
  renderBackgroundAgents,
  renderCommandOutput,
  renderProcesses,
  renderTuiHelp,
} from "./tui/tuiCommand.js";
import type {
  PresentTuiControl,
  TuiControlOption,
} from "./tui/controlTypes.js";
import { sanitizeTerminalText } from "./tui/terminalText.js";
import type { TuiPickerItem } from "./tui/tuiShellState.js";
import {
  createStandaloneSessionController,
  type StandaloneSessionController,
} from "./sessionController.js";
import type { StandaloneSessionSummary } from "./sessionProjection.js";
import type { CliConfig } from "./types.js";

interface CliInteractionBroker {
  confirmMcpLaunch(proposal: WorkspaceMcpLaunchProposal): Promise<boolean>;
  confirmMcpNetwork(proposal: WorkspaceMcpNetworkProposal): Promise<boolean>;
  confirmMcpOAuth(
    request: Readonly<NodeHostMcpOAuthAuthorizationRequest>,
  ): Promise<boolean>;
  confirmSharedMcpAdmission(
    proposal: WorkspaceSharedMcpAdmissionProposal,
  ): Promise<boolean>;
  confirmSharedMcpLaunch(
    proposal: WorkspaceSharedMcpLaunchProposal,
  ): Promise<boolean>;
  confirmSharedMcpNetwork(
    proposal: WorkspaceSharedMcpNetworkProposal,
  ): Promise<boolean>;
  notifyMcpStatus(message: string): void;
  notifyMcpServers(servers: McpServerInfo[]): void;
  elicitMcpForm(
    request: NodeHostMcpFormElicitationRequest,
  ): Promise<NodeHostMcpFormElicitationResponse>;
  notifyBackgroundApproval(request: {
    readonly parentSessionId: string;
    readonly childSessionId: string;
  }): void;
  askQuestion(request: WorkspaceQuestionRequest): Promise<string>;
}

interface CliInteractionBridge {
  current?: CliInteractionBroker;
}

export interface CliIo {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly error: NodeJS.WritableStream;
  readonly isTty: boolean;
  readonly readSecret: (prompt: string) => Promise<string>;
  readonly openExternal: (url: string) => Promise<void>;
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const parsedResult = parseArguments(argv, io);
  if ("exitCode" in parsedResult) return parsedResult.exitCode;
  const parsed = parsedResult;
  if (parsed.command === "version") {
    io.output.write(`${__AGENTLINK_CLI_VERSION__}\n`);
    return 0;
  }

  const dataRoot = path.resolve(
    environment.AGENTLINK_HOME?.trim() || path.join(homedir(), ".agentlink"),
  );
  const projectRoot = path.resolve(parsed.project ?? process.cwd());
  if (parsed.command === "lsp-status") {
    const project = await resolveWorkspaceProject(projectRoot);
    io.output.write(
      `${JSON.stringify(
        {
          installation: await getManagedTypeScriptStatus(dataRoot),
          project: {
            root: project.root,
            ...(await readManagedTypeScriptProjectEnablement(
              dataRoot,
              project.id,
            )),
          },
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  if (parsed.command === "lsp-install" || parsed.command === "lsp-update") {
    io.output.write(
      "Installing the pinned TypeScript language server. Installation does not enable it for any project; project enablement is a separate unsandboxed-process trust decision.\n",
    );
    const status =
      parsed.command === "lsp-install"
        ? await installManagedTypeScriptLanguageServer({ dataRoot })
        : await updateManagedTypeScriptLanguageServer({ dataRoot });
    if (status.state !== "ready") {
      throw new Error(
        `Managed TypeScript installation did not become ready: ${status.reason}`,
      );
    }
    io.output.write(
      `TypeScript intelligence ready: typescript-language-server ${status.recipe.languageServer.version}, TypeScript ${status.recipe.typescript.version}.\n`,
    );
    return 0;
  }
  if (parsed.command === "lsp-enable") {
    requireTty(io, "TypeScript language-server project enablement");
    const installation = await getManagedTypeScriptStatus(dataRoot);
    if (installation.state !== "ready") {
      throw new Error(
        "Install TypeScript intelligence before enabling a project",
      );
    }
    const project = await resolveWorkspaceProject(projectRoot);
    const confirmation = `enable ${project.id.slice(0, 12)}`;
    io.output.write(
      `Enable the unsandboxed managed TypeScript language server for ${project.root}. It can read beyond AgentLink tool scopes.\n`,
    );
    if (!(await confirmTyped(io, `Type ${confirmation}: `, confirmation))) {
      io.output.write("Project language intelligence was not enabled.\n");
      return 1;
    }
    await enableManagedTypeScriptForProject(dataRoot, project.id);
    io.output.write(`Enabled TypeScript intelligence for ${project.root}.\n`);
    return 0;
  }
  if (parsed.command === "lsp-disable") {
    const project = await resolveWorkspaceProject(projectRoot);
    const disabled = await disableManagedTypeScriptForProject(
      dataRoot,
      project.id,
    );
    io.output.write(
      disabled
        ? `Disabled TypeScript intelligence for ${project.root}.\n`
        : `TypeScript intelligence is not enabled for ${project.root}.\n`,
    );
    return 0;
  }
  if (parsed.command === "lsp-remove") {
    const removed = await removeManagedTypeScriptLanguageServer(dataRoot);
    io.output.write(
      removed
        ? "Removed managed TypeScript intelligence.\n"
        : "Managed TypeScript intelligence is not installed.\n",
    );
    return 0;
  }
  let config = await readCliConfig(dataRoot);
  const sessionPreferencesStore = new SessionPreferencesStore({ dataRoot });
  const sessionPreferences = await sessionPreferencesStore
    .read()
    .catch((error) => {
      io.error.write(
        `Shared session preferences unavailable; using CLI defaults: ${errorMessage(error)}\n`,
      );
      return undefined;
    });
  const sharedCodeModel = sessionPreferences?.modeModels.code?.trim();
  const sharedCodeReasoningEffort =
    sessionPreferences?.modeReasoningEfforts.code;
  if (sharedCodeModel) {
    const providerId = resolveConfiguredProviderId(config, sharedCodeModel);
    if (providerId) {
      config = {
        ...config,
        defaultModel: { providerId, modelId: sharedCodeModel },
      };
    }
  }
  if (parsed.command === "chat") requireTty(io, "Coding chat");

  if (parsed.command === "config-show") {
    io.output.write(`${JSON.stringify(publicConfig(config), null, 2)}\n`);
    return 0;
  }
  if (parsed.command === "config-model") {
    config = { ...config, defaultModel: parseModelReference(parsed.value) };
    await Promise.all([
      writeCliConfig(dataRoot, config),
      sessionPreferencesStore.update({
        modeModels: { code: config.defaultModel.modelId },
      }),
    ]);
    io.output.write(`Default model: ${parsed.value}\n`);
    return 0;
  }
  if (parsed.command === "config-compatible") {
    config = await configureCompatibleProvider(config, parsed.values, io);
    await writeCliConfig(dataRoot, config);
    io.output.write(
      `Configured OpenAI-compatible provider ${parsed.values[0]}.\n`,
    );
    return 0;
  }
  if (parsed.command === "mcp-status") {
    return await printMcpStatus(dataRoot, projectRoot, io);
  }
  if (parsed.command === "mcp-reauthenticate") {
    requireTty(io, "MCP reauthentication");
    const configs = await loadCliSharedMcpServerConfigs(
      projectRoot,
      environment,
    );
    const server = configs.find(
      (item) => item.name === parsed.value && !item.disabled,
    );
    if (
      !server?.url ||
      !["http", "sse", "streamable-http"].includes(server.type ?? "")
    ) {
      throw new Error(`Enabled remote MCP server '${parsed.value}' not found`);
    }
    const url = new URL(server.url);
    if (!(await isSafePublicHttpsDestination(url))) {
      throw new Error("MCP reauthentication destination is not public HTTPS");
    }
    const confirmation = `reauthenticate ${server.name}`;
    if (
      !(await confirmTyped(
        io,
        `Replace CLI OAuth credentials for ${url.origin}. Type ${confirmation}: `,
        confirmation,
      ))
    ) {
      io.output.write("MCP reauthentication cancelled.\n");
      return 1;
    }
    const runtime = await CliMcpOAuthRuntime.create({
      openExternal: io.openExternal,
      confirmAuthorization: async (request) => {
        io.output.write(
          `Open OAuth authorization for ${server.name} at ${new URL(request.authorizationUrl).origin}?\n`,
        );
        return await confirmTyped(
          io,
          `Type open ${server.name}: `,
          `open ${server.name}`,
        );
      },
    });
    try {
      const current = (
        await loadCliSharedMcpServerConfigs(projectRoot, environment)
      ).find((item) => item.name === server.name && !item.disabled);
      if (JSON.stringify(current) !== JSON.stringify(server)) {
        throw new Error(
          "MCP server configuration changed during reauthentication",
        );
      }
      const provider = await runtime.resolveOAuthProvider({
        principal: {
          tenantId: "local",
          subjectId: (await resolveWorkspaceProject(projectRoot)).id,
        },
        sessionId: "cli-reauthenticate",
        turnId: "cli-reauthenticate",
        server: {
          id: server.name,
          transport: server.type === "sse" ? "sse" : "streamable-http",
          url: server.url,
        },
        url,
        fetch: runtime.fetch,
      });
      await auth(
        { ...provider, tokens: async () => undefined },
        { serverUrl: url, fetchFn: runtime.fetch },
      );
      io.output.write(`Reauthenticated ${server.name} for the CLI.\n`);
      return 0;
    } finally {
      await runtime.close();
    }
  }
  if (parsed.command === "mcp-trust") {
    requireTty(io, "Project MCP trust review");
    return await trustProjectMcpServer(dataRoot, projectRoot, parsed.value, io);
  }
  if (parsed.command === "mcp-credential") {
    requireTty(io, "MCP credential setup");
    await setCliMcpCredential(
      parsed.value,
      await io.readSecret(`MCP credential ${parsed.value}: `),
    );
    io.output.write(
      `Stored MCP credential ${parsed.value} in macOS Keychain.\n`,
    );
    return 0;
  }

  const oauth = createCodexOAuthRuntime({
    log: (message) => io.error.write(`[oauth] ${message}\n`),
  });
  await oauth.ready();
  if (parsed.command === "auth-codex") {
    requireTty(io, "Codex sign-in");
    return await signInCodex(oauth.manager, io);
  }
  if (parsed.command === "auth-openai") {
    requireTty(io, "OpenAI API-key setup");
    await setApiKey(
      OPENAI_API_KEY_ACCOUNT,
      await io.readSecret("OpenAI API key: "),
    );
    io.output.write("OpenAI API key stored in macOS Keychain.\n");
    return 0;
  }

  const projectIdentity = await resolveWorkspaceProject(projectRoot);
  const languageEnablement = await readManagedTypeScriptProjectEnablement(
    dataRoot,
    projectIdentity.id,
  ).catch((error) => {
    io.error.write(
      `TypeScript project enablement is invalid; language intelligence remains disabled: ${errorMessage(error)}\n`,
    );
    return { enabled: false as const };
  });
  const sessionWriteGrants = new Map<
    string,
    Map<string, CliSessionWriteGrant>
  >();
  const sessionCommandGrants = new Map<
    string,
    Map<string, CliSessionCommandGrant>
  >();
  const sessionMcpGrants = new Map<string, Set<string>>();
  const interactionBridge: CliInteractionBridge = {};

  const ownership =
    parsed.command === "chat"
      ? await acquireWorkspaceOwnership(
          await resolveWorkspaceProject(projectRoot),
          dataRoot,
        ).catch((error: unknown) => {
          throw new Error(
            `Cannot start a writing session: ${errorMessage(error)}`,
          );
        })
      : undefined;
  const mcpOAuth =
    parsed.command === "chat"
      ? await CliMcpOAuthRuntime.create({
          openExternal: io.openExternal,
          confirmAuthorization: (request) =>
            requireInteractionBroker(interactionBridge).confirmMcpOAuth(
              request,
            ),
        }).catch(async (error) => {
          await ownership?.release();
          throw error;
        })
      : undefined;
  const host = await createHost({
    config,
    sharedCodeReasoningEffort,
    oauthProvider: oauth.provider,
    projectRoot,
    dataRoot,
    sessionWriteGrants,
    sessionCommandGrants,
    sessionMcpGrants,
    environment,
    enableCommands: parsed.command === "chat",
    enableLanguageIntelligence: languageEnablement.enabled,
    interactionBridge,
    mcpOAuth,
  }).catch(async (error) => {
    await mcpOAuth?.close();
    await ownership?.release();
    throw error;
  });
  if (parsed.command === "status") {
    try {
      return await printStatus(host, config, oauth.manager, io);
    } finally {
      await host.close();
    }
  }
  if (parsed.command === "sessions") {
    try {
      return await printSessions(host, io);
    } finally {
      await host.close();
    }
  }
  if (parsed.command === "delete") {
    try {
      await host.deleteSession(parsed.value);
      io.output.write(`Deleted session ${parsed.value}.\n`);
      return 0;
    } finally {
      await host.close();
    }
  }

  if (parsed.command !== "chat") {
    throw new Error(`Unsupported command: ${parsed.command satisfies never}`);
  }
  await runInteractiveChat(
    createStandaloneSessionController({
      host,
      requestedSession: parsed.session,
      onTurnEvent: (event) => {
        if (
          event.type === "tool.completed" &&
          event.effect === "write" &&
          isDurableWriteResult(event.displayContent)
        ) {
          advanceSessionWriteGrant(
            writeGrantsForSession(sessionWriteGrants, event.sessionId),
            event.toolName,
            event.displayContent,
          );
        }
      },
    }),
    io,
    sessionWriteGrants,
    sessionCommandGrants,
    sessionMcpGrants,
    interactionBridge,
    mcpOAuth!,
    ownership!,
  );
  return 0;
}

async function createHost(options: {
  config: CliConfig;
  sharedCodeReasoningEffort?: import("@agentlink/protocol/model-catalog").CoreReasoningEffort;
  oauthProvider: CodexCredentialProvider<{
    principal: { tenantId: string; subjectId: string };
    authContext: undefined;
  }>;
  projectRoot: string;
  dataRoot: string;
  sessionWriteGrants: ReadonlyMap<
    string,
    ReadonlyMap<string, CliSessionWriteGrant>
  >;
  sessionCommandGrants: ReadonlyMap<
    string,
    ReadonlyMap<string, CliSessionCommandGrant>
  >;
  sessionMcpGrants: ReadonlyMap<string, ReadonlySet<string>>;
  environment: NodeJS.ProcessEnv;
  enableCommands: boolean;
  enableLanguageIntelligence: boolean;
  interactionBridge: CliInteractionBridge;
  mcpOAuth?: CliMcpOAuthRuntime;
}): Promise<WorkspaceHost> {
  const providers: WorkspaceProviderConfig[] = [];
  if (options.config.codexModels.length > 0) {
    providers.push({
      type: "codex",
      credentialProvider: options.oauthProvider,
      modelIds: options.config.codexModels,
    });
  }
  if (options.config.openAiModels.length > 0) {
    providers.push({
      type: "openai",
      modelIds: options.config.openAiModels,
      resolveApiKey: () => getApiKey(OPENAI_API_KEY_ACCOUNT),
    });
  }
  for (const compatible of options.config.compatibleProviders) {
    providers.push({
      type: "openai-compatible",
      id: compatible.id,
      displayName: compatible.displayName,
      baseURL: compatible.baseURL,
      profile: compatible.profile,
      noAuth: compatible.noAuth,
      allowInsecureHttp: compatible.allowInsecureHttp,
      models: [...compatible.models],
      ...(compatible.noAuth
        ? {}
        : {
            resolveApiKey: () =>
              getApiKey(compatibleCredentialAccount(compatible)),
          }),
    });
  }
  let host: WorkspaceHost | undefined;
  const projectMcpConfig = options.enableCommands
    ? await inspectCliMcpProjectConfig(options.projectRoot)
    : undefined;
  const shadowedLegacyServerIds = options.enableCommands
    ? async () =>
        new Set(
          await inspectCliSharedMcpServers(
            options.projectRoot,
            options.environment,
            true,
          ),
        )
    : undefined;
  const authorizeSharedAdmission = async (
    proposal: WorkspaceSharedMcpAdmissionProposal,
    sessionId: string,
  ): Promise<boolean> =>
    host?.isBackgroundSession(sessionId)
      ? await host.requestBackgroundApproval({
          childSessionId: sessionId,
          toolName: "shared_mcp_project_admission",
          summary: `Trust project MCP server ${proposal.serverId}`,
          operationDigest: proposal.operationDigest,
          displayContent: proposal,
        })
      : await requireInteractionBroker(
          options.interactionBridge,
        ).confirmSharedMcpAdmission(proposal);
  const authorizeSharedLaunch = async (
    proposal: WorkspaceSharedMcpLaunchProposal,
    sessionId: string,
  ): Promise<boolean> =>
    host?.isBackgroundSession(sessionId)
      ? await host.requestBackgroundApproval({
          childSessionId: sessionId,
          toolName: "shared_mcp_server_launch",
          summary: `Launch MCP server ${proposal.serverId}`,
          operationDigest: proposal.operationDigest,
          displayContent: proposal,
        })
      : await requireInteractionBroker(
          options.interactionBridge,
        ).confirmSharedMcpLaunch(proposal);
  const authorizeSharedNetwork = async (
    proposal: WorkspaceSharedMcpNetworkProposal,
    sessionId: string,
  ): Promise<boolean> => {
    if (
      proposal.oauth &&
      !(await isSafePublicHttpsDestination(new URL(proposal.destination)))
    ) {
      return false;
    }
    return host?.isBackgroundSession(sessionId)
      ? await host.requestBackgroundApproval({
          childSessionId: sessionId,
          toolName: "shared_mcp_network_destination",
          summary: `Connect MCP server ${proposal.serverId} to ${proposal.destination}`,
          operationDigest: proposal.operationDigest,
          displayContent: proposal,
        })
      : await requireInteractionBroker(
          options.interactionBridge,
        ).confirmSharedMcpNetwork(proposal);
  };
  host = await createWorkspaceHost({
    projectRoot: options.projectRoot,
    dataRoot: options.dataRoot,
    ownerId: `cli-${process.pid}-${randomUUID()}`,
    providers,
    defaultModel: options.config.defaultModel,
    defaultReasoningEffort: options.sharedCodeReasoningEffort,
    files: {
      enabled: true,
      ripgrepExecutable: path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "rg",
      ),
      approvalPolicy: {
        hasSessionGrant: (proposal, request) => {
          const grant = options.sessionWriteGrants
            .get(request.sessionId)
            ?.get(sessionWriteGrantKey(proposal.toolName, proposal.path));
          if (!grant) return false;
          return (
            grant.contentHash === proposal.expectedContentHash &&
            grant.scopeDigest === proposal.scopeDigest &&
            grant.policyRevision === proposal.policyRevision
          );
        },
      },
    },
    ...(options.enableLanguageIntelligence
      ? { languageIntelligence: { enabled: true as const } }
      : {}),
    ...(options.enableCommands
      ? {
          background: {
            enabled: true as const,
            onApprovalAvailable: (request) =>
              options.interactionBridge.current?.notifyBackgroundApproval(
                request,
              ),
          },
        }
      : {}),
    artifacts: {
      roots: [
        {
          id: "global",
          scope: "global",
          rootPath: path.join(options.dataRoot, "artifacts"),
        },
        {
          id: "project",
          scope: "project",
          rootPath: options.projectRoot,
        },
        {
          id: "project_agentlink",
          scope: "project",
          rootPath: path.join(options.projectRoot, ".agentlink"),
        },
      ],
    },
    ...(options.enableCommands
      ? {
          commands: {
            enabled: true as const,
            resolveEnvironment: () => options.environment,
            hasSessionGrant: (
              proposal: WorkspaceCommandApprovalDisplay,
              request: { readonly sessionId: string },
            ) => {
              const grant = options.sessionCommandGrants
                .get(request.sessionId)
                ?.get(sessionCommandGrantKey(proposal));
              return grant?.policyFingerprint === proposal.policyFingerprint;
            },
          },
        }
      : {}),
    sessionInteractions: {
      askQuestion: (request) =>
        requireInteractionBroker(options.interactionBridge).askQuestion(
          request,
        ),
    },
    ...(options.enableCommands
      ? {
          sharedMcp: {
            resolveConfigs: () =>
              loadCliSharedMcpServerConfigs(
                options.projectRoot,
                options.environment,
              ),
            baseEnvironment: () =>
              Object.fromEntries(
                Object.entries(options.environment).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              ),
            fetch: options.mcpOAuth?.fetch ?? globalThis.fetch,
            nativeFetch: globalThis.fetch,
            clientVersion: __AGENTLINK_CLI_VERSION__,
            onStatus: (message: string) =>
              options.interactionBridge.current?.notifyMcpStatus(message),
            onServerStatus: (_sessionId: string, servers: McpServerInfo[]) =>
              options.interactionBridge.current?.notifyMcpServers(servers),
            onElicitation: (request: NodeHostMcpFormElicitationRequest) =>
              host?.isBackgroundSession(request.sessionId)
                ? { action: "cancel" as const }
                : requireInteractionBroker(
                    options.interactionBridge,
                  ).elicitMcpForm(request),
            authorizeAdmission: (
              proposal: WorkspaceSharedMcpAdmissionProposal,
              request: { readonly sessionId: string },
            ) => authorizeSharedAdmission(proposal, request.sessionId),
            authorizeLaunch: (
              proposal: WorkspaceSharedMcpLaunchProposal,
              request: { readonly sessionId: string },
            ) => authorizeSharedLaunch(proposal, request.sessionId),
            authorizeNetwork: (
              proposal: WorkspaceSharedMcpNetworkProposal,
              request: { readonly sessionId: string },
            ) => authorizeSharedNetwork(proposal, request.sessionId),
            hasSessionGrant: (
              proposal: WorkspaceSharedMcpToolApproval,
              request: { readonly sessionId: string },
            ) =>
              options.sessionMcpGrants
                .get(request.sessionId)
                ?.has(mcpGrantKey(proposal)) ?? false,
            createOAuthProvider: options.mcpOAuth
              ? async (config, request, fetch) => {
                  const provider = await options.mcpOAuth!.resolveOAuthProvider(
                    {
                      principal: request.principal,
                      sessionId: request.sessionId,
                      turnId: request.turnId,
                      server: {
                        id: config.name,
                        transport:
                          config.type === "sse" ? "sse" : "streamable-http",
                        url: config.url!,
                      },
                      url: new URL(config.url!),
                      fetch,
                    },
                    async (authorization) =>
                      host?.isBackgroundSession(request.sessionId)
                        ? await host.requestBackgroundApproval({
                            childSessionId: request.sessionId,
                            toolName: "shared_mcp_oauth_browser",
                            summary: `Open MCP OAuth browser for ${config.name}`,
                            displayContent: {
                              kind: "mcp_oauth_browser",
                              serverId: config.name,
                              authorizationOrigin: new URL(
                                authorization.authorizationUrl,
                              ).origin,
                            },
                            signal: authorization.signal,
                          })
                        : await requireInteractionBroker(
                            options.interactionBridge,
                          ).confirmMcpOAuth(authorization),
                  );
                  return new CliMcpHubOAuthProvider(
                    provider,
                    config.url!,
                    fetch,
                  );
                }
              : undefined,
          },
          mcp: {
            globalConfigPath: await ensureCliMcpGlobalConfig(options.dataRoot),
            projectConfigPath: projectMcpConfig?.legacyConfigPath,
            shadowedLegacyServerIds,
            resolveCredential: ({ credential }) =>
              resolveCliMcpCredential(credential),
            authorizeLaunch: async (request) =>
              host?.isBackgroundSession(request.sessionId)
                ? await host.requestBackgroundApproval({
                    childSessionId: request.sessionId,
                    toolName: "mcp_server_launch",
                    summary: `Launch MCP server ${request.proposal.serverId}`,
                    operationDigest: request.proposal.operationDigest,
                    displayContent: request.proposal,
                  })
                : await requireInteractionBroker(
                    options.interactionBridge,
                  ).confirmMcpLaunch(request.proposal),
            authorizeNetwork: async (request) => {
              if (
                !(await (
                  await import("./mcpOAuthRuntime.js")
                ).isSafePublicHttpsDestination(
                  new URL(request.proposal.destination),
                ))
              ) {
                return false;
              }
              return host?.isBackgroundSession(request.sessionId)
                ? await host.requestBackgroundApproval({
                    childSessionId: request.sessionId,
                    toolName: "mcp_network_destination",
                    summary: `Connect MCP server ${request.proposal.serverId} to ${request.proposal.destination}`,
                    operationDigest: request.proposal.operationDigest,
                    displayContent: request.proposal,
                  })
                : await requireInteractionBroker(
                    options.interactionBridge,
                  ).confirmMcpNetwork(request.proposal);
            },
            authorizeOAuthNetwork: async (request) => {
              if (
                request.proposal.oauth !== true ||
                !(await (
                  await import("./mcpOAuthRuntime.js")
                ).isSafePublicHttpsDestination(
                  new URL(request.proposal.destination),
                ))
              ) {
                return false;
              }
              return host?.isBackgroundSession(request.sessionId)
                ? await host.requestBackgroundApproval({
                    childSessionId: request.sessionId,
                    toolName: "mcp_oauth_network_destination",
                    summary: `Connect MCP OAuth for ${request.proposal.serverId} to ${request.proposal.destination}`,
                    operationDigest: request.proposal.operationDigest,
                    displayContent: request.proposal,
                  })
                : await requireInteractionBroker(
                    options.interactionBridge,
                  ).confirmMcpNetwork(request.proposal);
            },
            resolveOAuthProvider: options.mcpOAuth
              ? (request) =>
                  options.mcpOAuth!.resolveOAuthProvider(
                    request,
                    async (authorization) => {
                      if (!host?.isBackgroundSession(request.sessionId)) {
                        return await requireInteractionBroker(
                          options.interactionBridge,
                        ).confirmMcpOAuth(authorization);
                      }
                      return await host.requestBackgroundApproval({
                        childSessionId: request.sessionId,
                        toolName: "mcp_oauth_browser",
                        summary: `Open MCP OAuth browser for ${request.serverId}`,
                        displayContent: {
                          kind: "mcp_oauth_browser",
                          serverId: request.serverId,
                          authorizationOrigin: new URL(
                            authorization.authorizationUrl,
                          ).origin,
                        },
                        signal: authorization.signal,
                      });
                    },
                  )
              : undefined,
            fetch: options.mcpOAuth?.fetch,
            authorizeToolCall: (proposal, request) =>
              options.sessionMcpGrants
                .get(request.sessionId)
                ?.has(mcpGrantKey(proposal)) ?? false,
            clientName: "AgentLink CLI",
            clientVersion: __AGENTLINK_CLI_VERSION__,
          },
        }
      : {}),
    requestLimits: {
      maxInputBytes: 8 * 1024 * 1024,
      maxOutputBytes: 2 * 1024 * 1024,
      maxRetries: 1,
      inputSafetyTokens: 2048,
    },
  });
  return host;
}

async function runInteractiveChat(
  controller: StandaloneSessionController,
  io: CliIo,
  sessionWriteGrants: Map<string, Map<string, CliSessionWriteGrant>>,
  sessionCommandGrants: Map<string, Map<string, CliSessionCommandGrant>>,
  sessionMcpGrants: Map<string, Set<string>>,
  interactionBridge: CliInteractionBridge,
  mcpOAuth: CliMcpOAuthRuntime,
  ownership: WorkspaceOwnershipHandle,
): Promise<void> {
  return await runInkInteractiveChat(
    controller,
    io,
    sessionWriteGrants,
    sessionCommandGrants,
    sessionMcpGrants,
    interactionBridge,
    mcpOAuth,
    ownership,
  );
}

async function runInkInteractiveChat(
  controller: StandaloneSessionController,
  io: CliIo,
  sessionWriteGrants: Map<string, Map<string, CliSessionWriteGrant>>,
  sessionCommandGrants: Map<string, Map<string, CliSessionCommandGrant>>,
  sessionMcpGrants: Map<string, Set<string>>,
  interactionBridge: CliInteractionBridge,
  mcpOAuth: CliMcpOAuthRuntime,
  ownership: WorkspaceOwnershipHandle,
): Promise<void> {
  const initialized = await controller.initialize();
  let sessionId = initialized.sessionId;
  let presentControl: PresentTuiControl | undefined;
  let externalStatus: string | undefined;
  let externalStatusRevision = 0;
  let screen: ReturnType<typeof render> | undefined;
  let closing = false;
  const mcpLaunchGrants = new Set<string>();
  const mcpNetworkGrants = new Set<string>();
  const loadFileSuggestions = (query: string) =>
    listTuiFileSuggestions(controller.getState().projectRoot, query);
  const reportError = (error: unknown) => {
    updateExternalStatus(errorMessage(error));
  };
  const updateExternalStatus = (status: string) => {
    externalStatus = status;
    externalStatusRevision += 1;
    renderShell();
  };
  const registerControlPresenter = (next: PresentTuiControl) => {
    presentControl = next;
  };

  const renderShell = () => {
    if (!screen) return;
    screen.rerender(
      React.createElement(
        InkPictureProvider,
        null,
        React.createElement(InkChatApp, {
          controller,
          initialProjection: controller.getState(),
          externalStatus,
          externalStatusRevision,
          loadFileSuggestions,
          onSubmit: submit,
          onExit: () => {
            closing = true;
          },
          onError: reportError,
          registerControlPresenter,
          onOpenControlCenter: () =>
            void openControlCenter().catch(reportError),
        }),
      ),
    );
  };
  const reviewCurrentInteraction = async (): Promise<void> => {
    const interaction = controller.getState().pendingInteraction;
    const displayContent = interaction?.displayContent;
    if (!interaction || !isReviewableProposal(displayContent)) {
      await controller.cancel("Session has no reviewable pending proposal");
      throw new Error("Session has no reviewable pending proposal");
    }
    const fileProposal = isWorkspaceFileProposal(displayContent)
      ? displayContent
      : undefined;
    const commandProposal = isWorkspaceCommandApprovalDisplay(displayContent)
      ? displayContent
      : undefined;
    const mcpProposal = isWorkspaceMcpToolApprovalDisplay(displayContent)
      ? displayContent
      : isWorkspaceSharedMcpToolApproval(displayContent)
        ? displayContent
        : undefined;
    const options: TuiControlOption[] = [
      {
        id: "allow_once",
        label:
          commandProposal?.mode === "background"
            ? "Allow background once and acknowledge concurrent edits"
            : "Approve once",
      },
      ...((fileProposal && !fileProposal.protected) ||
      commandProposal?.mode === "foreground" ||
      mcpProposal
        ? [
            {
              id: "allow_session",
              label: fileProposal
                ? "Allow this path for session"
                : commandProposal
                  ? "Allow exact command for session"
                  : "Allow server tool for session",
            },
          ]
        : []),
      ...(commandProposal?.mode === "foreground"
        ? [{ id: "allow_rule", label: "Save exact allow rule" }]
        : []),
      { id: "deny", label: "Deny", tone: "danger" },
    ];
    const response = await requestControl({
      id: interaction.interactionId,
      title: fileProposal
        ? `Review ${fileProposal.operation} · ${fileProposal.path}`
        : commandProposal
          ? `Review ${commandProposal.mode} command`
          : `Review MCP tool · ${mcpProposal!.serverId}/${mcpProposal!.serverToolName}`,
      body: proposalBody(displayContent),
      ...(commandProposal?.mode === "background"
        ? {
            input: {
              placeholder: 'Type "allow background" or leave blank to deny',
            },
          }
        : { options }),
      cancellable: false,
    });
    const choice =
      commandProposal?.mode === "background"
        ? isBackgroundCommandAcknowledged(response)
          ? "allow_once"
          : "deny"
        : response.cancelled
          ? "deny"
          : (response.optionId ?? "deny");
    const decision = choice === "deny" ? "deny" : "allow";
    if (commandProposal?.mode === "background" && decision === "allow") {
      controller.acknowledgeBackgroundCommand(commandProposal.commandId);
    }
    let writeCompleted = false;
    const unsubscribe = controller.subscribe((_state, action) => {
      if (
        action.type === "turn.event" &&
        action.event.type === "tool.completed" &&
        action.event.effect === "write" &&
        isDurableWriteResult(action.event.displayContent) &&
        action.event.toolName === fileProposal?.toolName &&
        action.event.displayContent.path === fileProposal.path
      ) {
        writeCompleted = true;
      }
    });
    const result = await controller
      .resumeInteraction(decision)
      .finally(unsubscribe);
    if (
      fileProposal &&
      choice === "allow_session" &&
      !fileProposal.protected &&
      writeCompleted &&
      result.status !== "failed" &&
      result.status !== "cancelled"
    ) {
      writeGrantsForSession(sessionWriteGrants, sessionId).set(
        sessionWriteGrantKey(fileProposal.toolName, fileProposal.path),
        {
          contentHash: fileProposal.proposedContentHash,
          scopeDigest: fileProposal.scopeDigest,
          policyRevision: fileProposal.policyRevision,
        },
      );
    }
    if (
      commandProposal &&
      commandProposal.mode === "foreground" &&
      choice === "allow_session"
    ) {
      commandGrantsForSession(sessionCommandGrants, sessionId).set(
        sessionCommandGrantKey(commandProposal),
        { policyFingerprint: commandProposal.policyFingerprint },
      );
    }
    if (mcpProposal && choice === "allow_session") {
      mcpGrantsForSession(sessionMcpGrants, sessionId).add(
        mcpGrantKey(mcpProposal),
      );
    }
    if (
      commandProposal &&
      commandProposal.mode === "foreground" &&
      choice === "allow_rule"
    ) {
      await controller.addCommandRule({
        command: commandProposal.command,
        cwd: commandProposal.cwd,
        mode: commandProposal.mode,
        decision: "allow",
      });
    }
    if (result.status === "failed") {
      throw new Error(`Proposal failed: ${result.error.message}`);
    }
    if (result.status === "suspended") await reviewCurrentInteraction();
  };
  const submit = async (
    text: string,
    selectedAttachmentPaths: readonly string[] = [],
  ): Promise<InkChatSubmitResult> => {
    const command = parseTuiCommand(text);
    if (command) {
      switch (command.type) {
        case "exit":
          return { exit: true };
        case "help":
          await showHelp();
          return {};
        case "model":
          await chooseModel();
          return {};
        case "reasoning":
          await chooseReasoning();
          return {};
        case "mode":
          await showMode();
          return {};
        case "new":
          sessionId = await controller.newSession();
          return { status: `New session: ${sessionId}` };
        case "sessions":
          await chooseSession();
          return {};
        case "session-select":
          sessionId = await controller.selectSession(command.sessionId);
          if (controller.getState().pendingInteraction)
            await reviewCurrentInteraction();
          return { status: `Session: ${sessionId}` };
        case "processes":
          await manageProcesses();
          return {};
        case "output":
          return {
            status: renderCommandOutput(
              controller.observeCommand(command.commandId),
            ),
          };
        case "stop": {
          const stopped = await controller.stopCommand(command.commandId);
          return { status: `${stopped.commandId}\t${stopped.state}` };
        }
        case "agents":
          await manageAgents();
          return {};
        case "approvals":
          await reviewBackgroundApprovalsInTui();
          return { status: "Background approvals reviewed" };
        case "agent-stop": {
          const stopped = await controller.stopBackgroundAgent(
            command.childSessionId,
          );
          return { status: `${stopped.childSessionId}\t${stopped.lifecycle}` };
        }
        case "agent-steer": {
          const result = await controller.steerBackgroundAgent(
            command.childSessionId,
            command.message,
          );
          return {
            status: `${result.status === "queued" ? "Queued" : "Already queued"} steering for ${command.childSessionId}`,
          };
        }
      }
    }
    const attachmentPaths = [
      ...new Set([
        ...selectedAttachmentPaths,
        ...attachmentPathsFromText(text),
      ]),
    ];
    const resolved = await resolveCliAttachments(
      controller.getState().projectRoot,
      text,
      attachmentPaths,
    );
    const result = await controller.submit(resolved.text, resolved.attachments);
    if (result.status === "suspended") await reviewCurrentInteraction();
    return { status: controllerStatus(result) };
  };
  const requireControl = (): PresentTuiControl => {
    if (!presentControl) throw new Error("TUI control panel is unavailable");
    return presentControl;
  };
  const requestControl = createQueuedControlPresenter(
    controller,
    (request, signal) => requireControl()(request, signal),
  );
  const chooseSession = async () => {
    const sessions = await controller.listSessions();
    const response = await requestControl({
      id: `sessions:${Date.now()}`,
      title: "Switch session",
      body: ["Choose a saved project session."],
      options: sessions.map((session) => ({
        id: session.sessionId,
        label: session.sessionId,
        detail: `${session.state} · ${session.model ? `${session.model.providerId}/${session.model.modelId}` : "default model"}`,
      })),
    });
    if (response.cancelled || !response.optionId) return;
    sessionId = await controller.selectSession(response.optionId);
    if (controller.getState().pendingInteraction)
      await reviewCurrentInteraction();
  };
  const chooseModel = async () => {
    const models = await controller.listModels();
    const current = controller.getState().model;
    const response = await requestControl({
      id: `models:${Date.now()}`,
      title: "Choose model",
      body: [
        `${models.length} configured models from the shared AgentLink catalogue.`,
        "Changes apply to the current idle session.",
      ],
      options: models.map((model) => {
        const selected =
          model.ref.providerId === current?.providerId &&
          model.ref.modelId === current.modelId;
        const reasoning = model.reasoningEfforts?.join(", ") ?? "not supported";
        return {
          id: `${model.ref.providerId}/${model.ref.modelId}`,
          label: `${selected ? "✓ " : ""}${model.displayName}`,
          detail: `${model.providerDisplayName ?? model.providerId} · ${model.readiness?.status ?? (model.authenticated ? "ready" : "credentials required")} · reasoning ${reasoning}`,
        };
      }),
    });
    if (response.cancelled || !response.optionId) return;
    await controller.setModel(parseModelReference(response.optionId));
  };
  const chooseReasoning = async () => {
    const model = controller.getState().model;
    const models = await controller.listModels();
    const selected = models.find(
      (candidate) =>
        candidate.ref.providerId === model?.providerId &&
        candidate.ref.modelId === model.modelId,
    );
    const efforts = selected?.reasoningEfforts ?? [
      "none",
      "low",
      "medium",
      "high",
    ];
    const response = await requestControl({
      id: `reasoning:${Date.now()}`,
      title: "Reasoning effort",
      body: [
        selected
          ? `${selected.displayName} supports ${efforts.join(", ")}.`
          : "Choose the persisted reasoning effort for this session.",
      ],
      options: efforts.map((effort) => ({
        id: effort,
        label: `${effort === controller.getState().reasoningEffort ? "✓ " : ""}${effort}`,
        detail:
          effort === selected?.defaultReasoningEffort
            ? "model default"
            : undefined,
      })),
    });
    if (response.cancelled || !response.optionId) return;
    await controller.setReasoningEffort(
      response.optionId as import("@agentlink/core").CoreReasoningEffort,
    );
  };
  const showMode = async () => {
    await requestControl({
      id: `mode:${Date.now()}`,
      title: "Agent mode",
      body: [
        "Code mode is active.",
        "The standalone host currently exposes one coding-agent instruction profile.",
      ],
      options: [{ id: "code", label: "Code", detail: "active" }],
    });
  };
  const showWritePolicy = async () => {
    await requestControl({
      id: `write-policy:${Date.now()}`,
      title: "Write policy",
      body: [
        "Prompt is active.",
        "The standalone host always reviews ungranted writes and does not expose broader write-policy scopes.",
      ],
      options: [{ id: "prompt", label: "Prompt", detail: "active" }],
    });
  };
  const showHelp = async () => {
    await requestControl({
      id: `help:${Date.now()}`,
      title: "Keyboard shortcuts",
      body: renderTuiHelp().split("\n"),
      options: [{ id: "close", label: "Close" }],
    });
  };
  const manageProcesses = async () => {
    const records = controller.refreshActivity().commands;
    const response = await requestControl({
      id: `processes:${Date.now()}`,
      title: "Processes",
      body: [renderProcesses(records)],
      options: records.map((record) => ({
        id: record.commandId,
        label: record.command,
        detail: `${record.state} · ${record.commandId.slice(0, 10)}`,
      })),
    });
    if (response.cancelled || !response.optionId) return;
    const observation = controller.observeCommand(response.optionId);
    const detail = await requestControl({
      id: `process:${response.optionId}:${Date.now()}`,
      title: `Process ${response.optionId.slice(0, 10)}`,
      body: renderCommandOutput(observation).split("\n"),
      options: [
        { id: "back", label: "Back" },
        ...(observation.record.state === "running"
          ? [{ id: "stop", label: "Stop process", tone: "danger" as const }]
          : []),
      ],
    });
    if (!detail.cancelled && detail.optionId === "stop") {
      await controller.stopCommand(response.optionId);
    }
  };
  const manageAgents = async () => {
    const records = controller.refreshActivity().backgroundAgents;
    const response = await requestControl({
      id: `agents:${Date.now()}`,
      title: "Background agents",
      body: [renderBackgroundAgents(records)],
      options: records.map((record) => ({
        id: record.childSessionId,
        label: record.task,
        detail: `${record.lifecycle} · ${record.childSessionId.slice(0, 10)}`,
      })),
    });
    if (response.cancelled || !response.optionId) return;
    const record = records.find(
      (candidate) => candidate.childSessionId === response.optionId,
    );
    if (!record) return;
    const action = await requestControl({
      id: `agent:${record.childSessionId}:${Date.now()}`,
      title: record.task,
      body: [
        `${record.lifecycle} · ${record.phase}`,
        record.partialOutput ?? record.resultText ?? "No output yet",
      ],
      options: [
        { id: "steer", label: "Steer" },
        { id: "stop", label: "Stop", tone: "danger" },
      ],
    });
    if (action.cancelled) return;
    if (action.optionId === "stop") {
      await controller.stopBackgroundAgent(record.childSessionId);
    } else if (action.optionId === "steer") {
      const message = await requestControl({
        id: `steer:${record.childSessionId}:${Date.now()}`,
        title: "Steer background agent",
        body: [record.task],
        input: { placeholder: "Type guidance" },
      });
      if (!message.cancelled && message.text?.trim()) {
        await controller.steerBackgroundAgent(
          record.childSessionId,
          message.text.trim(),
        );
      }
    }
  };
  const reviewBackgroundApprovalsInTui = async () => {
    for (;;) {
      const record = controller.refreshActivity().backgroundApprovals[0];
      if (!record?.approval) return;
      const commandDisplay = isWorkspaceCommandApprovalDisplay(
        record.approval.displayContent,
      )
        ? record.approval.displayContent
        : undefined;
      const response = await requestControl({
        id: record.approval.interactionId,
        title: `Background approval · ${record.approval.toolName}`,
        body: [
          record.approval.summary,
          formatControlValue(record.approval.displayContent),
        ],
        ...(commandDisplay?.mode === "background"
          ? {
              input: {
                placeholder: 'Type "allow background" or leave blank to deny',
              },
            }
          : {
              options: [
                { id: "allow", label: "Approve once" },
                { id: "deny", label: "Deny", tone: "danger" },
              ],
            }),
      });
      const allowed =
        commandDisplay?.mode === "background"
          ? isBackgroundCommandAcknowledged(response)
          : !response.cancelled && response.optionId === "allow";
      if (commandDisplay?.mode === "background" && allowed) {
        controller.acknowledgeBackgroundCommand(commandDisplay.commandId);
      }
      await controller.respondToBackgroundApproval(
        record.childSessionId,
        record.approval.interactionId,
        allowed ? "allow" : "deny",
      );
    }
  };
  const openControlCenter = async () => {
    const response = await requestControl({
      id: `controls:${Date.now()}`,
      title: "AgentLink controls",
      body: [
        "Choose an action. All controls are also available from slash commands.",
      ],
      options: [
        { id: "approvals", label: "Approvals" },
        { id: "processes", label: "Processes" },
        { id: "agents", label: "Background agents" },
        { id: "sessions", label: "Sessions" },
        { id: "model", label: "Model" },
        { id: "reasoning", label: "Reasoning" },
        { id: "mode", label: "Mode" },
        { id: "write-policy", label: "Write policy" },
        { id: "help", label: "Keyboard shortcuts" },
      ],
    });
    if (response.cancelled) return;
    if (response.optionId === "approvals")
      await reviewBackgroundApprovalsInTui();
    if (response.optionId === "processes") await manageProcesses();
    if (response.optionId === "agents") await manageAgents();
    if (response.optionId === "sessions") await chooseSession();
    if (response.optionId === "model") await chooseModel();
    if (response.optionId === "reasoning") await chooseReasoning();
    if (response.optionId === "mode") await showMode();
    if (response.optionId === "write-policy") await showWritePolicy();
    if (response.optionId === "help") await showHelp();
  };
  interactionBridge.current = createInkInteractionBroker({
    controller,
    io,
    mcpLaunchGrants,
    mcpNetworkGrants,
    presentControl: requestControl,
    onStatus: updateExternalStatus,
  });
  const unsubscribeActivity = controller.subscribe((_state, action) => {
    if (action.type === "turn.event" || action.type === "turn.result") {
      controller.refreshActivity();
    }
  });
  const activityTimer = setInterval(() => controller.refreshActivity(), 500);
  activityTimer.unref();
  const mcpTimer = setInterval(
    () => void controller.refreshMcpState().catch(reportError),
    5_000,
  );
  mcpTimer.unref();
  const onSignal = () => {
    if (controller.getState().phase === "running") {
      void controller.cancel("Cancelled by user").catch(reportError);
    } else {
      closing = true;
      screen?.unmount();
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    screen = render(
      React.createElement(
        InkPictureProvider,
        null,
        React.createElement(InkChatApp, {
          controller,
          initialProjection: controller.getState(),
          initialStatus: initialized.restored
            ? `Restored session ${sessionId}`
            : `New session ${sessionId}`,
          externalStatusRevision,
          loadFileSuggestions,
          onSubmit: submit,
          onExit: () => {
            closing = true;
          },
          onError: reportError,
          registerControlPresenter,
          onOpenControlCenter: () =>
            void openControlCenter().catch(reportError),
        }),
      ),
      {
        stdin: io.input as NodeJS.ReadStream,
        stdout: io.output as NodeJS.WriteStream,
        stderr: io.error as NodeJS.WriteStream,
        exitOnCtrlC: false,
        interactive: true,
        alternateScreen: true,
        incrementalRendering: true,
        maxFps: 30,
      },
    );
    if (initialized.pendingInteraction) await reviewCurrentInteraction();
    await screen.waitUntilExit();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    clearInterval(activityTimer);
    clearInterval(mcpTimer);
    unsubscribeActivity();
    interactionBridge.current = undefined;
    controller.cancelPrompts("CLI session closing");
    if (!closing) screen?.unmount();
    try {
      await controller.close();
    } finally {
      await mcpOAuth.close().catch(() => undefined);
      await ownership.release();
    }
  }
}

function requireInteractionBroker(
  bridge: CliInteractionBridge,
): CliInteractionBroker {
  if (!bridge.current) throw new Error("CLI interaction broker is unavailable");
  return bridge.current;
}

export function createQueuedControlPresenter(
  controller: Pick<StandaloneSessionController, "runPrompt">,
  presentControl: PresentTuiControl,
): PresentTuiControl {
  return (request, operationSignal) =>
    controller.runPrompt(async (sessionSignal) => {
      const signal = operationSignal
        ? AbortSignal.any([sessionSignal, operationSignal])
        : sessionSignal;
      if (signal.aborted) throw abortError("Session prompts are cancelled");
      const response = await presentControl(request, signal);
      if (signal.aborted || (response.cancelled && response.terminate)) {
        throw abortError("Session prompts are cancelled");
      }
      return response;
    });
}

export function createInkInteractionBroker(options: {
  readonly controller: StandaloneSessionController;
  readonly io: CliIo;
  readonly mcpLaunchGrants: Set<string>;
  readonly mcpNetworkGrants: Set<string>;
  readonly presentControl: PresentTuiControl;
  readonly onStatus: (status: string) => void;
}): CliInteractionBroker {
  return {
    notifyMcpStatus(message) {
      options.onStatus(message);
    },
    notifyMcpServers(servers) {
      if (servers.length === 0) return;
      options.onStatus(
        servers
          .map(
            (server) =>
              `MCP ${server.name}: ${server.status}${server.error ? ` (${server.error})` : ""}`,
          )
          .join("; "),
      );
    },
    async elicitMcpForm(request) {
      if (request.signal?.aborted) return { action: "cancel" };
      const values: Record<string, unknown> = {};
      try {
        const decision = await options.presentControl(
          {
            id: `mcp-elicitation:${request.serverName}:${Date.now()}`,
            kind: "approval",
            title: `MCP input requested by ${request.serverName}`,
            body: [request.message],
            options: [
              { id: "accept", label: "Continue" },
              { id: "decline", label: "Decline" },
            ],
            cancellable: true,
          },
          request.signal,
        );
        if (decision.cancelled || request.signal?.aborted)
          return { action: "cancel" };
        if (decision.optionId !== "accept") return { action: "decline" };
        for (const field of request.fields) {
          const answer = await options.presentControl(
            {
              id: `mcp-elicitation:${request.serverName}:${field.name}:${Date.now()}`,
              kind: "question",
              title: field.title || field.name,
              body: [
                ...(field.description ? [field.description] : []),
                `From ${request.serverName}. ${field.required ? "Required" : "Optional"}.`,
                ...(field.kind === "multi-select"
                  ? ["Enter comma-separated option values."]
                  : []),
              ],
              ...(field.kind === "boolean"
                ? {
                    options: [
                      { id: "true", label: "Yes" },
                      { id: "false", label: "No" },
                    ],
                  }
                : field.kind === "single-select"
                  ? {
                      options: field.options.map((option) => ({
                        id: option.value,
                        label: option.title || option.value,
                      })),
                    }
                  : {
                      input: {
                        placeholder: field.name,
                        initialValue:
                          field.default === undefined
                            ? undefined
                            : String(field.default),
                      },
                    }),
              cancellable: true,
            },
            request.signal,
          );
          if (answer.cancelled || request.signal?.aborted)
            return { action: "cancel" };
          const value = answer.optionId ?? answer.text;
          if (value === undefined || (value === "" && !field.required))
            continue;
          values[field.name] =
            field.kind === "boolean"
              ? value === "true"
              : field.kind === "multi-select"
                ? value
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean)
                : value;
        }
        const validated = validateAndCoerceMcpElicitationValues(
          request.fields,
          values,
        );
        if (!validated.ok) {
          options.onStatus(
            `MCP input rejected: ${Object.entries(validated.errors)
              .map(([name, error]) => `${name}: ${error}`)
              .join("; ")}`,
          );
          return { action: "decline" };
        }
        if (request.signal?.aborted) return { action: "cancel" };
        return { action: "accept", content: validated.values };
      } catch {
        return { action: "cancel" };
      }
    },
    notifyBackgroundApproval(request) {
      options.controller.notifyBackgroundApproval();
      options.onStatus(
        `Background child ${request.childSessionId} is awaiting approval. Open Controls > Approvals.`,
      );
    },
    async askQuestion(request) {
      const response = await options.presentControl({
        id: request.id,
        kind: "question",
        title: "Agent question",
        body: [...(request.context ? [request.context] : []), request.question],
        ...(request.kind === "text"
          ? { input: { placeholder: "Type your answer" } }
          : {
              options: request.options.map((label) => ({
                id: label,
                label,
                ...(label === request.recommended
                  ? { detail: "recommended" }
                  : {}),
              })),
            }),
      });
      if (response.cancelled) throw abortError("Question cancelled by user");
      return response.text?.trim() || response.optionId || "";
    },
    async confirmMcpLaunch(proposal) {
      if (options.mcpLaunchGrants.has(proposal.operationDigest)) return true;
      const response = await options.presentControl({
        id: `mcp-launch:${proposal.operationDigest}`,
        kind: "approval",
        title: "Review unsandboxed MCP server launch",
        body: [
          `Server: ${proposal.serverId} (${proposal.source})`,
          `Command: ${proposal.command}`,
          `Arguments: ${JSON.stringify(proposal.args)}`,
          `Working directory: ${proposal.cwd}`,
          `Environment keys: ${proposal.environmentKeys.join(", ") || "none"}`,
          `Credential references: ${proposal.credentialIds.join(", ") || "none"}`,
        ],
        options: [
          { id: "allow", label: "Allow for this CLI process" },
          { id: "deny", label: "Deny", tone: "danger" },
        ],
      });
      const allowed = !response.cancelled && response.optionId === "allow";
      if (allowed) options.mcpLaunchGrants.add(proposal.operationDigest);
      return allowed;
    },
    async confirmMcpNetwork(proposal) {
      if (options.mcpNetworkGrants.has(proposal.operationDigest)) return true;
      const response = await options.presentControl({
        id: `mcp-network:${proposal.operationDigest}`,
        kind: "approval",
        title: "Review MCP network destination",
        body: [
          `Server: ${proposal.serverId} (${proposal.source})`,
          `Configured endpoint: ${proposal.configuredEndpoint}`,
          `Destination: ${proposal.destination}`,
          `Headers: ${proposal.headerNames.join(", ") || "none"}`,
          `Credential references: ${proposal.credentialIds.join(", ") || "none"}`,
        ],
        options: [
          { id: "allow", label: "Allow for this CLI process" },
          { id: "deny", label: "Deny", tone: "danger" },
        ],
      });
      const allowed = !response.cancelled && response.optionId === "allow";
      if (allowed) options.mcpNetworkGrants.add(proposal.operationDigest);
      return allowed;
    },
    async confirmSharedMcpAdmission(proposal) {
      if (options.mcpLaunchGrants.has(proposal.operationDigest)) return true;
      const response = await options.presentControl({
        id: `shared-mcp-admission:${proposal.operationDigest}`,
        kind: "approval",
        title: "Trust project MCP server definition",
        body: [
          `Project: ${proposal.projectRoot}`,
          `Server: ${proposal.serverId}`,
          `Transport: ${proposal.transport}`,
          ...(proposal.command ? [`Command: ${proposal.command}`] : []),
          `Arguments: ${proposal.argumentCount} (values omitted; inspect the MCP config before approving)`,
          ...(proposal.configuredEndpoint
            ? [`Configured endpoint: ${proposal.configuredEndpoint}`]
            : []),
          `Environment keys: ${proposal.environmentKeys.join(", ") || "none"}`,
          `Header names: ${proposal.headerNames.join(", ") || "none"}`,
          "Trust this project's effective server definition for this CLI process only. Launch and destination still require separate approval.",
        ],
        options: [
          { id: "allow", label: "Trust for this CLI process" },
          { id: "deny", label: "Deny", tone: "danger" },
        ],
      });
      const allowed = !response.cancelled && response.optionId === "allow";
      if (allowed) options.mcpLaunchGrants.add(proposal.operationDigest);
      return allowed;
    },
    async confirmSharedMcpLaunch(proposal) {
      if (options.mcpLaunchGrants.has(proposal.operationDigest)) return true;
      const response = await options.presentControl({
        id: `shared-mcp-launch:${proposal.operationDigest}`,
        kind: "approval",
        title: "Review unsandboxed MCP server launch",
        body: [
          `Server: ${proposal.serverId}`,
          `Command: ${proposal.command}`,
          `Arguments: ${proposal.argumentCount} (values omitted; inspect the MCP config before approving)`,
          `Working directory: ${proposal.cwd}`,
          `Environment keys: ${proposal.environmentKeys.join(", ") || "none"}`,
        ],
        options: [
          { id: "allow", label: "Allow for this CLI process" },
          { id: "deny", label: "Deny", tone: "danger" },
        ],
      });
      const allowed = !response.cancelled && response.optionId === "allow";
      if (allowed) options.mcpLaunchGrants.add(proposal.operationDigest);
      return allowed;
    },
    async confirmSharedMcpNetwork(proposal) {
      if (options.mcpNetworkGrants.has(proposal.operationDigest)) return true;
      const response = await options.presentControl({
        id: `shared-mcp-network:${proposal.operationDigest}`,
        kind: "approval",
        title: "Review MCP network destination",
        body: [
          `Server: ${proposal.serverId}`,
          `Configured endpoint: ${proposal.configuredEndpoint}`,
          `Destination: ${proposal.destination}`,
          `Headers: ${proposal.headerNames.join(", ") || "none"}`,
          `OAuth: ${proposal.oauth ? "yes" : "no"}`,
        ],
        options: [
          { id: "allow", label: "Allow for this CLI process" },
          { id: "deny", label: "Deny", tone: "danger" },
        ],
      });
      const allowed = !response.cancelled && response.optionId === "allow";
      if (allowed) options.mcpNetworkGrants.add(proposal.operationDigest);
      return allowed;
    },
    async confirmMcpOAuth(request) {
      const response = await options.presentControl({
        id: `mcp-oauth:${request.serverId}:${Date.now()}`,
        kind: "approval",
        title: "Review MCP OAuth browser launch",
        body: [
          `Server: ${request.serverId}`,
          `Authorization origin: ${new URL(request.authorizationUrl).origin}`,
        ],
        options: [
          { id: "open", label: "Open browser" },
          { id: "deny", label: "Deny", tone: "danger" },
        ],
      });
      return !response.cancelled && response.optionId === "open";
    },
  };
}

async function listTuiFileSuggestions(
  projectRoot: string,
  query: string,
): Promise<readonly TuiPickerItem[]> {
  const normalizedQuery = query.toLowerCase();
  const results: TuiPickerItem[] = [];
  const queue = [""];
  while (queue.length > 0 && results.length < 50) {
    const relativeDirectory = queue.shift()!;
    const absoluteDirectory = path.join(projectRoot, relativeDirectory);
    let entries;
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (
        entry.name === ".git" ||
        entry.name === "node_modules" ||
        entry.name === ".agentlink" ||
        entry.name === ".env" ||
        entry.name.startsWith(".env.")
      ) {
        continue;
      }
      const relativePath = path.posix.join(
        relativeDirectory.split(path.sep).join(path.posix.sep),
        entry.name,
      );
      if (
        entry.isSymbolicLink() ||
        sanitizeTerminalText(relativePath) !== relativePath
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        if (relativePath.split("/").length <= 6) queue.push(relativePath);
        continue;
      }
      if (
        !entry.isFile() ||
        !relativePath.toLowerCase().includes(normalizedQuery)
      ) {
        continue;
      }
      results.push({
        id: relativePath,
        label: relativePath,
        detail: "project file",
        insertText: relativePath,
      });
      if (results.length >= 50) break;
    }
  }
  return results.slice(0, 8);
}

function mcpGrantsForSession(
  grants: Map<string, Set<string>>,
  sessionId: string,
): Set<string> {
  const existing = grants.get(sessionId);
  if (existing) return existing;
  const created = new Set<string>();
  grants.set(sessionId, created);
  return created;
}

function mcpGrantKey(
  proposal: WorkspaceMcpToolApprovalDisplay | WorkspaceSharedMcpToolApproval,
): string {
  return JSON.stringify([
    proposal.serverId,
    proposal.serverToolName,
    proposal.configurationDigest,
  ]);
}

interface CliSessionCommandGrant {
  readonly policyFingerprint: string;
}

interface CliSessionWriteGrant {
  readonly contentHash: string;
  readonly scopeDigest: string;
  readonly policyRevision: string;
}

function commandGrantsForSession(
  grants: Map<string, Map<string, CliSessionCommandGrant>>,
  sessionId: string,
): Map<string, CliSessionCommandGrant> {
  const existing = grants.get(sessionId);
  if (existing) return existing;
  const created = new Map<string, CliSessionCommandGrant>();
  grants.set(sessionId, created);
  return created;
}

function sessionCommandGrantKey(
  proposal: WorkspaceCommandApprovalDisplay,
): string {
  return JSON.stringify([proposal.command, proposal.cwd, proposal.mode]);
}

function writeGrantsForSession(
  grants: Map<string, Map<string, CliSessionWriteGrant>>,
  sessionId: string,
): Map<string, CliSessionWriteGrant> {
  const existing = grants.get(sessionId);
  if (existing) return existing;
  const created = new Map<string, CliSessionWriteGrant>();
  grants.set(sessionId, created);
  return created;
}

function sessionWriteGrantKey(toolName: string, relativePath: string): string {
  return JSON.stringify([toolName, relativePath]);
}

function advanceSessionWriteGrant(
  grants: Map<string, CliSessionWriteGrant>,
  toolName: string,
  displayContent: unknown,
): void {
  if (!isDurableWriteResult(displayContent)) return;
  const result = displayContent as { path: string; contentHash: string };
  const key = sessionWriteGrantKey(toolName, result.path);
  const current = grants.get(key);
  if (!current) return;
  grants.set(key, { ...current, contentHash: result.contentHash });
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function isBackgroundCommandAcknowledged(
  response: import("./tui/controlTypes.js").TuiControlResponse,
): boolean {
  return (
    !response.cancelled &&
    response.text?.trim().toLowerCase() === "allow background"
  );
}

function isDurableWriteResult(value: unknown): value is {
  readonly path: string;
  readonly contentHash: string;
  readonly durability: {
    readonly status: "durable";
    readonly outcome: "exact";
  };
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as {
    path?: unknown;
    contentHash?: unknown;
    durability?: unknown;
  };
  const durability = result.durability;
  return (
    typeof result.path === "string" &&
    typeof result.contentHash === "string" &&
    Boolean(durability) &&
    typeof durability === "object" &&
    !Array.isArray(durability) &&
    (durability as { status?: unknown }).status === "durable" &&
    (durability as { outcome?: unknown }).outcome === "exact"
  );
}

function proposalBody(
  proposal:
    | WorkspaceFileApprovalDisplay
    | WorkspaceCommandApprovalDisplay
    | WorkspaceMcpToolApprovalDisplay
    | WorkspaceSharedMcpToolApproval,
): readonly string[] {
  if (isWorkspaceFileProposal(proposal)) {
    return [
      `Baseline: ${proposal.expectedContentHash ?? "absent"}`,
      `Proposed: ${proposal.proposedContentHash} (${proposal.bytes} bytes)`,
      ...(proposal.protected
        ? [`Protected: ${proposal.protectionReason ?? "yes"}`]
        : []),
      ...proposal.diff.split("\n"),
    ];
  }
  if (isWorkspaceCommandApprovalDisplay(proposal)) {
    return [
      `Command: ${proposal.command}`,
      `Executable: ${proposal.executable}`,
      `Arguments: ${JSON.stringify(proposal.args)}`,
      `Working directory: ${proposal.cwd}`,
      `Environment keys: ${proposal.environmentKeys.join(", ") || "none"}`,
      `Timeout: ${proposal.timeoutMs} ms`,
      proposal.concurrentEditingWarning
        ? "Warning: this background process may modify project files while editing continues."
        : "This command holds the exclusive project mutation window until it exits.",
    ];
  }
  return [
    `Server: ${proposal.serverId}${"source" in proposal ? ` (${proposal.source})` : ""}`,
    `Tool: ${proposal.serverToolName}`,
    "The MCP server is unsandboxed and its result is untrusted external content.",
    formatControlValue(proposal),
  ];
}

function formatControlValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isReviewableProposal(
  value: unknown,
): value is
  | WorkspaceFileApprovalDisplay
  | WorkspaceCommandApprovalDisplay
  | WorkspaceMcpToolApprovalDisplay
  | WorkspaceSharedMcpToolApproval {
  return (
    isWorkspaceFileProposal(value) ||
    isWorkspaceCommandApprovalDisplay(value) ||
    isWorkspaceMcpToolApprovalDisplay(value) ||
    isWorkspaceSharedMcpToolApproval(value)
  );
}

function isWorkspaceFileProposal(
  value: unknown,
): value is WorkspaceFileApprovalDisplay {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proposal = value as Partial<WorkspaceFileApprovalDisplay>;
  return (
    proposal.kind === "file_write" &&
    (proposal.toolName === "write_file" ||
      proposal.toolName === "apply_diff") &&
    typeof proposal.path === "string" &&
    typeof proposal.diff === "string" &&
    (proposal.operation === "created" || proposal.operation === "modified") &&
    typeof proposal.operationDigest === "string" &&
    typeof proposal.policyRevision === "string" &&
    typeof proposal.scopeDigest === "string" &&
    typeof proposal.proposedContentHash === "string" &&
    typeof proposal.bytes === "number" &&
    typeof proposal.protected === "boolean"
  );
}

async function signInCodex(
  manager: CodexOAuthManager,
  io: CliIo,
): Promise<number> {
  const authorizationUrl = manager.startAuthorizationFlow();
  const callback = manager.waitForCallback();
  void callback.catch(() => undefined);
  try {
    await io.openExternal(authorizationUrl);
    io.output.write("Complete sign-in in your browser.\n");
    const credentials = await callback;
    const result = await manager.saveOAuthAccount(credentials, {
      makeActive: true,
    });
    io.output.write(`Signed in as ${result.account.label}.\n`);
    return 0;
  } catch (error) {
    manager.cancelAuthorizationFlow();
    throw error;
  }
}

async function printMcpStatus(
  dataRoot: string,
  projectRoot: string,
  io: CliIo,
): Promise<number> {
  const globalConfigPath = await ensureCliMcpGlobalConfig(dataRoot);
  const projectConfigPath = cliMcpProjectConfigPath(projectRoot);
  const project = await inspectCliMcpProjectConfig(projectRoot);
  const [trusted, declared] = await Promise.all([
    loadWorkspaceMcpConfiguration({
      globalConfigPath,
      projectRoot,
      projectConfigPath: project.legacyConfigPath,
    }),
    project.legacyConfigPath
      ? inspectWorkspaceMcpProjectDeclarations(
          projectRoot,
          project.legacyConfigPath,
        )
      : Promise.resolve({ servers: [] }),
  ]);
  const sharedServerNames = await inspectCliSharedMcpServers(projectRoot);
  const shadowedLegacyServerIds = new Set(
    await inspectCliSharedMcpServers(projectRoot, process.env, true),
  );
  const trustedIds = new Set(trusted.servers.map((server) => server.id));
  io.output.write(
    `${JSON.stringify(
      {
        globalConfigPath: cliMcpGlobalConfigPath(dataRoot),
        projectConfigPath,
        sharedServersConfigured: sharedServerNames,
        configured: trusted.servers
          .filter((server) => !shadowedLegacyServerIds.has(server.id))
          .map(publicMcpServer),
        shadowedLegacyServerIds: trusted.servers
          .filter((server) => shadowedLegacyServerIds.has(server.id))
          .map((server) => server.id),
        untrustedProjectDeclarations: declared.servers
          .filter(
            (server) =>
              !trustedIds.has(server.id) &&
              !shadowedLegacyServerIds.has(server.id),
          )
          .map(publicMcpServer),
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

async function trustProjectMcpServer(
  dataRoot: string,
  projectRoot: string,
  serverId: string,
  io: CliIo,
): Promise<number> {
  const project = await inspectCliMcpProjectConfig(projectRoot);
  if (!project.legacyConfigPath) {
    throw new Error(
      "Shared MCP server trust is not supported in the CLI yet; no server was trusted",
    );
  }
  const declared = await inspectWorkspaceMcpProjectDeclarations(
    projectRoot,
    project.legacyConfigPath,
  );
  const server = declared.servers.find(
    (candidate) => candidate.id === serverId,
  );
  if (
    (await inspectCliSharedMcpServers(projectRoot, process.env, true)).includes(
      serverId,
    )
  ) {
    throw new Error(
      `Shared MCP server shadows legacy project server: ${serverId}`,
    );
  }
  if (!server) {
    throw new Error(`Project MCP server is not declared: ${serverId}`);
  }
  io.output.write(
    `\nReview project MCP server ${server.id}\n${JSON.stringify(
      publicMcpServer(server),
      null,
      2,
    )}\n` +
      "Project declarations have no authority until trusted. Local processes are unsandboxed and remote servers can return untrusted content.\n",
  );
  const readline = createInterface({ input: io.input, output: io.output });
  let answer: string;
  try {
    answer = (
      await readline.question(
        `Type "trust ${server.id}" to trust this exact server ID, or press Enter to deny: `,
      )
    ).trim();
  } finally {
    readline.close();
  }
  if (answer !== `trust ${server.id}`) {
    io.output.write("Project MCP server was not trusted.\n");
    return 1;
  }
  await trustCliProjectMcpServer(dataRoot, server.id);
  io.output.write(`Trusted project MCP server ${server.id}.\n`);
  return 0;
}

function publicMcpServer(server: {
  readonly id: string;
  readonly source: "global" | "project";
  readonly transport: "stdio" | "streamable-http";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, { readonly credential: string }>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, { readonly credential: string }>>;
  readonly oauth?: boolean;
  readonly timeoutMs?: number;
}) {
  return server.transport === "stdio"
    ? {
        id: server.id,
        source: server.source,
        transport: server.transport,
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        environment: Object.fromEntries(
          Object.entries(server.env ?? {}).map(([name, reference]) => [
            name,
            reference.credential,
          ]),
        ),
        timeoutMs: server.timeoutMs,
        unsandboxed: true,
      }
    : {
        id: server.id,
        source: server.source,
        transport: server.transport,
        url: server.url,
        headers: Object.fromEntries(
          Object.entries(server.headers ?? {}).map(([name, reference]) => [
            name,
            reference.credential,
          ]),
        ),
        oauth: server.oauth,
        timeoutMs: server.timeoutMs,
      };
}

async function printStatus(
  host: WorkspaceHost,
  config: CliConfig,
  manager: CodexOAuthManager,
  io: CliIo,
): Promise<number> {
  const [oauthAccounts, openAiKey, sessions, languageIntelligence] =
    await Promise.all([
      manager.listAccounts(),
      getApiKey(OPENAI_API_KEY_ACCOUNT),
      host.listSessions(),
      host.languageStatus(),
    ]);
  io.output.write(
    `${JSON.stringify(
      {
        version: __AGENTLINK_CLI_VERSION__,
        project: host.project,
        defaultModel: config.defaultModel,
        providers: {
          codex: {
            accounts: oauthAccounts.length,
            active: oauthAccounts.find((a) => a.isActive)?.label,
          },
          openai: { configured: Boolean(openAiKey) },
          compatible: config.compatibleProviders.map((provider) => ({
            id: provider.id,
            noAuth: Boolean(provider.noAuth),
            models: provider.models.map((model) => model.id),
          })),
        },
        sessions: sessions.length,
        languageIntelligence,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

async function printSessions(
  source: { listSessions(): Promise<readonly StandaloneSessionSummary[]> },
  io: CliIo,
): Promise<number> {
  const sessions = await source.listSessions();
  if (sessions.length === 0) {
    io.output.write("No saved sessions.\n");
    return 0;
  }
  for (const session of sessions) {
    io.output.write(
      `${session.sessionId}\t${session.state}\t${new Date(session.updatedAt).toISOString()}\t${session.model ? `${session.model.providerId}/${session.model.modelId}` : "default"}\n`,
    );
  }
  return 0;
}

async function configureCompatibleProvider(
  config: CliConfig,
  values: readonly string[],
  io: CliIo,
): Promise<CliConfig> {
  const [id, baseURL, modelId, contextText, outputText, authMode] = values;
  if (authMode !== undefined && authMode !== "no-auth") {
    throw new Error('Authentication mode must be omitted or "no-auth"');
  }
  const requestedBaseUrl = new URL(requiredText(baseURL, "base URL"));
  const provider = parseCliConfig({
    ...config,
    compatibleProviders: [
      {
        id: requiredText(id, "provider id"),
        baseURL: requestedBaseUrl.toString(),
        noAuth: authMode === "no-auth",
        allowInsecureHttp: requestedBaseUrl.protocol === "http:",
        models: [
          {
            id: requiredText(modelId, "model id"),
            contextWindow: positiveInteger(contextText, "context window"),
            maxOutputTokens: positiveInteger(
              outputText,
              "maximum output tokens",
            ),
            supportsToolUse: true,
            supportsThinking: false,
          },
        ],
      },
    ],
  }).compatibleProviders[0]!;
  if (!provider.noAuth) {
    requireTty(io, "OpenAI-compatible API-key setup");
    await setApiKey(
      compatibleCredentialAccount(provider),
      await io.readSecret(`${provider.id} API key: `),
    );
  }
  return {
    ...config,
    compatibleProviders: [
      ...config.compatibleProviders.filter((item) => item.id !== provider.id),
      provider,
    ],
  };
}

async function confirmTyped(
  io: CliIo,
  prompt: string,
  expected: string,
): Promise<boolean> {
  const readline = createInterface({ input: io.input, output: io.output });
  try {
    return (await readline.question(prompt)).trim() === expected;
  } finally {
    readline.close();
  }
}

function requireTty(io: CliIo, action: string): void {
  if (!io.isTty) throw new Error(`${action} requires an interactive terminal`);
}

function resolveConfiguredProviderId(
  config: CliConfig,
  modelId: string,
): string | undefined {
  if (config.codexModels.includes(modelId)) return "codex";
  if (config.openAiModels.includes(modelId)) return "openai";
  return config.compatibleProviders.find((provider) =>
    provider.models.some((model) => model.id === modelId),
  )?.id;
}

function parseModelReference(value: string) {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error("Model must use provider/model format");
  }
  return { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

type ParsedArguments =
  | { command: "version"; project?: string }
  | { command: "chat"; project?: string; session?: string }
  | {
      command:
        | "status"
        | "sessions"
        | "auth-codex"
        | "auth-openai"
        | "config-show"
        | "lsp-disable"
        | "lsp-enable"
        | "lsp-install"
        | "lsp-remove"
        | "lsp-status"
        | "lsp-update"
        | "mcp-status";
      project?: string;
    }
  | {
      command:
        | "delete"
        | "config-model"
        | "mcp-trust"
        | "mcp-credential"
        | "mcp-reauthenticate";
      value: string;
      project?: string;
    }
  | {
      command: "config-compatible";
      values: readonly string[];
      project?: string;
    };

function parseArguments(
  argv: readonly string[],
  io: CliIo,
): ParsedArguments | { exitCode: number } {
  let parsed: ParsedArguments | undefined;
  const program = new Command()
    .name("agentlink")
    .description("Terminal-native AgentLink coding agent")
    .version(__AGENTLINK_CLI_VERSION__, "-v, --version")
    .option("--project <path>", "project directory", process.cwd())
    .showHelpAfterError()
    .showSuggestionAfterError()
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.output.write(text),
      writeErr: (text) => io.error.write(text),
    });
  const project = (command: Command): string | undefined =>
    command.optsWithGlobals<{ project?: string }>().project;
  const select = (value: ParsedArguments) => {
    parsed = value;
  };

  program
    .command("chat")
    .description("start or resume an interactive coding session")
    .option("--session <id>", "resume an exact session")
    .action((_options: unknown, command: Command) => {
      const options = command.opts<{ session?: string }>();
      select({
        command: "chat",
        project: project(command),
        session: options.session,
      });
    });
  for (const commandName of ["status", "sessions"] as const) {
    program
      .command(commandName)
      .description(
        commandName === "status"
          ? "show project and provider readiness"
          : "list saved project sessions",
      )
      .action((_options: unknown, command: Command) => {
        select({ command: commandName, project: project(command) });
      });
  }
  program
    .command("delete <session>")
    .description("delete a saved project session")
    .action((value: string, _options: unknown, command: Command) => {
      select({ command: "delete", value, project: project(command) });
    });
  program.command("version", { hidden: true }).action(() => {
    select({ command: "version" });
  });

  const auth = program
    .command("auth")
    .description("configure provider credentials");
  auth
    .command("codex")
    .description("sign in with ChatGPT/Codex OAuth")
    .action((_options: unknown, command: Command) => {
      select({ command: "auth-codex", project: project(command) });
    });
  auth
    .command("openai")
    .description("store an OpenAI API key in macOS Keychain")
    .action((_options: unknown, command: Command) => {
      select({ command: "auth-openai", project: project(command) });
    });

  const config = program
    .command("config")
    .description("manage CLI configuration");
  config
    .command("show")
    .description("show non-secret configuration")
    .action((_options: unknown, command: Command) => {
      select({ command: "config-show", project: project(command) });
    });
  config
    .command("model <provider/model>")
    .description("select the default coding model")
    .action((value: string, _options: unknown, command: Command) => {
      select({ command: "config-model", value, project: project(command) });
    });
  config
    .command(
      "compatible <id> <base-url> <model> <context-tokens> <output-tokens> [no-auth]",
    )
    .description("configure an OpenAI-compatible provider")
    .action(
      (
        id: string,
        baseUrl: string,
        model: string,
        contextTokens: string,
        outputTokens: string,
        authMode: string | undefined,
        _options: unknown,
        command: Command,
      ) => {
        select({
          command: "config-compatible",
          values: [
            id,
            baseUrl,
            model,
            contextTokens,
            outputTokens,
            authMode,
          ].filter((value): value is string => value !== undefined),
          project: project(command),
        });
      },
    );

  const lsp = program
    .command("lsp")
    .description("manage optional TypeScript/JavaScript intelligence");
  for (const commandName of [
    "status",
    "install",
    "update",
    "enable",
    "disable",
    "remove",
  ] as const) {
    lsp
      .command(commandName)
      .description(
        commandName === "status"
          ? "show installation and project enablement"
          : `${commandName} managed TypeScript/JavaScript intelligence`,
      )
      .action((_options: unknown, command: Command) => {
        select({ command: `lsp-${commandName}`, project: project(command) });
      });
  }

  const mcp = program
    .command("mcp")
    .description("manage MCP servers and credentials");
  mcp
    .command("status")
    .description("show configured servers and trust state")
    .action((_options: unknown, command: Command) => {
      select({ command: "mcp-status", project: project(command) });
    });
  mcp
    .command("trust <server-id>")
    .description("review and trust a project MCP declaration")
    .action((value: string, _options: unknown, command: Command) => {
      select({ command: "mcp-trust", value, project: project(command) });
    });
  mcp
    .command("reauthenticate <server-name>")
    .description("replace this CLI's OAuth credentials for a remote MCP server")
    .action((value: string, _options: unknown, command: Command) => {
      select({
        command: "mcp-reauthenticate",
        value,
        project: project(command),
      });
    });
  mcp
    .command("credential <credential-id>")
    .description("store an MCP credential in macOS Keychain")
    .action((value: string, _options: unknown, command: Command) => {
      select({ command: "mcp-credential", value, project: project(command) });
    });

  let args = [...argv];
  if (usesImplicitChat(args)) args = ["chat", ...args];
  if (args.length === 1 && (args[0] === "lsp" || args[0] === "mcp")) {
    args.push("status");
  }
  try {
    program.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return { exitCode: error.exitCode };
    throw error;
  }
  if (!parsed) throw new Error("CLI command did not resolve to an action");
  return parsed;
}

function usesImplicitChat(args: readonly string[]): boolean {
  if (args.length === 0) return true;
  if (args.includes("--help") || args.includes("-h")) return false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--project") {
      index += 1;
      continue;
    }
    if (!args[index]?.startsWith("-")) return false;
  }
  return true;
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function requiredText(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function openExternal(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", [url], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`Could not open browser (exit ${code ?? "unknown"})`));
    });
  });
}
