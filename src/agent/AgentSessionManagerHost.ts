import * as vscode from "vscode";

import { ActivityTraceRecorder } from "./ActivityTraceRecorder.js";
import type {
  ActivityTraceRecorderOptions,
  BackgroundSummaryTraceEvent,
} from "./ActivityTraceRecorder.js";
import { AgentEngine } from "./AgentEngine.js";
import { AgentSession } from "./AgentSession.js";
import {
  CheckpointManager,
  type Checkpoint,
  type RevertPreview,
} from "./CheckpointManager.js";
import {
  getConfiguredBaseThresholdForModel,
  getEffectiveAutoCondenseThreshold,
} from "./modelCondenseThresholds.js";
import { resolveModelForMode } from "./modeModelPreferences.js";
import { resolveReasoningEffortForMode } from "./modeReasoningEffortPreferences.js";
import { providerRegistry, type ProviderRegistry } from "./providers/index.js";
import {
  StdioAcpBackgroundRunner,
  type AcpBackgroundRunner,
} from "./background/acpBackgroundRunner.js";
import type { RawBackgroundAgentSettings } from "./background/acpAgentConfig.js";
import type { WorkspaceFolderInfo } from "./systemPrompt.js";
import {
  createAgentToolRuntime,
  type ToolDispatchContext,
} from "./toolAdapter.js";
import type { SessionStore } from "./SessionStore.js";
import type { AgentToolRuntime } from "../core/tools/types.js";
import type { CoreWebAccessSettings } from "../core/webAccess.js";
import {
  createVscodeEditorRevealProvider,
  createVscodeEditReviewProvider,
  createVscodeMultiFileEditReviewProvider,
  createVscodeRenameSymbolProvider,
  createVscodeWriteApprovalPolicyProvider,
} from "../adapters/vscode/editReviewCapabilities.js";
import { createVscodeSemanticSearchProvider } from "../adapters/vscode/readSearchCapabilities.js";
import { createProjectSettingsAccessor } from "../adapters/vscode/projectSettingsAccessor.js";
import type { AgentEvent } from "./types.js";
import type { ProjectCustomizationRegistry } from "./ProjectCustomizationRegistry.js";
import type { ProjectMcpHubRegistry } from "./ProjectMcpHubRegistry.js";
import type {
  ProjectScopeResolver,
  SessionProjectScope,
} from "../core/workspaceProjects.js";
import { WorkspaceMutationCoordinator } from "./WorkspaceMutationCoordinator.js";
import type { SkillCatalogFallbackProvider } from "./skillCatalogFallbackProvider.js";
import { normalizePromptProfileOverrides } from "../core/promptProfile.js";

export interface AgentWorkspaceHost {
  getWorkspaceFolders(): WorkspaceFolderInfo[];
}

export type BgSummaryMode = "agent" | "openai" | "heuristic";

export interface AgentSessionConfigHost {
  resolveAgentConfig?(
    base: import("./types.js").AgentConfig,
    scope: Readonly<SessionProjectScope>,
  ): import("./types.js").AgentConfig;
  getCondenseThresholdForModel(
    model: string,
    scope?: Readonly<SessionProjectScope>,
  ): number;
  resolveModelForMode(
    mode: string,
    fallbackModel: string,
    scope?: Readonly<SessionProjectScope>,
  ): string;
  resolveReasoningEffortForMode?(
    mode: string,
    scope?: Readonly<SessionProjectScope>,
  ): import("./providers/types.js").ReasoningEffort;
  getBgSummaryMode(scope?: Readonly<SessionProjectScope>): BgSummaryMode;
  getBackgroundAgentSettings(
    scope?: Readonly<SessionProjectScope>,
  ): RawBackgroundAgentSettings;
  /** Window-scoped configure-once web policy; intentionally not resource-scoped. */
  getWebAccessSettings?(): Partial<CoreWebAccessSettings>;
}

export interface CheckpointManagerLike {
  readonly baseCommit: string | null;
  initialize?(): Promise<unknown>;
  createCheckpoint(turnIndex: number): Promise<Checkpoint | null>;
  previewRevert(checkpoint: Checkpoint): Promise<RevertPreview | null>;
  getWorkspaceRevision?(checkpoint: Checkpoint): Promise<string | null>;
  revertToCheckpoint(checkpoint: Checkpoint): Promise<boolean>;
  getDiffBetween(fromHash: string, toHash: string): Promise<string>;
}

export interface ActivityTraceRecorderLike {
  appendAgentEvent(
    sessionId: string,
    projectId: string,
    event: AgentEvent,
    source: "foreground_agent" | "background_agent",
  ): void;
  appendBackgroundSummaryEvent?(
    sessionId: string,
    projectId: string,
    event: BackgroundSummaryTraceEvent,
  ): void;
  diagnoseSessionActivity?(
    sessionId: string,
    query: import("../core/sessionActivityDiagnostics.js").SessionActivityQuery,
  ): import("../core/sessionActivityDiagnostics.js").SessionActivityDiagnosis;
}

