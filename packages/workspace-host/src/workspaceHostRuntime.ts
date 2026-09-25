import {
  createTurnInteractionTokenService,
  type AgentEngine,
  type AgentModelReference,
  type AgentPrincipal,
  type AgentTurnAttachment,
  type AgentTurnEvent,
  type AgentTurnResult,
  type CoreReasoningEffort,
  type HostTool,
} from "@agentlink/core";
import {
  createFileNodeHostPersistence,
  createNodeHostAgent,
} from "@agentlink/node-host";
import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

import {
  createWorkspaceArtifactTools,
  type WorkspaceArtifactRoot,
} from "./artifactTools.js";
import {
  readWorkspaceBackgroundSessionIds,
  WorkspaceBackgroundSupervisor,
} from "./backgroundSupervisor.js";
import { createWorkspaceBackgroundTools } from "./backgroundTools.js";
import {
  createWorkspaceCommandTools,
  isWorkspaceCommandApprovalDisplay,
  type WorkspaceCommandApprovalDisplay,
  type WorkspaceCommandRule,
} from "./commandTools.js";
import {
  WorkspaceCommandSupervisor,
  type WorkspaceCommandIdentity,
  type WorkspaceCommandObservation,
  type WorkspaceCommandRecord,
} from "./commandSupervisor.js";
import {
  createWorkspaceFileTools,
  workspaceFileScopesContain,
  type ResolveWorkspaceFileScopes,
  type WorkspaceFileApprovalPolicy,
} from "./fileTools.js";
import {
  createWorkspaceMcpToolApproval,
  createWorkspaceMcpTools,
  isWorkspaceMcpToolApprovalDisplay,
  validateWorkspaceMcpToolApproval,
  type CreateWorkspaceMcpToolsOptions,
  type WorkspaceMcpToolApprovalDisplay,
} from "./mcpTools.js";
import type { WorkspaceMcpConfiguration } from "./mcpConfig.js";
import {
  createWorkspaceSharedMcpTools,
  isWorkspaceSharedMcpToolApproval,
  sameWorkspaceSharedMcpToolApproval,
  type CreateWorkspaceSharedMcpToolsOptions,
  type WorkspaceSharedMcpToolApproval,
} from "./sharedMcpTools.js";
import { getManagedTypeScriptStatus } from "./managedTypeScriptInstaller.js";
import { ManagedTypeScriptService } from "./managedTypeScriptService.js";
import {
  createManagedTypeScriptTools,
  sanitizeManagedTypeScriptResult,
} from "./managedTypeScriptTools.js";
import { WorkspaceMutationCoordinator } from "./mutationCoordinator.js";
import {
  createWorkspaceSessionInteractionTools,
  type CreateWorkspaceSessionInteractionToolsOptions,
} from "./sessionInteractionTools.js";
import {
  createWorkspaceModelRuntime,
  type WorkspaceModelRequestLimits,
  type WorkspaceProviderConfig,
} from "./modelRuntime.js";
import {
  resolveWorkspaceProject,
  type WorkspaceProjectIdentity,
} from "./projectIdentity.js";

export interface CreateWorkspaceHostOptions {
  readonly projectRoot: string;
  readonly dataRoot: string;
  readonly ownerId: string;
  readonly providers: readonly WorkspaceProviderConfig[];
  readonly defaultModel: AgentModelReference;
  readonly defaultReasoningEffort?: CoreReasoningEffort;
  readonly requestLimits?: WorkspaceModelRequestLimits;
  readonly instructions?: string;
  readonly artifacts?: {
    readonly roots: readonly WorkspaceArtifactRoot[];
  };
  readonly files?: {
    readonly enabled: true;
    readonly approvalPolicy?: WorkspaceFileApprovalPolicy;
    readonly resolveScopes?: ResolveWorkspaceFileScopes;
    readonly ripgrepExecutable?: string;
  };
  readonly commands?: {
    readonly enabled: true;
    readonly shellExecutable?: string;
    readonly resolveEnvironment?: () =>
      | NodeJS.ProcessEnv
      | Promise<NodeJS.ProcessEnv>;
    readonly hasSessionGrant?: (
      proposal: WorkspaceCommandApprovalDisplay,
      request: { readonly sessionId: string; readonly turnId: string },
    ) => boolean;
  };
  readonly languageIntelligence?: {
    readonly enabled: true;
  };
  readonly background?: {
    readonly enabled: true;
    readonly maxActiveChildren?: number;
    readonly onApprovalAvailable?: (request: {
      readonly parentSessionId: string;
      readonly childSessionId: string;
    }) => void;
  };
  readonly sessionInteractions?: CreateWorkspaceSessionInteractionToolsOptions;
  readonly sharedMcp?: Omit<CreateWorkspaceSharedMcpToolsOptions, "secret"> & {
    readonly hasSessionGrant?: (
      proposal: WorkspaceSharedMcpToolApproval,
      request: { readonly sessionId: string; readonly turnId: string },
    ) => boolean | Promise<boolean>;
  };
  readonly mcp?: Omit<
    CreateWorkspaceMcpToolsOptions,
    "operationDigestSecret" | "projectRoot"
  > & {
    readonly authorizeToolCall?: (
      proposal: WorkspaceMcpToolApprovalDisplay,
      request: { readonly sessionId: string; readonly turnId: string },
    ) => boolean | Promise<boolean>;
  };
}

export interface WorkspaceHostSession {
  readonly sessionId: string;
  readonly updatedAt: number;
  readonly model: AgentModelReference | undefined;
  readonly reasoningEffort: CoreReasoningEffort | undefined;
  readonly state: string;
}

export interface WorkspaceHost {
  readonly project: WorkspaceProjectIdentity;
  readonly principal: AgentPrincipal;
  readonly engine: AgentEngine;
  languageStatus(): ReturnType<ManagedTypeScriptService["status"]>;
  listCommands(
    identity?: Omit<WorkspaceCommandIdentity, "ownerId">,
  ): readonly WorkspaceCommandRecord[];
  observeCommand(
    commandId: string,
    identity?: Omit<WorkspaceCommandIdentity, "ownerId">,
    options?: { readonly offset?: number; readonly limitBytes?: number },
  ): WorkspaceCommandObservation;
  stopCommand(
    commandId: string,
    identity?: Omit<WorkspaceCommandIdentity, "ownerId">,
  ): Promise<WorkspaceCommandRecord>;
  listCommandRules(): readonly WorkspaceCommandRule[];
  addCommandRule(rule: WorkspaceCommandRule): Promise<void>;
  acknowledgeBackgroundCommand(commandId: string): void;
  readMcpConfiguration(): Promise<WorkspaceMcpConfiguration | undefined>;
  isBackgroundSession(sessionId: string): boolean;
  listBackgroundAgents(
    parentSessionId: string,
  ): ReturnType<WorkspaceBackgroundSupervisor["list"]>;
  listBackgroundApprovals(
    parentSessionId: string,
  ): ReturnType<WorkspaceBackgroundSupervisor["listPendingApprovals"]>;
  requestBackgroundApproval(
    request: Parameters<
      WorkspaceBackgroundSupervisor["requestForegroundApproval"]
    >[0],
  ): ReturnType<WorkspaceBackgroundSupervisor["requestForegroundApproval"]>;
  respondToBackgroundApproval(
    request: Parameters<WorkspaceBackgroundSupervisor["respondToApproval"]>[0],
  ): ReturnType<WorkspaceBackgroundSupervisor["respondToApproval"]>;
  steerBackgroundAgent(
    request: Parameters<WorkspaceBackgroundSupervisor["steer"]>[0],
  ): ReturnType<WorkspaceBackgroundSupervisor["steer"]>;
  stopBackgroundAgent(
    request: Parameters<WorkspaceBackgroundSupervisor["stop"]>[0],
  ): ReturnType<WorkspaceBackgroundSupervisor["stop"]>;
  close(): Promise<void>;
  createSession(options?: {
    readonly sessionId?: string;
    readonly model?: AgentModelReference;
    readonly reasoningEffort?: CoreReasoningEffort;
  }): Promise<{ readonly sessionId: string }>;
  listSessions(): Promise<readonly WorkspaceHostSession[]>;
  readSession(
    sessionId: string,
  ): ReturnType<AgentEngine["sessions"]["hydrate"]>;
  setSessionModel(sessionId: string, model: AgentModelReference): Promise<void>;
  setSessionReasoningEffort(
    sessionId: string,
    reasoningEffort: CoreReasoningEffort,
  ): Promise<void>;
  listModels(): ReturnType<AgentEngine["models"]["listCatalog"]>;
  readSessionInteractions(sessionId: string): {
    readonly todos: readonly import("@agentlink/protocol/chat-transcript").TodoItem[];
  };
  deleteSession(sessionId: string): Promise<void>;
  recoverInterrupted(sessionId: string): Promise<void>;
  revalidatePendingInteraction(
    sessionId: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; reason: string }>;
  resumeInteraction(
    sessionId: string,
    decision: "allow" | "deny",
    options?: {
      readonly signal?: AbortSignal;
      readonly onEvent?: (event: AgentTurnEvent) => void;
    },
  ): Promise<AgentTurnResult>;
  runTurn(
    sessionId: string,
    text: string,
    options?: {
      readonly attachments?: readonly AgentTurnAttachment[];
      readonly signal?: AbortSignal;
      readonly onEvent?: (event: AgentTurnEvent) => void;
    },
  ): Promise<AgentTurnResult>;
  cancel(sessionId: string, reason?: string): Promise<void>;
}