export interface TimerHost {
  setInterval(
    handler: () => void,
    timeoutMs: number,
  ): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
  setTimeout(
    handler: () => void,
    timeoutMs: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface CheckpointManagerOptions {
  workspaceDir: string;
  taskId: string;
  log?: (msg: string) => void;
}

export interface AgentSessionManagerHost {
  workspace: AgentWorkspaceHost;
  config: AgentSessionConfigHost;
  providers: ProviderRegistry;
  createEngine: (
    registry: ProviderRegistry,
    log?: (msg: string) => void,
  ) => AgentEngine;
  createSession: typeof AgentSession.create;
  createCheckpointManager: (
    opts: CheckpointManagerOptions,
  ) => CheckpointManagerLike;
  createActivityTraceRecorder: (
    opts: ActivityTraceRecorderOptions,
  ) => ActivityTraceRecorderLike;
  /** Captures one immutable project-sensitive capability generation for a request. */
  captureProjectToolContext: (
    ctx: ToolDispatchContext,
    scope: Readonly<SessionProjectScope>,
  ) => ToolDispatchContext;
  createToolRuntime: (ctx: ToolDispatchContext) => AgentToolRuntime;
  acpBackgroundRunner: AcpBackgroundRunner;
  workspaceMutationCoordinator: WorkspaceMutationCoordinator;
  persistence?: SessionStore;
  timers: TimerHost;
}

export interface AgentSessionManagerOptions {
  host?: Partial<AgentSessionManagerHost>;
  projectCatalog?: ProjectScopeResolver;
  projectCustomizationRegistry?: ProjectCustomizationRegistry;
  projectMcpHubRegistry?: ProjectMcpHubRegistry;
  skillCatalogFallbackProvider?: SkillCatalogFallbackProvider;
  browserPreferredProjectId?: string;
  onBrowserPreferredProjectChanged?: (
    projectId: string,
  ) => void | Promise<void>;
  /** Fail-closed activation gate used when workspace execution state is unresolved. */
  executionUnavailableReason?: string;
  /** Activation-time primary project used only for pre-scope session records. */
  legacyProjectScope?: import("../core/workspaceProjects.js").SessionProjectScope;
  /** Resolves the tab-owned terminal provider for a session and its attached fleet root. */
  terminalProviderForSession?: (
    sessionId: string,
    rootSessionId: string,
  ) => import("../core/capabilities/terminal.js").TerminalProvider | undefined;
}

export function createDefaultAgentSessionManagerHost(args: {
  cwd: string;
  log?: (msg: string) => void;
  store?: SessionStore;
}): AgentSessionManagerHost {
  const projectSettings = createProjectSettingsAccessor();
  const configurationFor = (scope?: Readonly<SessionProjectScope>) =>
    scope
      ? projectSettings.getConfiguration(scope)
      : vscode.workspace.getConfiguration("agentlink");
  return {
    workspace: {
      getWorkspaceFolders: () =>
        (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
          name: folder.name,
          path: folder.uri.fsPath,
        })),
    },
    config: {
      resolveAgentConfig: (base, scope) => {
        const config = configurationFor(scope);
        const configuredDisabledSkillIds =
          config.get<unknown>("skills.disabledIds");
        const disabledSkillIds =
          Array.isArray(configuredDisabledSkillIds) &&
          configuredDisabledSkillIds.every(
            (skillId): skillId is string => typeof skillId === "string",
          )
            ? configuredDisabledSkillIds
            : [];
        return {
          ...base,
          maxTokens: config.get<number>("agentMaxTokens") ?? 8192,
          thinkingBudget: config.get<number>("thinkingBudget") ?? 10000,
          autoCondense: config.get<boolean>("autoCondense") ?? true,
          codexStatefulResponses:
            config.get<boolean>("codexStatefulResponses") ?? true,
          codexStoreResponses:
            config.get<boolean>("codexStoreResponses") ?? false,
          codexProMode: config.get<boolean>("codexProMode") ?? false,
          promptProfileOverrides: normalizePromptProfileOverrides(
            config.get<unknown>("modelPromptProfiles"),
          ),
          disabledSkillIds,
        };
      },
      getCondenseThresholdForModel: (model, scope) => {
        const capabilities = providerRegistry
          .tryResolveProvider(model)
          ?.getCapabilities(model);
        return (
          getConfiguredBaseThresholdForModel(
            configurationFor(scope),
            model,
            capabilities,
          ) ?? getEffectiveAutoCondenseThreshold(model, undefined, capabilities)
        );
      },
      resolveModelForMode: (mode, fallbackModel, scope) =>
        resolveModelForMode(configurationFor(scope), mode, fallbackModel),
      resolveReasoningEffortForMode: (mode, scope) =>
        resolveReasoningEffortForMode(configurationFor(scope), mode),
      getBgSummaryMode: (scope) => {
        const value = configurationFor(scope).get<string>(
          "bgSummary.mode",
          "heuristic",
        );
        if (value === "agent" || value === "openai" || value === "heuristic") {
          return value;
        }
        return "heuristic";
      },
      getBackgroundAgentSettings: (scope) => {
        const config = configurationFor(scope);
        return {
          defaultAgent: config.get<unknown>("background.defaultAgent"),
          reviewAgent: config.get<unknown>("background.reviewAgent"),
          acpAgents: config.get<unknown>("background.acpAgents"),
        };
      },
      getWebAccessSettings: () => {
        const config = vscode.workspace.getConfiguration("agentlink");
        const stringValue = (key: string) => {
          const value = config.get<unknown>(key);
          return typeof value === "string" ? value : undefined;
        };

        const numberValue = (key: string) => {
          const value = config.get<unknown>(key);
          return typeof value === "number" ? value : undefined;
        };
        const stringArrayValue = (key: string) => {
          const value = config.get<unknown>(key);
          return Array.isArray(value) &&
            value.every((entry) => typeof entry === "string")
            ? value
            : undefined;
        };
        return {
          searchBackend: stringValue("webAccess.searchBackend"),
          fetchBackend: stringValue("webAccess.fetchBackend"),
          nativeSearchMode: stringValue("webAccess.nativeSearchMode"),
          allowedDomains: stringArrayValue("webAccess.allowedDomains"),
          blockedDomains: stringArrayValue("webAccess.blockedDomains"),
          maxSearchUsesPerTurn: numberValue("webAccess.maxSearchUsesPerTurn"),
          maxFetchUsesPerTurn: numberValue("webAccess.maxFetchUsesPerTurn"),
          maxFetchContentTokens: numberValue("webAccess.maxFetchContentTokens"),
          maxReplayBytesPerTurn: numberValue("webAccess.maxReplayBytesPerTurn"),
        } as Partial<CoreWebAccessSettings>;
      },
    },
    providers: providerRegistry,
    createEngine: (registry, log) => new AgentEngine(registry, log),
    createSession: (opts) => AgentSession.create(opts),
    createCheckpointManager: (opts) => new CheckpointManager(opts),
    createActivityTraceRecorder: (opts) =>
      new ActivityTraceRecorder({ ...opts, log: args.log }),
    captureProjectToolContext: (ctx, scope) => ({
      ...ctx,
      projectScope: scope,
      projectRoot: scope.rootPath,
    }),
    createToolRuntime: (ctx) =>
      createAgentToolRuntime({
        ...ctx,
        semanticSearchProvider:
          ctx.semanticSearchProvider ??
          createVscodeSemanticSearchProvider(
            ctx.projectRoot,
            ctx.globalStorageUri,
          ),
        editorRevealProvider:
          ctx.editorRevealProvider ?? createVscodeEditorRevealProvider(),
        editReviewProvider:
          ctx.editReviewProvider ?? createVscodeEditReviewProvider(),
        writeApprovalPolicyProvider:
          ctx.writeApprovalPolicyProvider ??
          createVscodeWriteApprovalPolicyProvider(ctx.approvalManager),
        multiFileEditReviewProvider:
          ctx.multiFileEditReviewProvider ??
          createVscodeMultiFileEditReviewProvider(
            ctx.approvalManager,
            ctx.extensionUri,
          ),
        renameSymbolProvider:
          ctx.renameSymbolProvider ??
          createVscodeRenameSymbolProvider(ctx.approvalManager),
      }),
    acpBackgroundRunner: new StdioAcpBackgroundRunner(),
    workspaceMutationCoordinator: new WorkspaceMutationCoordinator(),
    persistence: args.store,
    timers: {
      setInterval: (handler, timeoutMs) => setInterval(handler, timeoutMs),
      clearInterval: (timer) => clearInterval(timer),
      setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
      clearTimeout: (timer) => clearTimeout(timer),
    },
  };
}