export async function createWorkspaceHost(
  options: CreateWorkspaceHostOptions,
): Promise<WorkspaceHost> {
  const project = await resolveWorkspaceProject(options.projectRoot);
  const principal: AgentPrincipal = {
    tenantId: "local",
    subjectId: project.id,
  };
  const projectDataRoot = path.join(options.dataRoot, "projects", project.id);
  const backgroundStateDirectory = path.join(projectDataRoot, "background");
  const durableBackgroundSessionIds = await readWorkspaceBackgroundSessionIds(
    backgroundStateDirectory,
  );
  const commandOwnerId = `workspace:${project.id}`;
  const persistence = createFileNodeHostPersistence({
    state: { directory: path.join(projectDataRoot, "sessions") },
  });
  if (options.background && !options.files) {
    throw new Error("Background writers require file tools");
  }
  const approvalSecret =
    options.files ||
    options.commands ||
    options.mcp ||
    options.sharedMcp ||
    options.background
      ? await readOrCreateApprovalKey(projectDataRoot)
      : undefined;
  const runtime = createWorkspaceModelRuntime({
    ownerId: options.ownerId,
    providers: options.providers,
    limits: options.requestLimits,
  });
  const mutations = new WorkspaceMutationCoordinator();
  let backgroundSupervisor: WorkspaceBackgroundSupervisor | undefined;
  const supervisor = options.commands
    ? await WorkspaceCommandSupervisor.create({
        stateDirectory: path.join(projectDataRoot, "commands"),
        ownerId: commandOwnerId,
      })
    : undefined;
  const commandTools =
    options.commands && supervisor
      ? await createWorkspaceCommandTools({
          projectRoot: project.root,
          ownerId: commandOwnerId,
          supervisor,
          mutations,
          stateDirectory: path.join(projectDataRoot, "commands"),
          shellExecutable: options.commands.shellExecutable,
          environmentDigestSecret: approvalSecret!,
          resolveEnvironment: options.commands.resolveEnvironment,
          hasSessionGrant: options.commands.hasSessionGrant,
          requiresApproval: (_proposal, request) =>
            backgroundSupervisor?.getRecordForSession(request.sessionId) !==
            undefined,
          resolveBackgroundOwnerSessionId: (request) =>
            backgroundSupervisor?.getRecordForSession(request.sessionId)
              ?.parentSessionId,
        })
      : undefined;
  const artifactTools = options.artifacts
    ? createWorkspaceArtifactTools({ roots: options.artifacts.roots })
    : undefined;
  let engine!: AgentEngine;
  backgroundSupervisor = options.background
    ? await WorkspaceBackgroundSupervisor.create({
        stateDirectory: backgroundStateDirectory,
        projectRoot: project.root,
        projectId: project.id,
        maxActiveChildren: options.background.maxActiveChildren,
        onApprovalAvailable: options.background.onApprovalAvailable,
        createChildSession: async (request) => {
          const parent = await engine.sessions.read({
            principal,
            sessionId: request.parentSessionId,
          });
          if (!parent.ok)
            throw new Error("background_parent_session_not_found");
          const model = request.model ?? parent.record.selectedModel;
          const reasoningEffort =
            request.reasoningEffort ?? parent.record.reasoningEffort;
          const created = await engine.sessions.create({
            principal,
            model,
            reasoningEffort,
          });
          return {
            sessionId: created.record.sessionId,
            model,
            reasoningEffort,
          };
        },
        validateScopes: async (request) => {
          const parentScopes = options.files?.resolveScopes
            ? await options.files.resolveScopes({
                principal,
                sessionId: request.parentSessionId,
                turnId: request.parentTurnId,
              })
            : [
                {
                  path: ".",
                  kind: "directory" as const,
                  access: "read_write" as const,
                },
              ];
          return await workspaceFileScopesContain(
            project.root,
            parentScopes,
            request.scopes,
          );
        },
        runTurn: async (sessionId, text, runOptions) => {
          const stream = engine.sessions.runTurn(
            {
              principal,
              sessionId,
              input: { text, attachments: undefined },
              model: undefined,
            },
            { signal: runOptions.signal },
          );
          return await collectTurn(stream, runOptions.onEvent);
        },
        resumeInteraction: async (sessionId, decision, runOptions) =>
          await resumeWorkspaceInteraction(
            engine,
            principal,
            sessionId,
            decision,
            revalidatePendingInteractionInternal,
            runOptions,
          ),
        cancelSession: async (sessionId, reason) => {
          await engine.sessions.cancel({ principal, sessionId, reason });
        },
      })
    : undefined;
  const backgroundTools = backgroundSupervisor
    ? createWorkspaceBackgroundTools({
        supervisor: backgroundSupervisor,
        isForegroundSession: (sessionId) =>
          backgroundSupervisor.getRecordForSession(sessionId) === undefined,
      })
    : undefined;
  const sharedMcpOptions = options.sharedMcp;
  const sharedMcpTools = sharedMcpOptions
    ? createWorkspaceSharedMcpTools({
        ...sharedMcpOptions,
        secret: approvalSecret!,
        authorizeAdmission: (proposal, request) =>
          mutations.outsideExclusive(() =>
            sharedMcpOptions.authorizeAdmission(proposal, request),
          ),
        authorizeLaunch: (proposal, request) =>
          mutations.outsideExclusive(() =>
            sharedMcpOptions.authorizeLaunch(proposal, request),
          ),
        authorizeNetwork: (proposal, request) =>
          mutations.outsideExclusive(() =>
            sharedMcpOptions.authorizeNetwork(proposal, request),
          ),
      })
    : undefined;
  const mcpTools = options.mcp
    ? createWorkspaceMcpTools({
        ...options.mcp,
        projectRoot: project.root,
        operationDigestSecret: approvalSecret!,
        authorizeLaunch: options.mcp.authorizeLaunch
          ? (request) =>
              mutations.outsideExclusive(() =>
                Promise.resolve(options.mcp!.authorizeLaunch!(request)),
              )
          : undefined,
        authorizeNetwork: options.mcp.authorizeNetwork
          ? (request) =>
              mutations.outsideExclusive(() =>
                Promise.resolve(options.mcp!.authorizeNetwork!(request)),
              )
          : undefined,
        authorizeOAuthNetwork: options.mcp.authorizeOAuthNetwork
          ? (request) =>
              mutations.outsideExclusive(() =>
                Promise.resolve(options.mcp!.authorizeOAuthNetwork!(request)),
              )
          : undefined,
      })
    : undefined;
  const resolveHostFileScopes: ResolveWorkspaceFileScopes = async (request) => {
    const child = backgroundSupervisor?.getRecordForSession(request.sessionId);
    if (child) {
      const childScopes = child.scopes.map((scope) => ({
        path: scope.path,
        kind: scope.kind,
        access: scope.access,
      }));
      const parentScopes = options.files?.resolveScopes
        ? await options.files.resolveScopes({
            principal,
            sessionId: child.parentSessionId,
            turnId: child.parentTurnId,
          })
        : [
            {
              path: ".",
              kind: "directory" as const,
              access: "read_write" as const,
            },
          ];
      return (await workspaceFileScopesContain(
        project.root,
        parentScopes,
        childScopes,
      ))
        ? childScopes
        : [];
    }
    return options.files?.resolveScopes
      ? await options.files.resolveScopes(request)
      : [{ path: ".", kind: "directory", access: "read_write" }];
  };
  const languageService = options.languageIntelligence
    ? new ManagedTypeScriptService({
        projectRoot: project.root,
        dataRoot: options.dataRoot,
      })
    : undefined;
  const canReadLanguagePath = async (
    request: Parameters<ResolveWorkspaceFileScopes>[0],
    relativePath: string,
  ): Promise<boolean> => {
    const scopes = await resolveHostFileScopes(request);
    return await workspaceFileScopesContain(project.root, scopes, [
      { path: relativePath, kind: "file", access: "read" },
    ]);
  };
  const languageTools = languageService
    ? createManagedTypeScriptTools({
        projectRoot: project.root,
        service: languageService,
        canReadPath: canReadLanguagePath,
      })
    : undefined;
  const fileTools = options.files
    ? createWorkspaceFileTools({
        projectRoot: project.root,
        approvalPolicy: options.files.approvalPolicy,
        resolveScopes: resolveHostFileScopes,
        ripgrepExecutable: options.files.ripgrepExecutable,
        enrichContext: languageService
          ? async (request, relativePath, signal) => {
              const filePath = path.join(project.root, relativePath);
              const canReadResultPath = (resultPath: string) =>
                canReadLanguagePath(request, resultPath);
              const [diagnostics, symbols] = await Promise.all([
                languageService
                  .diagnostics(filePath, signal)
                  .then((result) =>
                    sanitizeManagedTypeScriptResult(
                      result,
                      project.root,
                      canReadResultPath,
                    ),
                  ),
                languageService
                  .symbols(filePath, signal)
                  .then((result) =>
                    sanitizeManagedTypeScriptResult(
                      result,
                      project.root,
                      canReadResultPath,
                    ),
                  ),
              ]);
              return { diagnostics, symbols };
            }
          : () => ({
              diagnostics: {
                state: "unavailable",
                reason:
                  "TypeScript intelligence is not enabled for this project",
                retryable: false,
              },
              symbols: {
                state: "unavailable",
                reason:
                  "TypeScript intelligence is not enabled for this project",
                retryable: false,
              },
            }),
        onFileCommitted: languageService
          ? async (_request, relativePath) => {
              await languageService
                .synchronizeFile(path.join(project.root, relativePath))
                .catch(() => undefined);
            }
          : undefined,
        canWritePath: async (request, relativePath) => {
          if (
            !(
              backgroundSupervisor?.assertWriteAllowed(
                request.sessionId,
                relativePath,
              ) ?? true
            )
          ) {
            return false;
          }
          const child = backgroundSupervisor?.getRecordForSession(
            request.sessionId,
          );
          if (!child) return true;
          const parentScopes = options.files?.resolveScopes
            ? await options.files.resolveScopes({
                principal,
                sessionId: child.parentSessionId,
                turnId: child.parentTurnId,
              })
            : [
                {
                  path: ".",
                  kind: "directory" as const,
                  access: "read_write" as const,
                },
              ];
          return await workspaceFileScopesContain(project.root, parentScopes, [
            { path: relativePath, kind: "file", access: "read_write" },
          ]);
        },
        mutations,
      })
    : undefined;
  const sessionInteractionTools = options.sessionInteractions
    ? createWorkspaceSessionInteractionTools(options.sessionInteractions)
    : undefined;
  const interactionTokens =
    options.files || options.commands || options.mcp || options.sharedMcp
      ? createTurnInteractionTokenService({
          secret: approvalSecret!,
        })
      : undefined;
  engine = createNodeHostAgent({
    ownerId: options.ownerId,
    models: runtime,
    persistence,
    defaultModel: options.defaultModel,
    defaultReasoningEffort: options.defaultReasoningEffort,
    maxOutputTokens: 4_096,
    ...(fileTools ||
    commandTools ||
    artifactTools ||
    mcpTools ||
    sharedMcpTools ||
    backgroundTools ||
    languageTools ||
    sessionInteractionTools
      ? {
          tools: {
            resolveTools: async (request) => {
              const shared = await sharedMcpTools?.resolveTools(request);
              try {
                const tools = [
                  ...(fileTools ? await fileTools.resolveTools(request) : []),
                  ...(commandTools
                    ? await commandTools.resolveTools(request)
                    : []),
                  ...(artifactTools
                    ? await artifactTools.resolveTools(request)
                    : []),
                  ...(mcpTools
                    ? (await mcpTools.resolveTools(request)).map((tool) =>
                        serializeMcpToolExecution(tool, mutations),
                      )
                    : []),
                  ...(backgroundTools
                    ? await backgroundTools.resolveTools(request)
                    : []),
                  ...(languageTools
                    ? await languageTools.resolveTools(request)
                    : []),
                  ...(sessionInteractionTools
                    ? await sessionInteractionTools.resolveTools(request)
                    : []),
                ];
                return shared
                  ? {
                      tools: [
                        ...tools,
                        ...shared.tools.map((tool) =>
                          serializeMcpToolExecution(tool, mutations),
                        ),
                      ],
                      dispose: shared.dispose,
                    }
                  : tools;
              } catch (error) {
                await shared?.dispose();
                throw error;
              }
            },
          },
        }
      : {}),
    ...(interactionTokens
      ? {
          interactions: {
            interactions: persistence.interactions,
            interactionTokens,
            authorizeToolCall: async (request) => {
              if (request.toolName === "execute_command") {
                return commandTools
                  ? await commandTools.authorizeToolCall(request)
                  : { decision: "deny" as const, reason: "Commands disabled" };
              }
              if (sharedMcpTools) {
                const proposal = await sharedMcpTools.toolApproval(
                  request.toolName,
                  request.input,
                );
                if (proposal) {
                  const policy = await sharedMcpTools.toolPolicy(proposal);
                  if (policy === "deny") {
                    return {
                      decision: "deny" as const,
                      reason: "MCP tool policy or configuration changed",
                    };
                  }
                  if (policy === "allow") {
                    return { decision: "allow" as const };
                  }
                  const child = backgroundSupervisor?.getRecordForSession(
                    request.sessionId,
                  );
                  if (
                    !child &&
                    (await options.sharedMcp?.hasSessionGrant?.(
                      proposal,
                      request,
                    ))
                  ) {
                    return { decision: "allow" as const };
                  }
                  return {
                    decision: "require_user" as const,
                    summary: `Call MCP tool ${proposal.serverId}/${proposal.serverToolName}`,
                    displayContent: proposal,
                  };
                }
              }
              if (mcpTools) {
                const proposal = createWorkspaceMcpToolApproval(
                  request.toolName,
                  request.input,
                  await mcpTools.snapshot(),
                  approvalSecret!,
                );
                if (proposal) {
                  const child = backgroundSupervisor?.getRecordForSession(
                    request.sessionId,
                  );
                  if (
                    !child &&
                    (await options.mcp?.authorizeToolCall?.(proposal, request))
                  ) {
                    return { decision: "allow" as const };
                  }
                  return {
                    decision: "require_user" as const,
                    summary: `Call MCP tool ${proposal.serverId}/${proposal.serverToolName}`,
                    displayContent: proposal,
                  };
                }
              }
              return fileTools
                ? await fileTools.authorizeToolCall(request)
                : { decision: "deny" as const, reason: "File tools disabled" };
            },
          },
        }
      : {}),
    instructions: async (request) => {
      const resolvedArtifacts = artifactTools
        ? await artifactTools.resolveInstructions(request)
        : undefined;
      const artifactInstructions =
        typeof resolvedArtifacts === "string"
          ? resolvedArtifacts
          : resolvedArtifacts?.instructions;
      return [
        "You are AgentLink's standalone local coding assistant.",
        `The canonical project root is ${project.root}.`,
        options.files
          ? "Use only the project-relative file tools that are actually exposed. Read before editing, preserve the SHA-256 baseline, and expect every ungranted write to pause for human review."
          : "File tools are not enabled.",
        options.commands
          ? "Commands are unsandboxed, non-PTY, close stdin, and have no persistent shell state. Use background mode only for a long-lived development process that may run concurrently with file edits."
          : "Command tools are not enabled.",
        options.artifacts
          ? "Host-approved instructions and rules are active. Use list_artifacts and load_artifact for exact advertised skills or prompt commands."
          : "Instruction and skill artifacts are not enabled.",
        options.mcp || options.sharedMcp
          ? "MCP servers are unsandboxed external capabilities. Discovery requires foreground launch or destination trust, and MCP tool calls follow host authorization and configured policy."
          : "MCP tools are not enabled.",
        options.languageIntelligence
          ? "Optional TypeScript/JavaScript diagnostics, symbols, definition, references, and hover are available through an explicitly installed unsandboxed language server. Treat unavailable, warming, stale, and failed states as incomplete analysis, never as zero findings."
          : "Managed TypeScript/JavaScript intelligence is not enabled.",
        options.background
          ? backgroundSupervisor?.getRecordForSession(request.session.sessionId)
            ? "You are a one-level background child. Work only within your assigned file scopes. You cannot delegate. Commands, MCP calls, and writes may pause for foreground human approval."
            : "You may delegate up to two one-level background writers with explicit disjoint write paths, then observe, steer, wait for, or stop them."
          : "Background writers are not enabled.",
        artifactInstructions,
        options.instructions,
      ]
        .filter(Boolean)
        .join("\n\n");
    },
  });

  const isBackgroundSession = (sessionId: string): boolean =>
    durableBackgroundSessionIds.has(sessionId) ||
    backgroundSupervisor?.getRecordForSession(sessionId) !== undefined;
  const assertForegroundSession = (sessionId: string): void => {
    if (isBackgroundSession(sessionId)) {
      throw new Error("background_child_requires_supervisor_control");
    }
  };

  const revalidatePendingInteractionInternal = async (
    sessionId: string,
  ): Promise<
    { readonly ok: true } | { readonly ok: false; reason: string }
  > => {
    if (!fileTools && !commandTools && !mcpTools && !sharedMcpTools) {
      return { ok: false, reason: "Approval tools are not enabled" };
    }
    const pending = await engine.sessions.inspect({ principal, sessionId });
    if (
      !pending.pendingInteraction ||
      pending.summary.runState.phase !== "suspended"
    ) {
      return {
        ok: false,
        reason: `Session ${sessionId} has no pending interaction`,
      };
    }
    const stored = await persistence.interactions.readInteraction({
      principal,
      sessionId,
      interactionId: pending.pendingInteraction.request.interactionId,
    });
    if (!stored.ok) {
      return {
        ok: false,
        reason: "Pending interaction is no longer available",
      };
    }
    const call = stored.record.continuation.pendingToolCalls[0];
    if (!call) {
      return {
        ok: false,
        reason: "Pending interaction has no prepared operation",
      };
    }
    const validationRequest = {
      principal,
      sessionId,
      turnId: stored.record.turnId,
      toolName: call.name,
      input: call.input,
      displayContent: stored.record.request.displayContent,
    };
    if (isWorkspaceSharedMcpToolApproval(validationRequest.displayContent)) {
      return sharedMcpTools &&
        sameWorkspaceSharedMcpToolApproval(
          validationRequest.displayContent,
          await sharedMcpTools.toolApproval(call.name, call.input),
        )
        ? { ok: true }
        : {
            ok: false,
            reason: "Shared MCP tool proposal no longer matches config",
          };
    }
    if (isWorkspaceMcpToolApprovalDisplay(validationRequest.displayContent)) {
      if (!mcpTools) return { ok: false, reason: "MCP is not enabled" };
      return validateWorkspaceMcpToolApproval(
        validationRequest.displayContent,
        validationRequest.toolName,
        validationRequest.input,
        await mcpTools.snapshot(),
        approvalSecret!,
      )
        ? { ok: true }
        : { ok: false, reason: "MCP tool proposal no longer matches config" };
    }
    if (isWorkspaceCommandApprovalDisplay(validationRequest.displayContent)) {
      return commandTools
        ? await commandTools.validatePendingLaunch(validationRequest)
        : { ok: false, reason: "Commands are not enabled" };
    }
    return fileTools
      ? await fileTools.validatePendingWrite(validationRequest)
      : { ok: false, reason: "File tools are not enabled" };
  };
  const revalidatePendingInteraction = async (
    sessionId: string,
  ): Promise<
    { readonly ok: true } | { readonly ok: false; reason: string }
  > => {
    assertForegroundSession(sessionId);
    return await revalidatePendingInteractionInternal(sessionId);
  };

  return {
    project,
    principal,
    engine,
    async languageStatus() {
      if (!languageService) {
        return {
          state: "unavailable",
          reason: "Managed TypeScript/JavaScript intelligence is not enabled",
          restarts: 0,
          logs: [],
          installation: await getManagedTypeScriptStatus(options.dataRoot),
        };
      }
      return await languageService.status();
    },
    listCommands(identity = {}) {
      return supervisor?.list({ ownerId: commandOwnerId, ...identity }) ?? [];
    },
    observeCommand(commandId, identity = {}, observeOptions = {}) {
      if (!supervisor) throw new Error("Commands are not enabled");
      return supervisor.observe(
        commandId,
        { ownerId: commandOwnerId, ...identity },
        observeOptions,
      );
    },
    async stopCommand(commandId, identity = {}) {
      if (!supervisor) throw new Error("Commands are not enabled");
      return await supervisor.stop(commandId, {
        ownerId: commandOwnerId,
        ...identity,
      });
    },
    listCommandRules() {
      return commandTools?.listRules() ?? [];
    },
    async addCommandRule(rule) {
      if (!commandTools) throw new Error("Commands are not enabled");
      await commandTools.addRule(rule);
    },
    acknowledgeBackgroundCommand(commandId) {
      if (!commandTools) throw new Error("Commands are not enabled");
      commandTools.acknowledgeBackgroundLaunch(commandId);
    },
    async readMcpConfiguration() {
      return await mcpTools?.snapshot();
    },
    isBackgroundSession,
    listBackgroundAgents(parentSessionId) {
      return backgroundSupervisor?.list(parentSessionId) ?? [];
    },
    listBackgroundApprovals(parentSessionId) {
      return backgroundSupervisor?.listPendingApprovals(parentSessionId) ?? [];
    },
    async requestBackgroundApproval(request) {
      if (!backgroundSupervisor)
        throw new Error("Background writers are not enabled");
      return await mutations.outsideExclusive(() =>
        backgroundSupervisor!.requestForegroundApproval(request),
      );
    },
    async respondToBackgroundApproval(request) {
      if (!backgroundSupervisor)
        throw new Error("Background writers are not enabled");
      return await backgroundSupervisor.respondToApproval(request);
    },
    async steerBackgroundAgent(request) {
      if (!backgroundSupervisor)
        throw new Error("Background writers are not enabled");
      return await backgroundSupervisor.steer(request);
    },
    async stopBackgroundAgent(request) {
      if (!backgroundSupervisor)
        throw new Error("Background writers are not enabled");
      return await backgroundSupervisor.stop(request);
    },
    async close() {
      await backgroundSupervisor?.close();
      await sharedMcpTools?.close();
      await languageService?.close();
      await supervisor?.close();
    },
    async createSession(sessionOptions = {}) {
      const created = await engine.sessions.create({
        principal,
        sessionId: sessionOptions.sessionId,
        model: sessionOptions.model,
        reasoningEffort: sessionOptions.reasoningEffort,
      });
      return { sessionId: created.record.sessionId };
    },
    async listSessions() {
      return (await engine.sessions.list({ principal }))
        .filter(
          (session) =>
            !durableBackgroundSessionIds.has(session.sessionId) &&
            backgroundSupervisor?.getRecordForSession(session.sessionId) ===
              undefined,
        )
        .map((session) => ({
          sessionId: session.sessionId,
          updatedAt: session.updatedAt,
          model: session.selectedModel,
          reasoningEffort: session.reasoningEffort,
          state: session.runState.phase,
        }))
        .sort(
          (left, right) =>
            right.updatedAt - left.updatedAt ||
            left.sessionId.localeCompare(right.sessionId),
        );
    },
    readSession(sessionId) {
      assertForegroundSession(sessionId);
      return engine.sessions.hydrate({ principal, sessionId });
    },
    async setSessionModel(sessionId, model) {
      assertForegroundSession(sessionId);
      const current = await engine.sessions.hydrate({ principal, sessionId });
      await engine.sessions.setModel({
        principal,
        sessionId,
        model,
        expectedRevision: current.summary.revision,
      });
    },
    async setSessionReasoningEffort(sessionId, reasoningEffort) {
      assertForegroundSession(sessionId);
      const current = await engine.sessions.hydrate({ principal, sessionId });
      await engine.sessions.setReasoningEffort({
        principal,
        sessionId,
        reasoningEffort,
        expectedRevision: current.summary.revision,
      });
    },
    listModels() {
      return engine.models.listCatalog({ principal, authContext: undefined });
    },
    readSessionInteractions(sessionId) {
      assertForegroundSession(sessionId);
      return sessionInteractionTools?.snapshot(sessionId) ?? { todos: [] };
    },
    async deleteSession(sessionId) {
      assertForegroundSession(sessionId);
      await engine.sessions.delete({ principal, sessionId });
      await sharedMcpTools?.closeSession(sessionId);
    },
    async recoverInterrupted(sessionId) {
      assertForegroundSession(sessionId);
      await engine.sessions.recoverInterrupted({
        principal,
        sessionId,
        reason: "The previous standalone CLI process exited during this turn",
      });
    },
    revalidatePendingInteraction,
    async resumeInteraction(sessionId, decision, runOptions = {}) {
      assertForegroundSession(sessionId);
      return await resumeWorkspaceInteraction(
        engine,
        principal,
        sessionId,
        decision,
        revalidatePendingInteraction,
        runOptions,
      );
    },
    async runTurn(sessionId, text, runOptions = {}) {
      assertForegroundSession(sessionId);
      const stream = engine.sessions.runTurn(
        {
          principal,
          sessionId,
          input: { text, attachments: runOptions.attachments },
          model: undefined,
        },
        { signal: runOptions.signal },
      );
      return await collectTurn(stream, runOptions.onEvent);
    },
    async cancel(sessionId, reason) {
      assertForegroundSession(sessionId);
      await engine.sessions.cancel({ principal, sessionId, reason });
    },
  };
}

function serializeMcpToolExecution(
  tool: HostTool,
  mutations: WorkspaceMutationCoordinator,
): HostTool {
  return {
    ...tool,
    execute: (input, context) =>
      mutations.withExclusive(
        () => tool.execute(input, context),
        context.signal,
      ),
    executeValidated: (input, context) =>
      mutations.withExclusive(
        () => tool.executeValidated(input, context),
        context.signal,
      ),
  };
}

async function resumeWorkspaceInteraction(
  engine: AgentEngine,
  principal: AgentPrincipal,
  sessionId: string,
  decision: "allow" | "deny",
  revalidatePendingInteraction: (
    sessionId: string,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; reason: string }>,
  runOptions: {
    readonly signal?: AbortSignal;
    readonly onEvent?: (event: AgentTurnEvent) => void;
  },
): Promise<AgentTurnResult> {
  const pending = await engine.sessions.inspect({ principal, sessionId });
  if (!pending.pendingInteraction) {
    throw new Error(`Session ${sessionId} has no pending interaction`);
  }
  if (pending.summary.runState.phase !== "suspended") {
    throw new Error(`Session ${sessionId} is not suspended`);
  }
  if (decision === "allow") {
    const current = await revalidatePendingInteraction(sessionId);
    if (!current.ok) {
      await engine.sessions.cancel({
        principal,
        sessionId,
        reason: `Stale proposal rejected: ${current.reason}`,
      });
      throw new Error(`Stale proposal rejected: ${current.reason}`);
    }
  }
  const interaction = pending.pendingInteraction;
  const stream = engine.sessions.resumeInteraction(
    {
      principal,
      sessionId,
      turnId: pending.summary.runState.turnId,
      interactionId: interaction.request.interactionId,
      interactionRevision: interaction.interactionRevision,
      expectedSessionRevision: interaction.sessionRevision,
      decision,
    },
    { signal: runOptions.signal },
  );
  return await collectTurn(stream, runOptions.onEvent);
}

async function collectTurn(
  stream: AsyncGenerator<AgentTurnEvent, AgentTurnResult>,
  onEvent?: (event: AgentTurnEvent) => void,
): Promise<AgentTurnResult> {
  for (;;) {
    const next = await stream.next();
    if (next.done) return next.value;
    onEvent?.(next.value);
  }
}

async function readOrCreateApprovalKey(
  projectDataRoot: string,
): Promise<string> {
  const keyPath = path.join(projectDataRoot, "approval-signing-key");
  await fs.mkdir(projectDataRoot, { recursive: true, mode: 0o700 });
  try {
    const key = (await fs.readFile(keyPath, "utf8")).trim();
    if (Buffer.byteLength(key, "utf8") < 32) {
      throw new Error("Stored approval signing key is invalid");
    }
    return key;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const key = randomBytes(32).toString("base64url");
  try {
    const handle = await fs.open(
      keyPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${key}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return key;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const existing = (await fs.readFile(keyPath, "utf8")).trim();
    if (Buffer.byteLength(existing, "utf8") < 32) {
      throw new Error("Stored approval signing key is invalid");
    }
    return existing;
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