export function mergeAgentSessionManagerHost(
  base: AgentSessionManagerHost,
  overrides?: Partial<AgentSessionManagerHost>,
): AgentSessionManagerHost {
  return {
    ...base,
    ...overrides,
    workspace: overrides?.workspace ?? base.workspace,
    config: overrides?.config ?? base.config,
    providers: overrides?.providers ?? base.providers,
    createEngine: overrides?.createEngine ?? base.createEngine,
    createSession: overrides?.createSession ?? base.createSession,
    createCheckpointManager:
      overrides?.createCheckpointManager ?? base.createCheckpointManager,
    createActivityTraceRecorder:
      overrides?.createActivityTraceRecorder ??
      base.createActivityTraceRecorder,
    captureProjectToolContext:
      overrides?.captureProjectToolContext ?? base.captureProjectToolContext,
    createToolRuntime: overrides?.createToolRuntime ?? base.createToolRuntime,
    acpBackgroundRunner:
      overrides?.acpBackgroundRunner ?? base.acpBackgroundRunner,
    workspaceMutationCoordinator:
      overrides?.workspaceMutationCoordinator ??
      base.workspaceMutationCoordinator,
    persistence:
      overrides && "persistence" in overrides
        ? overrides.persistence
        : base.persistence,
    timers: overrides?.timers ?? base.timers,
  };
}
