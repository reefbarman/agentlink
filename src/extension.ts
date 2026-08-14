import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

import { StatusBarManager } from "./util/StatusBarManager.js";
import { canonicalizePath, isPathWithinRoot } from "./util/paths.js";
import { sleep } from "./util/sleep.js";
import {
  disposeTerminalManager,
  initializeTerminalManager,
} from "./integrations/TerminalManager.js";
import { registerDiffViewCommands } from "./integrations/diffViewCommands.js";
import { registerDiffViewContentProvider } from "./integrations/diffViewContentProvider.js";
import { SidebarProvider } from "./sidebar/SidebarProvider.js";
import { ApprovalManager } from "./approvals/ApprovalManager.js";
import { ApprovalPanelProvider } from "./approvals/ApprovalPanelProvider.js";
import type { ApprovalProjectContext } from "./approvals/webview/types.js";
import { ConfigStore } from "./approvals/ConfigStore.js";
import {
  buildCommandReviewContext,
  createCommandApprovalReviewer,
} from "./approvals/commandApprovalReview.js";
import { createNetworkApprovalReviewer } from "./approvals/networkApprovalReview.js";
import { createActionApprovalReviewer } from "./approvals/actionApprovalReview.js";
import { AgentToolCallTracker } from "./agent/AgentToolCallTracker.js";
import { registerAgentActivityCommands } from "./agent/agentActivityCommands.js";
import {
  openDefaultAgentViewOnce,
  registerAgentWorkbenchLayout,
} from "./agent/workbenchLayout.js";
import { normalizeBackgroundMaxConcurrent } from "./agent/background/backgroundConcurrency.js";
import { addTrustedCommandViaUi } from "./agent/trustedCommandFlow.js";
import { registerCodexAuthCommands } from "./agent/codexAuthCommands.js";
import { registerOpenAiCompatibleAuthCommands } from "./agent/openAiCompatibleAuthCommands.js";
import { OpenAiCompatibleCredentialService } from "./agent/openAiCompatibleCredentials.js";
import { registerOpenAiCompatibleModelConfigurationWizard } from "./agent/openAiCompatibleModelConfigurationWizard.js";
import { getOpenAiCompatibleSecretKey } from "./agent/openAiCompatibleSecrets.js";
import { createCodexAuthFlows } from "./agent/codexAuthFlows.js";
import { runLegacyAgentIntegrationCleanup } from "./util/legacyAgentIntegrationCleanup.js";

import {
  resolveAnthropicModelAuth,
  setStoredAnthropicApiKey,
} from "./agent/clientFactory.js";
import { IndexerManager } from "./indexer/IndexerManager.js";
import { registerIndexCommands } from "./indexer/indexCommands.js";
import { createCodeRetrievalHealthProvider } from "./indexer/codeRetrievalHealth.js";
import { AutonomousMemoryToolProvider } from "./storage/retrieval/AutonomousMemoryToolProvider.js";
import { LanceDbRetrievalRepository } from "./storage/retrieval/LanceDbRetrievalRepository.js";
import { RetrievalSkillCatalogFallbackProvider } from "./storage/retrieval/RetrievalSkillCatalogFallbackProvider.js";
import { getRetrievalStoreRoot } from "./storage/retrieval/retrievalStorePaths.js";
import { cleanupLegacyCodeRetrievalStore } from "./storage/retrieval/legacyCodeRetrievalCleanup.js";
import { cleanupSupersededCodeIndexGenerations } from "./storage/retrieval/supersededCodeIndexGenerationCleanup.js";
import { CODE_INDEX_STORAGE_GENERATION } from "./indexer/codeRetrievalIdentity.js";
import { SkillCatalogRetrievalService } from "./core/catalog/SkillCatalogRetrievalService.js";
import { startHostLivenessMonitor } from "./core/hostLiveness.js";
import { appendJsonlLinesWithLock } from "./telemetry/jsonlAppend.js";
import { migrateLegacyMemoryFiles } from "./agent/legacyMemoryMigration.js";
import { ChatViewProvider } from "./agent/ChatViewProvider.js";
import { AgentSessionManager } from "./agent/AgentSessionManager.js";
import { ChatTabController, type ChatTab } from "./agent/ChatTabController.js";
import { ChatTabPanelHost } from "./agent/ChatTabPanelHost.js";
import { createChatWorkspaceViewSnapshot } from "./agent/chatTabProtocol.js";
import { createForegroundChatTabSync } from "./agent/chatTabForegroundSync.js";
import { restoreChatTabStartup } from "./agent/chatTabStartupRestore.js";
import { TabTerminalProviderRegistry } from "./agent/TabTerminalProviderRegistry.js";
import { WorkspaceMutationCoordinator } from "./agent/WorkspaceMutationCoordinator.js";
import { ProjectCustomizationRegistry } from "./agent/ProjectCustomizationRegistry.js";
import { getConfiguredBaseThresholdForModel } from "./agent/modelCondenseThresholds.js";
import {
  resolveModelForMode,
  FALLBACK_AGENT_MODEL,
} from "./agent/modeModelPreferences.js";
import { SessionStore } from "./agent/SessionStore.js";
import type { AgentConfig } from "./agent/types.js";
import {
  normalizePromptProfileOverrides,
  resolvePromptProfile,
} from "./core/promptProfile.js";
import { registerEditorContextCommands } from "./agent/editorContextCommands.js";
import { registerModelAuthCommands } from "./agent/modelAuthCommands.js";
import { AnthropicProvider } from "./agent/providers/anthropic/index.js";
import { OpenAiCompatibleProviderManager } from "./agent/providers/openaiCompatible/index.js";
import { discoverOpenAiCompatibleModels } from "./agent/providers/openaiCompatible/modelDiscovery.js";
import {
  providerRegistry,
  CodexProvider,
  openAiCodexAuthManager,
  queryCodexCliUsage,
} from "./agent/providers/index.js";
import { BrowserGatewayService } from "./browser-gateway/BrowserGatewayService.js";
import { wireBrowserGatewayApprovalPolicies } from "./browser-gateway/browserGatewayPolicyWiring.js";
import { BrowserGatewayRepositoryObserver } from "./browser-gateway/BrowserGatewayRepositoryObserver.js";
import { BrowserGatewayServer } from "./browser-gateway/BrowserGatewayServer.js";
import { registerBrowserGatewayCommands } from "./browser-gateway/browserGatewayCommands.js";
import {
  BROWSER_GATEWAY_DATA_PLANE_DEFAULT,
  isBrowserGatewayOwnerPublicationEnabled,
  normalizeBrowserGatewayDataPlaneMode,
  type BrowserGatewayDataPlaneMode,
} from "./browser-gateway/browserGatewayDataPlaneMode.js";
import {
  BROWSER_GATEWAY_PRODUCTION_OWNER_COMMAND_CAPABILITIES,
  ProductionBrowserGatewayOwnerCommandExecutor,
} from "./browser-gateway/dataPlane/BrowserGatewayOwnerCommandExecutor.js";
import { BrowserGatewayOwnerRuntime } from "./browser-gateway/dataPlane/BrowserGatewayOwnerRuntime.js";
import { diffSnapshotHub } from "./browser-gateway/DiffSnapshotHub.js";
import {
  bootstrapBrowserGatewayHelper,
  resolveHealthyDiscoveredHelper,
} from "./browser-gateway/helper/bootstrapHelper.js";
import { readBrowserGatewayHelperDiscovery } from "./browser-gateway/browserGatewayHelperDiscovery.js";
import { BrowserGatewayHelperAdminClient } from "./browser-gateway/helper/BrowserGatewayHelperAdminClient.js";
import { BrowserGatewayHelperLeaseClient } from "./browser-gateway/helper/BrowserGatewayHelperLeaseClient.js";
import { BrowserGatewayHelperModelAuthLeaseClient } from "./browser-gateway/helper/BrowserGatewayHelperModelAuthLeaseClient.js";
import type { BrowserGatewayCoreOwnerLeaseRegistration } from "./browser-gateway/protocol.js";
import type { CoreModelCatalogEntry } from "./core/modelCatalog.js";
import { normalizeMaxConcurrentModelRequests } from "./core/modelRequestScheduler.js";
import { normalizeBrowserGatewayModelCredentialProviderId } from "./browser-gateway/browserGatewayModelProviderIds.js";
import { setBrowserGatewayRegistryLogger } from "./browser-gateway/browserGatewayRegistry.js";
import { WorktreeAgentIntentStore } from "./worktree/WorktreeAgentIntentStore.js";
import { WorktreeFleetExchangeStore } from "./worktree/WorktreeFleetExchangeStore.js";
import { createVscodeWorktreeAgentLaunchProvider } from "./adapters/vscode/worktreeAgentLaunchCapabilities.js";
import { FleetAutomationStore } from "./agent/FleetAutomationStore.js";
import { createFleetAutomationLifecycle } from "./agent/fleetAutomationLifecycle.js";
import {
  agentLinkFetch,
  installAgentLinkHttpDispatcher,
} from "./util/httpDispatcher.js";
import {
  describeWorkspaceHistoryLocation,
  resolveWorkspaceSessionLocation,
  type WorkspaceSessionLocation,
} from "./agent/workspaceSessionIdentity.js";
import { WorkspaceContinuityCatalog } from "./agent/workspaceContinuityCatalog.js";
import {
  classifyWorkspaceHistoryTransition,
  hasPersistedWorkspaceHistory,
  migrateWorkspaceHistory,
  type WorkspaceHistoryShape,
} from "./agent/workspaceHistoryMigration.js";
import { createSessionProjectScope } from "./core/workspaceProjects.js";
import {
  createWorkspaceProjectCatalog,
  selectNewSessionProject,
} from "./adapters/vscode/workspaceProjectCapabilities.js";
import { getAffectedProjectSettingIds } from "./adapters/vscode/projectSettingsAccessor.js";
import {
  createToolUsageTelemetry,
  type ToolUsageTelemetry,
} from "./telemetry/ToolUsageTelemetry.js";
import {
  createContextUsageTelemetry,
  type ContextUsageTelemetry,
} from "./telemetry/ContextUsageTelemetry.js";
import {
  createSessionOutcomeTelemetry,
  type SessionOutcomeTelemetry,
} from "./telemetry/SessionOutcomeTelemetry.js";
import { createVscodeTerminalProvider } from "./adapters/vscode/terminalCapabilities.js";
import { AgentTerminalViewProvider } from "./terminal/AgentTerminalViewProvider.js";
import { createDeferredNodePtyLoader } from "./terminal/deferredNodePtyLoader.js";
import { materializeHostShellBootstrap } from "./terminal/hostShellBootstrap.js";
import { LiveHostTerminalSurfaceController } from "./terminal/LiveHostTerminalSurfaceController.js";
import { NativeAgentTerminalCoordinator } from "./terminal/native/NativeAgentTerminalCoordinator.js";
import { Phase1HostTerminalCoordinator } from "./terminal/Phase1HostTerminalCoordinator.js";
import { prepareHostShellBootstrap } from "./terminal/prepareHostShellBootstrap.js";
import {
  AgentTerminalProviderRouter,
  type SandboxPreparationAvailability,
} from "./terminal/sandbox/AgentTerminalProviderRouter.js";
import { BaselineSandboxLaunchAuthorizer } from "./terminal/sandbox/BaselineSandboxLaunchAuthorizer.js";
import type { SandboxShellEnvironmentPolicy } from "./terminal/sandbox/sandboxEnvironmentPolicy.js";
import { SandboxHelperClient } from "./terminal/sandbox/SandboxHelperClient.js";
import { createNodeSandboxHelperTransportFactory } from "./terminal/sandbox/NodeSandboxHelperTransport.js";
import { SandboxTerminalChannelHub } from "./terminal/sandbox/SandboxTerminalChannelHub.js";
import { SandboxTerminalCoordinator } from "./terminal/sandbox/SandboxTerminalCoordinator.js";
import { resolveSandboxCapabilityGrantTiming } from "./terminal/sandbox/sandboxCapabilityGrantTiming.js";
import { SandboxBehaviorAttestationService } from "./terminal/sandbox/SandboxBehaviorAttestationService.js";
import {
  createProductionSandboxBehaviorProbe,
  createProductionSandboxRuntimeFingerprint,
} from "./terminal/sandbox/ProductionSandboxBehaviorProbe.js";
import {
  resolveSandboxNodeRuntime,
  SandboxNodeRuntimeUnavailableError,
  type ResolvedSandboxNodeRuntime,
} from "./terminal/sandbox/sandboxNodeRuntime.js";
import {
  readVscodeTerminalConfigurationSnapshot,
  readVscodeTerminalSurfaceConfiguration,
  resolveVscodeTerminalCreateRequest,
} from "./terminal/vscodeTerminalConfiguration.js";
import { showWebAccessDisclosureOnce } from "./util/webAccessDisclosure.js";

const BROWSER_GATEWAY_HEALTH_CHECK_INTERVAL_MS = 30_000;

let outputChannel: vscode.OutputChannel;
let statusBarManager: StatusBarManager;
let sidebarProvider: SidebarProvider;
let approvalManager: ApprovalManager;
let approvalPanel: ApprovalPanelProvider;
let toolCallTracker: AgentToolCallTracker;
let builtinApprovalPanel: ApprovalPanelProvider;
let indexerManager: IndexerManager | null = null;
let chatViewProvider: ChatViewProvider;
let agentSessionManager: AgentSessionManager;
let chatTabController: ChatTabController;
let chatTabPanelHost: ChatTabPanelHost | null = null;
let browserGatewayService: BrowserGatewayService | null = null;
let browserGatewayServer: BrowserGatewayServer | null = null;
let browserGatewayAuthToken: string | null = null;
let browserGatewayHelperDiscovery:
  | import("./browser-gateway/protocol.js").BrowserGatewayHelperDiscoveryRecord
  | null = null;
let toolUsageTelemetry: ToolUsageTelemetry | null = null;
let contextUsageTelemetry: ContextUsageTelemetry | null = null;
let sessionOutcomeTelemetry: SessionOutcomeTelemetry | null = null;

let browserGatewayHelperLeaseClient: BrowserGatewayHelperLeaseClient | null =
  null;
let browserGatewayHelperAdminClient: BrowserGatewayHelperAdminClient | null =
  null;
let browserGatewayHelperModelAuthLeaseClient: BrowserGatewayHelperModelAuthLeaseClient | null =
  null;
let browserGatewayShutdownPromise: Promise<void> | null = null;
let skillCatalogShutdownPromise: Promise<void> | null = null;

const SEMANTIC_SETUP_PROMPT_DISMISSED_KEY =
  "semanticSetupPromptDismissedGlobally";

function log(message: string): void {
  const timestamp = new Date().toISOString();
  outputChannel.appendLine(`[${timestamp}] ${message}`);
}

function workspaceHistoryShape(location: {
  workspaceIdentity: string;
  workspaceFolderUris: readonly string[];
  workspaceFileUri?: string;
}): WorkspaceHistoryShape {
  return {
    workspaceIdentity: location.workspaceIdentity,
    workspaceFolderUris: location.workspaceFolderUris,
    ...(location.workspaceFileUri
      ? { workspaceFileUri: location.workspaceFileUri }
      : {}),
  };
}

function hasIndependentPersistedHistory(
  destination: WorkspaceSessionLocation,
  sourceHistoryDirectory: string,
): boolean {
  return Boolean(
    destination.historyDirectory &&
    path.resolve(destination.historyDirectory) !==
      path.resolve(sourceHistoryDirectory) &&
    hasPersistedWorkspaceHistory(
      destination.historyDirectory,
      destination.historyStorageKind,
    ),
  );
}

function isRealDirectory(directory: string): boolean {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function getConfig<T>(key: string): T {
  return vscode.workspace.getConfiguration("agentlink").get(key) as T;
}

function resolveApprovalProjectContext(input: {
  sessionId?: string;
  targetPath?: string;
}): {
  sourceProject?: ApprovalProjectContext;
  targetProject?: ApprovalProjectContext;
  targetPath?: string;
  projectResourceUri?: string;
} {
  const session = input.sessionId
    ? agentSessionManager?.getSession(input.sessionId)
    : undefined;
  const sourceScope = session?.projectScope;
  const sourceProject = sourceScope
    ? {
        projectId: sourceScope.projectId,
        displayName: sourceScope.displayName,
        availability: session.projectAvailability,
      }
    : undefined;
  const targetPath = input.targetPath
    ? canonicalizePath(
        path.isAbsolute(input.targetPath)
          ? input.targetPath
          : sourceScope?.rootPath
            ? path.resolve(sourceScope.rootPath, input.targetPath)
            : input.targetPath,
      )
    : undefined;
  const target = targetPath
    ? agentSessionManager
        ?.getWorkspaceProjects()
        .filter((project) => project.rootPath)
        .sort(
          (left, right) =>
            (right.rootPath?.length ?? 0) - (left.rootPath?.length ?? 0),
        )
        .find((project) =>
          isPathWithinRoot(targetPath, canonicalizePath(project.rootPath!)),
        )
    : undefined;
  const targetProject: ApprovalProjectContext | undefined =
    target && target.id !== sourceProject?.projectId
      ? {
          projectId: target.id,
          displayName: target.name,
          availability:
            target.availability.status === "available"
              ? "available"
              : "unavailable",
        }
      : undefined;
  return {
    sourceProject,
    targetProject,
    targetPath,
    projectResourceUri: sourceScope?.workspaceFolderUri,
  };
}

async function consumeWorktreeStartupIntent(
  context: vscode.ExtensionContext,
  provider: ChatViewProvider,
  logFn: (msg: string) => void,
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== "file") return;

  try {
    const store = new WorktreeAgentIntentStore(context.globalStorageUri.fsPath);
    const intent = await store.consumeIntentForWorkspace(folder.uri.fsPath);
    if (!intent) {
      await store.pruneExpired();
      return;
    }
    logFn(
      `[worktree-agent] consumed startup intent ${intent.id} for ${intent.worktreePath}`,
    );
    const childSessionId = await provider.startPromptInMode({
      prompt: intent.prompt,
      mode: intent.mode,
      autoSubmit: intent.autoSubmit,
      commandApprovalPolicy: intent.commandApprovalPolicy,
      approvalPolicy: intent.approvalPolicy,
      approvalReviewer: intent.approvalReviewer,
      executionPreset: intent.executionPreset,
    });
    if (intent.fleetExchangeId) {
      const exchangeStore = new WorktreeFleetExchangeStore(
        context.globalStorageUri.fsPath,
      );
      await exchangeStore.update(intent.fleetExchangeId, {
        childSessionId,
        worktreePath: intent.worktreePath,
        status: "claimed",
      });
      const removeListener = agentSessionManager.addAgentEventListener(
        (sessionId, event) => {
          if (sessionId !== childSessionId) return;
          const session = agentSessionManager.getSession(childSessionId);
          if (event.type === "api_request") {
            void exchangeStore.update(intent.fleetExchangeId!, {
              status: "running",
              usage: {
                inputTokens: session?.totalInputTokens ?? 0,
                outputTokens: session?.totalOutputTokens ?? 0,
              },
            });
          } else if (event.type === "done") {
            clearInterval(cancellationTimer);
            removeListener();
            void exchangeStore.update(intent.fleetExchangeId!, {
              status: "completed",
              resultText:
                session?.getLastAssistantText() ??
                "Worktree agent completed without output",
              usage: {
                inputTokens: session?.totalInputTokens ?? 0,
                outputTokens: session?.totalOutputTokens ?? 0,
              },
            });
          } else if (event.type === "error") {
            clearInterval(cancellationTimer);
            removeListener();
            void exchangeStore.update(intent.fleetExchangeId!, {
              status: "failed",
              error: event.error,
              resultText: session?.getLastAssistantText(),
            });
          }
        },
      );
      const cancellationTimer = setInterval(() => {
        void exchangeStore.read(intent.fleetExchangeId!).then((record) => {
          if (!record?.cancelRequestedAt) return;
          clearInterval(cancellationTimer);
          removeListener();
          agentSessionManager.stopSession(childSessionId);
          void exchangeStore.update(intent.fleetExchangeId!, {
            status: "cancelled",
            error: "cancelled_by_parent",
            resultText: agentSessionManager
              .getSession(childSessionId)
              ?.getLastAssistantText(),
          });
        });
      }, 1000);
      context.subscriptions.push({
        dispose: () => {
          clearInterval(cancellationTimer);
          removeListener();
        },
      });
    }
  } catch (err) {
    logFn(
      `[worktree-agent] failed to consume startup intent: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  installAgentLinkHttpDispatcher();

  outputChannel = vscode.window.createOutputChannel("AgentLink");
  context.subscriptions.push(outputChannel);

  const configureProviderRequestConcurrency = () => {
    const configured = normalizeMaxConcurrentModelRequests(
      getConfig<unknown>("provider.maxConcurrentRequests"),
    );
    providerRegistry.requestScheduler.setMaxConcurrentPerProvider(configured);
    log(
      `[provider-scheduler] max concurrent requests per provider: ${configured}`,
    );
  };
  configureProviderRequestConcurrency();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("agentlink.provider.maxConcurrentRequests")
      ) {
        configureProviderRequestConcurrency();
      }
    }),
  );

  let agentTerminalViewProvider: AgentTerminalViewProvider | undefined;
  let liveTerminalSurfaceController:
    | LiveHostTerminalSurfaceController
    | undefined;
  const agentNodePtyLoader = createDeferredNodePtyLoader({
    extensionRoot: context.extensionPath,
  });
  const sandboxTerminalChannelHub = new SandboxTerminalChannelHub();
  let resolvedSandboxNodeRuntime: ResolvedSandboxNodeRuntime | undefined;
  let sandboxBehaviorAttestationService:
    | SandboxBehaviorAttestationService
    | undefined;
  let sandboxNodeRuntimePromise:
    | Promise<ResolvedSandboxNodeRuntime>
    | undefined;
  let agentTerminalProvider: AgentTerminalProviderRouter | undefined;
  let hostTerminalCoordinator!: Phase1HostTerminalCoordinator;
  let customTerminalRuntimeWarning: string | undefined;
  let sandboxRuntimeWarning: string | undefined;
  const resetSandboxNodeRuntime = () => {
    resolvedSandboxNodeRuntime = undefined;
    sandboxNodeRuntimePromise = undefined;
    sandboxRuntimeWarning = undefined;
    sandboxBehaviorAttestationService?.dispose();
    sandboxBehaviorAttestationService = undefined;
  };
  const ensureSandboxNodeRuntime = () => {
    if (!sandboxNodeRuntimePromise) {
      sandboxNodeRuntimePromise = resolveSandboxNodeRuntime({
        extensionRoot: context.extensionPath,
        configuredPath: vscode.workspace
          .getConfiguration("agentlink")
          .get<string>("terminal.nodePath", ""),
        environmentPath: process.env.PATH,
      }).then((runtime) => {
        resolvedSandboxNodeRuntime = runtime;
        sandboxRuntimeWarning = undefined;
        log(
          `[sandbox-terminal] Using standalone Node runtime ${runtime.executable} (${runtime.source})`,
        );
        return runtime;
      });
      void sandboxNodeRuntimePromise.catch(() => undefined);
    }
    return sandboxNodeRuntimePromise;
  };
  const showSandboxRuntimeUnavailable = async (error: Error) => {
    if (sandboxRuntimeWarning === error.message) return;
    sandboxRuntimeWarning = error.message;
    const dependencyFailure =
      error instanceof SandboxNodeRuntimeUnavailableError;
    if (dependencyFailure) {
      for (const attempt of error.attempts) {
        log(`[sandbox-terminal] Runtime candidate rejected: ${attempt}`);
      }
    }
    const actions = dependencyFailure
      ? (["Configure Node Path", "Install Node.js", "Retry"] as const)
      : (["Show Logs", "Retry"] as const);
    const action = await vscode.window.showWarningMessage(
      `${error.message} Sandbox execution is unavailable; agent commands will use the native terminal route until it is fixed.`,
      ...actions,
    );
    if (action === "Configure Node Path") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "agentlink.terminal.nodePath",
      );
    } else if (action === "Install Node.js") {
      await vscode.env.openExternal(
        vscode.Uri.parse("https://nodejs.org/en/download"),
      );
    } else if (action === "Show Logs") {
      outputChannel.show(true);
    } else if (action === "Retry") {
      resetSandboxNodeRuntime();
      agentTerminalProvider?.refresh();
    }
  };
  const showCustomTerminalRuntimeUnavailable = async (error: Error) => {
    if (customTerminalRuntimeWarning === error.message) return;
    customTerminalRuntimeWarning = error.message;
    const action = await vscode.window.showWarningMessage(
      `${error.message} AgentLink Terminal is unavailable.`,
      "Show Logs",
      "Retry",
    );
    if (action === "Show Logs") {
      outputChannel.show(true);
    } else if (action === "Retry") {
      customTerminalRuntimeWarning = undefined;
      void hostTerminalCoordinator.refresh();
    }
  };
  hostTerminalCoordinator = new Phase1HostTerminalCoordinator({
    getHost: () => ({
      platform: process.platform,
      remoteName: vscode.env.remoteName,
    }),
    isEnabled: () =>
      vscode.workspace
        .getConfiguration("agentlink")
        .get<boolean>("terminal.enabled", true),
    setContext: (key, value) =>
      vscode.commands.executeCommand("setContext", key, value),
    subscribeEnabledChanges: (listener) =>
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("agentlink.terminal.enabled"))
          listener();
      }),
    createRuntime: async () => {
      const controller = new LiveHostTerminalSurfaceController({
        host: {
          platform: process.platform,
          remoteName: vscode.env.remoteName,
        },
        runtimeRoot: path.join(
          context.globalStorageUri.fsPath,
          "host-terminal-bootstrap",
        ),
        nodePtyLoader: agentNodePtyLoader,
        getConfigurationSnapshot: ({ cwd, profileName }) =>
          readVscodeTerminalConfigurationSnapshot({
            requestedCwd: cwd,
            selectedProfileName: profileName,
          }),
        getSurfaceConfiguration: readVscodeTerminalSurfaceConfiguration,
        isAcceptingRequests: () => hostTerminalCoordinator.isAcceptingRequests,
        createId: randomUUID,
        openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
        openNativeTerminal: () => {
          vscode.window.createTerminal().show();
        },
        readClipboard: () => vscode.env.clipboard.readText(),
        writeClipboard: (text) => vscode.env.clipboard.writeText(text),
        sandboxChannelHub: sandboxTerminalChannelHub,
        requestTerminalViewReveal: () => {
          agentTerminalViewProvider?.revealPreservingFocus();
        },
        log,
      });
      liveTerminalSurfaceController = controller;
      const provider = new AgentTerminalViewProvider({
        controller,
        extensionUri: context.extensionUri,
        resolveCreateRequest: resolveVscodeTerminalCreateRequest,
        log,
      });
      agentTerminalViewProvider = provider;
      try {
        const registration = vscode.window.registerWebviewViewProvider(
          AgentTerminalViewProvider.viewType,
          provider,
          { webviewOptions: { retainContextWhenHidden: true } },
        );
        const configurationSubscription =
          vscode.workspace.onDidChangeConfiguration((event) => {
            if (
              [
                "fontFamily",
                "fontSize",
                "lineHeight",
                "letterSpacing",
                "cursorStyle",
                "cursorBlinking",
                "scrollback",
              ].some((key) =>
                event.affectsConfiguration(`terminal.integrated.${key}`),
              ) ||
              event.affectsConfiguration("editor.fontFamily") ||
              event.affectsConfiguration("editor.accessibilitySupport")
            ) {
              controller.updateConfiguration(
                readVscodeTerminalSurfaceConfiguration(),
              );
            }
          });
        customTerminalRuntimeWarning = undefined;
        return {
          dispose: () => {
            if (agentTerminalViewProvider === provider) {
              agentTerminalViewProvider = undefined;
            }
            if (liveTerminalSurfaceController === controller) {
              liveTerminalSurfaceController = undefined;
            }
            controller.dispose();
            configurationSubscription.dispose();
            registration.dispose();
            provider.dispose();
          },
        };
      } catch (error) {
        if (agentTerminalViewProvider === provider) {
          agentTerminalViewProvider = undefined;
        }
        if (liveTerminalSurfaceController === controller) {
          liveTerminalSurfaceController = undefined;
        }
        controller.dispose();
        provider.dispose();
        throw error;
      }
    },
    onRuntimeUnavailable: showCustomTerminalRuntimeUnavailable,
    log,
  });
  context.subscriptions.push(hostTerminalCoordinator);
  hostTerminalCoordinator.start();

  initializeTerminalManager(context.extensionUri, log);

  // Load stored Anthropic API key into memory so createAnthropicClient can use it synchronously.
  void context.secrets.get("anthropicApiKey").then((key) => {
    setStoredAnthropicApiKey(key || undefined);
  });

  log("Activating AgentLink extension");

  void showWebAccessDisclosureOnce({
    state: context.globalState,
    showInformationMessage: (message, action) =>
      vscode.window.showInformationMessage(message, action),
    openSettings: (query) =>
      vscode.commands.executeCommand("workbench.action.openSettings", query),
  }).catch((error) => {
    log(`Web access disclosure failed: ${String(error)}`);
  });

  void runLegacyAgentIntegrationCleanup({
    homeDir: os.homedir(),
    workspaceRoots:
      vscode.workspace.workspaceFolders
        ?.filter((folder) => folder.uri.scheme === "file")
        .map((folder) => folder.uri.fsPath) ?? [],
    state: context.globalState,
    log,
  }).then(
    (report) => {
      log(
        `Legacy AgentLink cleanup completed: ${report.changedTargets.length} changed, ${report.completedTargets.length} checked, ${report.failures.length} failed`,
      );
    },
    (error) => {
      log(`Legacy AgentLink cleanup failed to start: ${String(error)}`);
    },
  );

  // Config store for disk-based approval rules
  const configStore = new ConfigStore();
  context.subscriptions.push({ dispose: () => configStore.dispose() });

  // Approval manager for built-in agent sessions
  approvalManager = new ApprovalManager(context.globalState, configStore);
  context.subscriptions.push(approvalManager);
  approvalManager.migrateFromGlobalState().catch((err) => {
    log(`Migration warning: ${err}`);
  });
  approvalManager.clearLegacyPersistedSessions().catch((err) => {
    log(`Session approval cleanup warning: ${err}`);
  });

  context.subscriptions.push(registerDiffViewContentProvider());

  // Tool call tracker (wraps tool handlers for cancel/complete from sidebar)
  const extVersion =
    (context.extension.packageJSON as { version?: string })?.version ??
    "unknown";
  toolUsageTelemetry = createToolUsageTelemetry({
    extensionVersion: extVersion,
    log,
  });
  context.subscriptions.push(toolUsageTelemetry);
  contextUsageTelemetry = createContextUsageTelemetry({
    extensionVersion: extVersion,
    log,
  });
  context.subscriptions.push(contextUsageTelemetry);
  sessionOutcomeTelemetry = createSessionOutcomeTelemetry({
    extensionVersion: extVersion,
    log,
  });
  context.subscriptions.push(sessionOutcomeTelemetry);

  // Event-loop stall watchdog: reports extension-host lockups the moment the
  // loop unblocks, with the flight-recorder ops that were running at the time
  // (see src/core/hostLiveness.ts). Records land in the output channel and in
  // ~/.agentlink/host-stall-telemetry.jsonl for post-mortem across windows.
  const stallWorkspace =
    vscode.workspace.workspaceFolders?.[0]?.name ?? "no-workspace";
  const appendHostStallRecord = (record: Record<string, unknown>): void => {
    void appendJsonlLinesWithLock(
      path.join(os.homedir(), ".agentlink", "host-stall-telemetry.jsonl"),
      [
        JSON.stringify({
          ...record,
          atIso: new Date(Number(record["at"]) || Date.now()).toISOString(),
          pid: process.pid,
          workspace: stallWorkspace,
          extensionVersion: extVersion,
        }),
      ],
      {
        lockTimeoutMs: 2_000,
        staleLockMs: 30_000,
        lockTimeoutError: "host-stall telemetry lock timeout",
      },
    ).catch(() => {
      // Telemetry writes must never disturb the host; the output-channel line
      // above is the fallback record.
    });
  };
  const hostLivenessMonitor = startHostLivenessMonitor({
    onStall: (record) => {
      const inFlight = record.inFlightOps
        .map((op) => `${op.label}${op.detail ? `(${op.detail})` : ""}`)
        .join(", ");
      const recent = record.recentOps
        .slice(-5)
        .map((op) => `${op.label}:${Math.round(op.durationMs)}ms`)
        .join(", ");
      log(
        `[host-stall] event loop blocked ~${Math.round(record.lagMs)}ms ` +
          `inFlight=[${inFlight}] recent=[${recent}]`,
      );
      appendHostStallRecord({ ...record });
    },
    onSummary: (record) => {
      log(
        `[host-stall] delay summary p50=${record.p50Ms.toFixed(1)}ms ` +
          `p99=${record.p99Ms.toFixed(1)}ms max=${record.maxMs.toFixed(1)}ms`,
      );
      appendHostStallRecord({ ...record });
    },
  });
  context.subscriptions.push({ dispose: () => hostLivenessMonitor.stop() });
  let tabTerminalProviders: TabTerminalProviderRegistry | undefined;
  toolCallTracker = new AgentToolCallTracker(log, (sessionId) => {
    const manager = agentSessionManager as AgentSessionManager | undefined;
    const tabs = chatTabController as ChatTabController | undefined;
    const session = manager?.getSession(sessionId);
    const rootSessionId = session?.fleetMetadata?.rootSessionId ?? sessionId;
    const tab = tabs?.getTabForSession(rootSessionId);
    return tab && tabTerminalProviders
      ? tabTerminalProviders.forOwner({
          tabId: tab.id,
          tabLabel: `T${tab.displayNumber}`,
          sessionId,
          generation: tab.terminalGeneration,
        })
      : undefined;
  });

  // Status bar manager for approval alerts and indexer errors
  statusBarManager = new StatusBarManager();
  context.subscriptions.push(statusBarManager);

  // External-agent approvals use the split-editor presentation. Built-in agent
  // approvals are forwarded into chat through builtinApprovalPanel below.
  approvalPanel = new ApprovalPanelProvider(
    context.extensionUri,
    statusBarManager,
    resolveApprovalProjectContext,
  );
  context.subscriptions.push(approvalPanel);

  // Sidebar
  sidebarProvider = new SidebarProvider(context.extensionUri, log, () =>
    outputChannel.show(true),
  );
  sidebarProvider.setApprovalManager(approvalManager);
  sidebarProvider.setToolCallTracker(toolCallTracker);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewType,
      sidebarProvider,
    ),
  );

  // Agent chat view
  const agentConfiguration = vscode.workspace.getConfiguration("agentlink");
  const workspaceSessionLocation = resolveWorkspaceSessionLocation({
    workspaceFolders: vscode.workspace.workspaceFolders,
    workspaceFile: vscode.workspace.workspaceFile,
    fallbackCwd: process.cwd(),
  });
  const workspaceContinuityCatalog = new WorkspaceContinuityCatalog(
    context.globalStorageUri.fsPath,
  );
  if (
    workspaceSessionLocation.status === "ready" &&
    workspaceSessionLocation.historyDirectory &&
    workspaceSessionLocation.stateAnchor
  ) {
    workspaceContinuityCatalog.remember({
      ...workspaceHistoryShape(workspaceSessionLocation),
      historyDirectory: workspaceSessionLocation.historyDirectory,
      anchorRootPath: workspaceSessionLocation.stateAnchor.rootPath,
      updatedAt: Date.now(),
    });
  }
  agentTerminalProvider = new AgentTerminalProviderRouter({
    isEnabled: () =>
      vscode.workspace
        .getConfiguration("agentlink")
        .get<boolean>("terminal.enabled", true),
    getHost: () => ({
      platform: process.platform,
      remoteName: vscode.env.remoteName,
      workspaceTrusted: vscode.workspace.isTrusted,
    }),
    createNativeProvider: createVscodeTerminalProvider,
    revealCustomTerminal: (terminalId) =>
      liveTerminalSurfaceController?.revealTerminal(terminalId) ?? false,
    createNativeAgentProvider: () => {
      const coordinator = new NativeAgentTerminalCoordinator({
        nodePtyLoader: agentNodePtyLoader,
        initialCwd: workspaceCwd,
        prepareShell: async ({ channelId, cwd, env }) => {
          const configuration = readVscodeTerminalConfigurationSnapshot({
            requestedCwd: cwd,
          });
          const prepared = prepareHostShellBootstrap({
            configuration: {
              ...configuration,
              baseEnvironment: {
                ...configuration.baseEnvironment,
                ...env,
              },
            },
            host: {
              platform: process.platform,
              remoteName: vscode.env.remoteName,
            },
            runtimeRoot: path.join(
              context.globalStorageUri.fsPath,
              "native-agent-terminal-bootstrap",
            ),
            artifactId: `channel-${channelId}-${randomUUID()}`.replaceAll(
              "-",
              "_",
            ),
            nonce: randomUUID().replaceAll("-", "_"),
            originalZdotdir: configuration.baseEnvironment.ZDOTDIR,
          });
          if (prepared.plan.mode !== "integrated") {
            throw new Error(
              prepared.plan.mode === "native-fallback"
                ? prepared.plan.message
                : "Native Agent requires integrated bash or zsh shell support",
            );
          }
          await fs.promises.mkdir(
            path.join(
              context.globalStorageUri.fsPath,
              "native-agent-terminal-bootstrap",
            ),
            { recursive: true },
          );
          return materializeHostShellBootstrap({
            ...prepared.plan,
            profile: {
              ...prepared.plan.profile,
              environment: {
                ...prepared.plan.profile.environment,
                ...env,
                ...(prepared.plan.shell === "zsh"
                  ? { ZDOTDIR: prepared.plan.profile.environment.ZDOTDIR }
                  : {}),
              },
            },
          });
        },
        createChannelId: () => `native-agent-${randomUUID()}`,
        createCommandId: randomUUID,
        log,
      });
      sandboxTerminalChannelHub.attach(coordinator, "native");
      return coordinator;
    },
    getSandboxAvailability:
      async (): Promise<SandboxPreparationAvailability> => {
        let runtime: ResolvedSandboxNodeRuntime;
        try {
          runtime = await ensureSandboxNodeRuntime();
        } catch (error) {
          const failure =
            error instanceof Error ? error : new Error(String(error));
          log(
            `[sandbox-terminal] Using native terminal fallback before sandbox selection: ${failure.message}`,
          );
          void showSandboxRuntimeUnavailable(failure);
          return {
            status: "runtime-unavailable",
            detail: failure.message,
          };
        }
        try {
          sandboxBehaviorAttestationService ??=
            new SandboxBehaviorAttestationService({
              probe: createProductionSandboxBehaviorProbe({
                extensionRoot: context.extensionPath,
                nodeExecutable: runtime.executable,
              }),
            });
          const fingerprint = await createProductionSandboxRuntimeFingerprint({
            extensionRoot: context.extensionPath,
            extensionVersion: extVersion,
            nodeExecutable: runtime.executable,
          });
          const attestation =
            await sandboxBehaviorAttestationService.attest(fingerprint);
          if (!attestation.verified) {
            log(
              `[sandbox-terminal] Behavioral attestation failed closed: ${attestation.failureCode}`,
            );
            return { status: "failed", detail: attestation.failureCode };
          }
          return {
            status: "verified",
            attestation: {
              attestationId: attestation.summary.attestationId,
              attestationVersion: attestation.summary.attestationVersion,
              policyVersion: attestation.summary.metadata.policyVersion,
              profileId: attestation.summary.metadata.profileId,
              backend: "seatbelt",
              architecture: attestation.summary.metadata.architecture,
              capabilities: {
                backend: "seatbelt",
                processTree: true,
                filesystemRead: "host-visible",
                filesystemWrite: "strict",
                network: "loopback",
                privateHome: false,
                privateTmp: false,
                hostIpcBlocked: false,
                resourceLimits: "partial",
                warnings: [
                  "The host home directory is readable but not writable; the configured shell environment policy controls inherited variables.",
                  "Host temporary directories and POSIX IPC are available for development toolchain compatibility.",
                  "CPU, memory, process-count, and disk quotas are not fully enforced.",
                ],
              },
            },
          };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          log(
            `[sandbox-terminal] Behavioral attestation failed closed: ${detail}`,
          );
          return { status: "failed", detail };
        }
      },
    recordExecutionAudit: (event) =>
      log(`[terminal-security-audit] ${JSON.stringify(event)}`),
    createSandboxProvider: () => {
      if (!resolvedSandboxNodeRuntime) {
        throw new Error(
          "Sandbox Node runtime was not resolved before provider creation",
        );
      }
      const workspaceRoots = (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === "file")
        .map((folder) => folder.uri.fsPath);
      const runtime = new SandboxHelperClient(
        createNodeSandboxHelperTransportFactory({
          extensionRoot: context.extensionPath,
          nodeExecutable: resolvedSandboxNodeRuntime.executable,
        }),
      );
      try {
        const capabilityGrantTiming = resolveSandboxCapabilityGrantTiming(
          process.env.AGENTLINK_SANDBOX_CAPABILITY_GRANT_TIMING,
        );
        if (capabilityGrantTiming.invalidValue) {
          log(
            `[sandbox-capability-timing] Invalid AGENTLINK_SANDBOX_CAPABILITY_GRANT_TIMING; defaulting to launch`,
          );
        }
        log(
          `[sandbox-capability-timing] selected=${capabilityGrantTiming.timing}`,
        );
        const coordinator = new SandboxTerminalCoordinator({
          runtime,
          authorizer: new BaselineSandboxLaunchAuthorizer({
            workspaceRoots,
            environmentPolicy: vscode.workspace
              .getConfiguration("agentlink")
              .get<SandboxShellEnvironmentPolicy>(
                "terminal.environmentPolicy",
                {},
              ),
            trustedRuntimeRoots: [
              path.dirname(resolvedSandboxNodeRuntime.executable),
            ],
            capabilityGrantTiming: capabilityGrantTiming.timing,
            onCapabilityGrantTimingEvent: (event) =>
              log(`[sandbox-capability-timing] ${JSON.stringify(event)}`),
          }),
          initialCwd: workspaceCwd,
          createChannelId: randomUUID,
          createCommandId: randomUUID,
          log,
        });
        sandboxTerminalChannelHub.attach(coordinator);
        return coordinator;
      } catch (error) {
        runtime.dispose();
        throw error;
      }
    },
    log,
  });
  tabTerminalProviders = new TabTerminalProviderRegistry(agentTerminalProvider);
  context.subscriptions.push(
    agentTerminalProvider,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("agentlink.terminal.nodePath")) {
        resetSandboxNodeRuntime();
        agentTerminalProvider.refresh();
      } else if (
        event.affectsConfiguration("agentlink.terminal.enabled") ||
        event.affectsConfiguration("agentlink.terminal.environmentPolicy")
      ) {
        agentTerminalProvider.refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() =>
      agentTerminalProvider.refresh(),
    ),
    vscode.workspace.onDidGrantWorkspaceTrust(() =>
      agentTerminalProvider.refresh(),
    ),
  );
  const createCurrentProjectCatalog = () =>
    createWorkspaceProjectCatalog({
      workspaceFolders: vscode.workspace.workspaceFolders,
      canonicalizeFileRoot: (rootPath) => {
        try {
          return fs.realpathSync.native(rootPath);
        } catch {
          return undefined;
        }
      },
    });
  const projectCatalog = createCurrentProjectCatalog();
  const browserGatewayWorkspaceInstanceId =
    context.workspaceState.get<string>("browserGatewayInstanceId") ??
    randomUUID();
  void context.workspaceState.update(
    "browserGatewayInstanceId",
    browserGatewayWorkspaceInstanceId,
  );
  const getAutonomousMemoryMode = () =>
    vscode.workspace
      .getConfiguration("agentlink")
      .get<"off" | "autonomous">("memory.mode", "autonomous");
  let autonomousMemoryMigrationsPending = 0;
  let autonomousMemoryMigrationTail = Promise.resolve();
  const retrievalStoreRoot = getRetrievalStoreRoot(
    context.globalStorageUri.fsPath,
  );
  try {
    const result = await cleanupLegacyCodeRetrievalStore(retrievalStoreRoot);
    log(
      `[retrieval] Legacy code cleanup status=${result.status} rowsRemoved=${result.rowsRemoved}`,
    );
  } catch (error) {
    log(`[retrieval] Legacy code cleanup failed: ${String(error)}`);
    throw error;
  }
  void cleanupSupersededCodeIndexGenerations(
    context.globalStorageUri.fsPath,
    CODE_INDEX_STORAGE_GENERATION,
  )
    .then((result) => {
      if (result.removed.length > 0 || result.skippedActive.length > 0) {
        log(
          `[retrieval] Superseded code-index cleanup removed=[${result.removed.join(", ")}] ` +
            `skippedActive=[${result.skippedActive.join(", ")}]`,
        );
      }
    })
    .catch((error) => {
      log(`[retrieval] Superseded code-index cleanup failed: ${String(error)}`);
    });
  const autonomousMemoryToolProvider = new AutonomousMemoryToolProvider({
    root: retrievalStoreRoot,
    getMode: getAutonomousMemoryMode,
    isInitializing: () => autonomousMemoryMigrationsPending > 0,
  });
  const skillCatalogRetrievalRepository = new LanceDbRetrievalRepository({
    root: retrievalStoreRoot,
  });
  const skillCatalogFallbackProvider =
    new RetrievalSkillCatalogFallbackProvider(
      new SkillCatalogRetrievalService(skillCatalogRetrievalRepository),
      `vscode:${browserGatewayWorkspaceInstanceId}`,
    );
  context.subscriptions.push({
    dispose: () => {
      void autonomousMemoryToolProvider.dispose();
    },
  });
  context.subscriptions.push({
    dispose: () => {
      skillCatalogShutdownPromise ??= skillCatalogFallbackProvider
        .dispose()
        .finally(() => skillCatalogRetrievalRepository.close());
    },
  });
  const runLegacyMemoryMigration = (): Promise<void> => {
    if (getAutonomousMemoryMode() !== "autonomous") {
      return Promise.resolve();
    }
    autonomousMemoryMigrationsPending += 1;
    const run = autonomousMemoryMigrationTail.then(async () => {
      if (getAutonomousMemoryMode() !== "autonomous") return;
      try {
        const result = await migrateLegacyMemoryFiles({
          provider: autonomousMemoryToolProvider,
          projectCatalog: createCurrentProjectCatalog(),
        });
        log(
          `[memory] Legacy migration complete imported=${result.imported.length} missing=${result.skippedMissing.length}`,
        );
      } catch (error) {
        log(`[memory] Legacy migration failed: ${String(error)}`);
      }
    });
    const settled = run.finally(() => {
      autonomousMemoryMigrationsPending -= 1;
    });
    autonomousMemoryMigrationTail = settled.catch(() => undefined);
    return settled;
  };
  const initialLegacyMemoryMigration = runLegacyMemoryMigration();

  const legacyPrimaryRootPath = workspaceSessionLocation.legacyPrimaryRootPath;
  const canonicalLegacyPrimaryRootPath = legacyPrimaryRootPath
    ? (() => {
        try {
          return fs.realpathSync.native(legacyPrimaryRootPath);
        } catch {
          return undefined;
        }
      })()
    : undefined;
  const legacyProject = projectCatalog
    .listProjects()
    .find(
      (project) =>
        canonicalLegacyPrimaryRootPath !== undefined &&
        project.rootPath === canonicalLegacyPrimaryRootPath,
    );
  const legacyProjectScope = legacyProject
    ? createSessionProjectScope(legacyProject)
    : undefined;
  const workspaceCwd =
    workspaceSessionLocation.stateAnchor?.rootPath ??
    workspaceSessionLocation.legacyPrimaryRootPath ??
    workspaceSessionLocation.cwd;
  const sessionStore =
    workspaceSessionLocation.status === "ready" &&
    workspaceSessionLocation.stateAnchor
      ? new SessionStore(
          workspaceSessionLocation.stateAnchor.rootPath,
          undefined,
          undefined,
          {
            historyDirectory: workspaceSessionLocation.historyDirectory,
            legacyProjectScope,
            log,
          },
        )
      : undefined;
  if (workspaceSessionLocation.status === "legacy_conflict") {
    log(
      `[history] Multiple legacy history namespaces found for workspace ${workspaceSessionLocation.workspaceIdentity}; persistence disabled until explicit resolution.`,
    );
  } else if (workspaceSessionLocation.status === "unavailable") {
    log(
      `[history] No supported workspace state anchor is available; persistence and local execution will remain unavailable until a folder is opened.`,
    );
  }
  const browserPreferredProjectId = context.workspaceState.get<string>(
    "browserPreferredProjectId",
  );
  const startupProjectSelection = selectNewSessionProject(projectCatalog, {
    activeResourceUri: vscode.window.activeTextEditor?.document.uri.toString(),
    browserPreferredProjectId,
  });
  const startupAgentConfiguration =
    startupProjectSelection.status === "selected"
      ? vscode.workspace.getConfiguration(
          "agentlink",
          vscode.Uri.parse(startupProjectSelection.scope.workspaceFolderUri),
        )
      : agentConfiguration;
  const configuredMode =
    startupProjectSelection.status === "selected"
      ? startupAgentConfiguration.get<string>("defaultMode")?.trim() || "code"
      : "ask";
  const startupModel = resolveModelForMode(
    startupAgentConfiguration,
    configuredMode,
    FALLBACK_AGENT_MODEL,
  );
  let agentConfig: AgentConfig = {
    model: startupModel,
    maxTokens: agentConfiguration.get<number>("agentMaxTokens") ?? 8192,
    thinkingBudget: agentConfiguration.get<number>("thinkingBudget") ?? 10000,
    showThinking: agentConfiguration.get<boolean>("showThinking") ?? true,
    autoCondense: agentConfiguration.get<boolean>("autoCondense") ?? true,
    autoCondenseThreshold: getConfiguredBaseThresholdForModel(
      startupAgentConfiguration,
      startupModel,
    ),
    codexStatefulResponses:
      agentConfiguration.get<boolean>("codexStatefulResponses") ?? true,
    codexStoreResponses:
      agentConfiguration.get<boolean>("codexStoreResponses") ?? false,
    codexProMode: agentConfiguration.get<boolean>("codexProMode") ?? false,
    promptProfileOverrides: normalizePromptProfileOverrides(
      agentConfiguration.get<unknown>("modelPromptProfiles"),
    ),
    disabledSkillIds:
      agentConfiguration.get<string[]>("skills.disabledIds") ?? [],
  };

  // Dev builds (__DEV_BUILD__) expose the feedback tools and dev sidebar UI,
  // so they must also get the dev-mode system prompt — not just F5 sessions.
  const isDevMode =
    __DEV_BUILD__ || context.extensionMode === vscode.ExtensionMode.Development;
  const projectCustomizationRegistry = new ProjectCustomizationRegistry(
    undefined,
    (scope) =>
      vscode.workspace
        .getConfiguration(
          "agentlink",
          vscode.Uri.parse(scope.workspaceFolderUri),
        )
        .get<string[]>("skills.disabledIds", []),
  );
  chatTabController = new ChatTabController(context.workspaceState, { log });
  context.subscriptions.push(chatTabController);
  const chatTabControllerInitialization = chatTabController
    .initialize()
    .catch((error) => {
      log(`[chat-tabs] Failed to initialize tab layout: ${String(error)}`);
    });
  chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    context.globalState,
    projectCustomizationRegistry,
    extVersion,
  );
  chatViewProvider.setPendingInteractionAlertProvider((message, command) =>
    statusBarManager.showAlert(message, command),
  );
  chatViewProvider.setWorkspaceHistoryDiagnostic(() =>
    describeWorkspaceHistoryLocation(workspaceSessionLocation),
  );
  chatViewProvider.setChatTabController(chatTabController);
  chatTabPanelHost = new ChatTabPanelHost({
    extensionUri: context.extensionUri,
    tabs: chatTabController,
    hydrateEditor: (...args) => chatViewProvider.hydrateEditorPane(...args),
    hydrateSidebar: (...args) => chatViewProvider.hydrateSidebarPane(...args),
    onEditorMessage: (...args) =>
      chatViewProvider.handleEditorPaneMessage(...args),
    onLayoutChanged: () => chatViewProvider.refreshChatWorkspace(),
    log,
  });
  chatViewProvider.setChatTabPanelHost(chatTabPanelHost);
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(
      ChatTabPanelHost.viewType,
      chatTabPanelHost,
    ),
  );

  // Register providers after chatViewProvider is created so all auth logs
  // (including initial client construction) go to the agent output channel.
  const agentLog = (msg: string) => chatViewProvider.log(msg);
  const ANTHROPIC_MODEL_CATALOG_KEY = "anthropic.modelCatalog.v1";
  const dynamicModelCapabilitiesEnabled = vscode.workspace
    .getConfiguration("agentlink")
    .get<boolean>("anthropic.dynamicModelCapabilities", true);
  const anthropicProvider = new AnthropicProvider(undefined, agentLog, {
    dynamicCapabilitiesEnabled: dynamicModelCapabilitiesEnabled,
    modelCatalogPersistence: {
      load: () =>
        context.globalState.get<
          import("./core/model/providers/anthropic/anthropicModelCatalog.js").AnthropicModelCatalogSnapshot
        >(ANTHROPIC_MODEL_CATALOG_KEY),
      save: (snapshot) => {
        void context.globalState.update(ANTHROPIC_MODEL_CATALOG_KEY, snapshot);
      },
    },
  });
  providerRegistry.register(anthropicProvider);
  chatViewProvider.setAnthropicProvider(anthropicProvider);

  // Register the OpenAI/Codex provider with unified OAuth + API key auth.
  openAiCodexAuthManager.initialize(context);
  const codexProvider = new CodexProvider(openAiCodexAuthManager, agentLog);
  providerRegistry.register(codexProvider);
  const readDisabledProviderIds = (): string[] => {
    const raw = vscode.workspace
      .getConfiguration("agentlink")
      .get<unknown>("disabledProviders", []);
    return Array.isArray(raw)
      ? raw
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
  };
  providerRegistry.setDisabledProviders(readDisabledProviderIds());

  const openAiCompatibleConfiguration = vscode.workspace.getConfiguration(
    "agentlink.openaiCompatible",
  );
  const openAiCompatibleProviderManager = new OpenAiCompatibleProviderManager({
    registry: providerRegistry,
    builtInProviders: [anthropicProvider, codexProvider],
    configuration: {
      get: <T>(section: string, defaultValue: T): T =>
        openAiCompatibleConfiguration.inspect<T>(section)?.globalValue ??
        defaultValue,
    },
    secrets: context.secrets,
    log: agentLog,
  });
  const openAiCompatibleCredentials = new OpenAiCompatibleCredentialService({
    secrets: context.secrets,
    state: context.globalState,
    getConfiguredApiKeyNames: () =>
      openAiCompatibleProviderManager.listConfiguredAuthKeys(),
  });
  chatViewProvider.setOpenAiCompatibleAuthKeyResolver((providerId) =>
    openAiCompatibleProviderManager.getAuthKey(providerId),
  );
  const initialOpenAiCompatibleReconcile =
    openAiCompatibleProviderManager.reconcile();
  if (initialOpenAiCompatibleReconcile.issues.length > 0) {
    void vscode.window
      .showWarningMessage(
        `AgentLink kept the previous OpenAI-compatible model configuration because ${initialOpenAiCompatibleReconcile.issues.length} validation issue${initialOpenAiCompatibleReconcile.issues.length === 1 ? " was" : "s were"} found. See the AgentLink output for details.`,
        "Open Settings",
      )
      .then((choice) => {
        if (choice === "Open Settings") {
          void vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "agentlink.openaiCompatible.connections",
          );
        }
      });
  }

  const getConfiguredThresholdWithCapabilities = (model: string): number =>
    getConfiguredBaseThresholdForModel(
      startupAgentConfiguration,
      model,
      providerRegistry.tryResolveProvider(model)?.getCapabilities(model),
    );
  const startupModelResolution = providerRegistry.resolveAvailableModel(
    agentConfig.model,
  );
  const resolvedStartupModel =
    startupModelResolution?.model ??
    providerRegistry.resolveAvailableModel(FALLBACK_AGENT_MODEL)?.model ??
    providerRegistry.listAllModels()[0]?.id ??
    FALLBACK_AGENT_MODEL;
  if (startupModelResolution?.migratedFrom) {
    log(
      `[model] migrated retired startup model "${startupModelResolution.migratedFrom}" to "${resolvedStartupModel}"`,
    );
  }
  agentConfig = {
    ...agentConfig,
    model: resolvedStartupModel,
    autoCondenseThreshold:
      getConfiguredThresholdWithCapabilities(resolvedStartupModel),
  };

  let browserGatewayModelCatalogPublishedGenerationId: string | undefined;
  let browserGatewayModelCatalogPublicationTail = Promise.resolve();
  const performBrowserGatewayModelCatalogPublication =
    async (): Promise<boolean> => {
      const discovery = browserGatewayHelperDiscovery;
      const client = browserGatewayHelperModelAuthLeaseClient;
      if (!discovery?.helperGenerationId || !client) return false;
      try {
        const models = (await chatViewProvider.getBrowserModels()).map(
          (model): CoreModelCatalogEntry => ({
            id: model.id,
            displayName: model.displayName,
            providerId: model.provider,
            contextWindow: model.contextWindow,
            maxInputTokens: model.maxInputTokens,
            maxOutputTokens: model.maxOutputTokens,
            reasoningEfforts: model.reasoningEfforts,
            defaultReasoningEffort: model.defaultReasoningEffort,
            providerDisplayName: model.providerDisplayName,
            supportsToolUse: model.supportsToolUse,
            supportsImages: model.supportsImages,
            authenticated: model.authenticated,
            condenseThreshold: model.condenseThreshold,
          }),
        );
        const activeScope =
          agentSessionManager.getForegroundSession()?.projectScope ??
          agentSessionManager.getDefaultProjectScope();
        const profileConfiguration = vscode.workspace.getConfiguration(
          "agentlink",
          activeScope
            ? vscode.Uri.parse(activeScope.workspaceFolderUri)
            : undefined,
        );
        const promptProfileOverrides = normalizePromptProfileOverrides(
          profileConfiguration.get<unknown>("modelPromptProfiles"),
        );
        const promptProfileResolutions = Object.fromEntries(
          models.map((model) => [
            model.id,
            resolvePromptProfile({
              providerId: normalizeBrowserGatewayModelCredentialProviderId(
                model.providerId,
              ),
              modelId: model.id,
              overrides: promptProfileOverrides,
            }),
          ]),
        );
        const advertisedModelIdsByProvider = new Map<string, Set<string>>();
        for (const model of models) {
          const modelIds = advertisedModelIdsByProvider.get(model.providerId);
          if (modelIds) modelIds.add(model.id);
          else
            advertisedModelIdsByProvider.set(
              model.providerId,
              new Set([model.id]),
            );
        }
        const openAiCompatibleRuntimeProfiles = Object.fromEntries(
          Object.entries(
            openAiCompatibleProviderManager.getRuntimeProfiles(),
          ).flatMap(([providerId, profile]) => {
            const advertisedModelIds =
              advertisedModelIdsByProvider.get(providerId);
            if (!advertisedModelIds) return [];
            return [
              [
                providerId,
                {
                  ...profile,
                  models: Object.fromEntries(
                    Object.entries(profile.models).filter(([modelId]) =>
                      advertisedModelIds.has(modelId),
                    ),
                  ),
                },
              ],
            ];
          }),
        );
        const result = await client.publishModelCatalog({
          helperGenerationId: discovery.helperGenerationId,
          models,
          openAiCompatibleRuntimeProfiles,
          promptProfileResolutions,
        });
        const publishedToCurrentGeneration =
          browserGatewayHelperDiscovery?.helperGenerationId ===
          discovery.helperGenerationId;
        if (publishedToCurrentGeneration) {
          browserGatewayModelCatalogPublishedGenerationId =
            discovery.helperGenerationId;
        }
        log(
          `[browser-gateway-helper] published model catalog to helper modelCount=${result.modelCount}`,
        );
        return publishedToCurrentGeneration;
      } catch (err) {
        if (
          browserGatewayHelperDiscovery?.helperGenerationId ===
          discovery.helperGenerationId
        ) {
          browserGatewayModelCatalogPublishedGenerationId = undefined;
        }
        log(`[browser-gateway-helper] model catalog publish failed: ${err}`);
        return false;
      }
    };
  const publishBrowserGatewayModelCatalog = (): Promise<boolean> => {
    const publication = browserGatewayModelCatalogPublicationTail.then(() =>
      performBrowserGatewayModelCatalogPublication(),
    );
    browserGatewayModelCatalogPublicationTail = publication.then(
      () => undefined,
      () => undefined,
    );
    return publication;
  };

  const getPublishableBrowserGatewayModelCredentialProviderIds =
    (): string[] => [
      ...(providerRegistry.isProviderEnabled("codex") ? ["openai-codex"] : []),
      ...(providerRegistry.isProviderEnabled("anthropic") ? ["anthropic"] : []),
      ...openAiCompatibleProviderManager
        .listProviders()
        .filter(
          (provider) =>
            provider.authKey !== undefined &&
            providerRegistry.isProviderEnabled(provider.id),
        )
        .map((provider) => provider.id),
    ];

  const grantBrowserGatewayModelCredentials = async (): Promise<void> => {
    const discovery = browserGatewayHelperDiscovery;
    const client = browserGatewayHelperModelAuthLeaseClient;
    if (!discovery?.helperGenerationId || !client) return;
    for (const providerId of readDisabledProviderIds()) {
      const credentialProviderId =
        providerId === "codex" ? "openai-codex" : providerId;
      try {
        await client.clearCredential(credentialProviderId);
      } catch (err) {
        log(
          `[browser-gateway-helper] disabled ${credentialProviderId} credential clear failed: ${err}`,
        );
      }
    }
    for (const providerId of getPublishableBrowserGatewayModelCredentialProviderIds()) {
      try {
        const credential = await client.grantCredential({
          helperGenerationId: discovery.helperGenerationId,
          modelScopes: ["chat"],
          now: Date.now(),
          providerId,
        });
        if (credential) {
          log(
            `[browser-gateway-helper] granted cached ${credential.providerId} model credentials to helper`,
          );
          continue;
        }
        const removed = await client.clearCredential(providerId);
        if (removed) {
          log(
            `[browser-gateway-helper] cleared cached ${providerId} model credentials from helper`,
          );
        }
      } catch (err) {
        log(
          `[browser-gateway-helper] ${providerId} model credential grant failed: ${err}`,
        );
      }
    }
  };

  const applyDisabledProviders = async (): Promise<void> => {
    const disabledProviderIds = readDisabledProviderIds();
    providerRegistry.setDisabledProviders(disabledProviderIds);

    const foregroundModel = agentSessionManager?.getForegroundSession()?.model;
    if (
      foregroundModel &&
      !providerRegistry.resolveAvailableModel(foregroundModel)
    ) {
      const fallbackModel =
        providerRegistry.resolveAvailableModel(FALLBACK_AGENT_MODEL)?.model ??
        providerRegistry.listAllModels()[0]?.id;
      if (fallbackModel) {
        try {
          await agentSessionManager.setModel(fallbackModel);
          void vscode.window.showWarningMessage(
            `The provider for “${foregroundModel}” is disabled. AgentLink switched this session to “${fallbackModel}”.`,
          );
        } catch (error) {
          log(
            `[providers] could not move foreground session away from disabled model “${foregroundModel}”: ${error}`,
          );
        }
      }
    }

    chatViewProvider.refreshModels();
    await publishBrowserGatewayModelCatalog();
    await grantBrowserGatewayModelCredentials();
  };

  let openAiCompatibleRefreshInFlight:
    | Promise<ReturnType<OpenAiCompatibleProviderManager["reconcile"]>>
    | undefined;
  const refreshOpenAiCompatibleProviders = (): Promise<
    ReturnType<OpenAiCompatibleProviderManager["reconcile"]>
  > => {
    if (openAiCompatibleRefreshInFlight) {
      return openAiCompatibleRefreshInFlight;
    }
    const refresh = async () => {
      const previousProviders = openAiCompatibleProviderManager
        .listProviders()
        .map((provider) => provider.id);
      const result = openAiCompatibleProviderManager.reconcile();
      if (!result.applied) {
        void vscode.window
          .showWarningMessage(
            `AgentLink kept the previous OpenAI-compatible model configuration because ${result.issues.length} validation issue${result.issues.length === 1 ? " was" : "s were"} found. See the AgentLink output for details.`,
            "Open Settings",
          )
          .then((choice) => {
            if (choice === "Open Settings") {
              void vscode.commands.executeCommand(
                "workbench.action.openSettings",
                "agentlink.openaiCompatible.connections",
              );
            }
          });
        return result;
      }

      const foregroundModel =
        agentSessionManager?.getForegroundSession()?.model;
      if (
        foregroundModel &&
        !providerRegistry.resolveAvailableModel(foregroundModel)
      ) {
        try {
          const fallback =
            await agentSessionManager.setModel(FALLBACK_AGENT_MODEL);
          void vscode.window.showWarningMessage(
            `The selected model “${foregroundModel}” is no longer configured. AgentLink switched to “${fallback}”.`,
          );
        } catch (error) {
          log(
            `[openai-compatible] could not migrate unavailable foreground model “${foregroundModel}”: ${error}`,
          );
        }
      }

      const currentProviderIds = new Set(
        openAiCompatibleProviderManager
          .listProviders()
          .map((provider) => provider.id),
      );
      for (const removedProviderId of previousProviders.filter(
        (providerId) => !currentProviderIds.has(providerId),
      )) {
        await browserGatewayHelperModelAuthLeaseClient
          ?.clearCredential(removedProviderId)
          .catch((error) =>
            log(
              `[browser-gateway-helper] failed to clear removed ${removedProviderId} credentials: ${error}`,
            ),
          );
      }
      chatViewProvider.refreshModels();
      await publishBrowserGatewayModelCatalog();
      await grantBrowserGatewayModelCredentials();
      return result;
    };
    openAiCompatibleRefreshInFlight = refresh().finally(() => {
      openAiCompatibleRefreshInFlight = undefined;
    });
    return openAiCompatibleRefreshInFlight;
  };

  // Re-send model list to webview when OpenAI/Codex auth state changes.
  openAiCodexAuthManager.onAuthStateChanged = () => {
    chatViewProvider.refreshModels();
    void publishBrowserGatewayModelCatalog();
    void grantBrowserGatewayModelCredentials();
  };
  const bgMaxConcurrent = normalizeBackgroundMaxConcurrent(
    getConfig<number>("background.maxConcurrent"),
  );
  const terminalOwnerForTab = (tab: ChatTab, sessionId: string) => ({
    tabId: tab.id,
    tabLabel: `T${tab.displayNumber}`,
    sessionId,
    generation: tab.terminalGeneration,
  });
  context.subscriptions.push(
    chatTabController.onWillRetireTerminalGeneration(async (tab) => {
      if (tab.sessionId) {
        const subtreeIds = agentSessionManager.getSessionSubtreeIds(
          tab.sessionId,
        );
        for (const sessionId of subtreeIds) {
          toolCallTracker.cancelSessionCalls(sessionId);
        }
        const stoppedSessionIds = await agentSessionManager.stopSessionAndWait(
          tab.sessionId,
        );
        approvalManager.clearSessions(stoppedSessionIds);
        builtinApprovalPanel.clearRecentApprovalsForSessions(stoppedSessionIds);
      }
      tabTerminalProviders.retireOwner(
        terminalOwnerForTab(tab, tab.sessionId ?? "retired"),
      );
    }),
  );
  agentSessionManager = new AgentSessionManager(
    agentConfig,
    workspaceCwd,
    undefined,
    isDevMode,
    sessionStore,
    log,
    { maxConcurrent: bgMaxConcurrent },
    {
      projectCatalog,
      legacyProjectScope,
      historyDirectory: workspaceSessionLocation.historyDirectory,
      projectCustomizationRegistry,
      host: {
        workspaceMutationCoordinator: new WorkspaceMutationCoordinator(
          context.workspaceState,
        ),
      },
      projectMcpHubRegistry: chatViewProvider.getProjectMcpHubRegistry(),
      skillCatalogFallbackProvider,
      executionUnavailableReason:
        workspaceSessionLocation.status === "legacy_conflict"
          ? "Local execution is disabled because multiple legacy session-history locations were found. Resolve the history-storage conflict before starting or continuing a session."
          : undefined,
      browserPreferredProjectId,
      onBrowserPreferredProjectChanged: async (projectId) => {
        await context.workspaceState.update(
          "browserPreferredProjectId",
          projectId,
        );
      },
      terminalProviderForSession: (sessionId, rootSessionId) => {
        const tab = chatTabController.getTabForSession(rootSessionId);
        return tab
          ? tabTerminalProviders.forOwner(terminalOwnerForTab(tab, sessionId))
          : undefined;
      },
    },
  );
  let workspaceMigrationPromptInFlight = false;
  const offerWorkspaceHistoryMigration = async (
    source: WorkspaceHistoryShape & {
      historyDirectory: string;
      anchorRootPath: string;
    },
    destination: WorkspaceSessionLocation,
  ): Promise<void> => {
    if (
      workspaceMigrationPromptInFlight ||
      destination.status !== "ready" ||
      !destination.stateAnchor ||
      source.workspaceIdentity === destination.workspaceIdentity ||
      !isRealDirectory(source.historyDirectory) ||
      classifyWorkspaceHistoryTransition(
        workspaceHistoryShape(source),
        workspaceHistoryShape(destination),
      ) !== "source_subset_of_destination" ||
      hasIndependentPersistedHistory(destination, source.historyDirectory)
    ) {
      return;
    }
    const destinationAnchorRootPath = destination.stateAnchor.rootPath;
    const destinationShape = workspaceHistoryShape(destination);
    const transitionKey = `workspaceHistory.decision.${source.workspaceIdentity}.${destination.workspaceIdentity}`;
    if (context.globalState.get<boolean>(transitionKey, false)) return;

    workspaceMigrationPromptInFlight = true;
    try {
      const choice = await vscode.window.showWarningMessage(
        "AgentLink found history for a related workspace shape. Migrate it into an independent branch for this workspace?",
        { modal: true },
        "Migrate history",
        "Start new workspace",
        "Not now",
      );
      if (choice === "Not now" || !choice) return;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "AgentLink: Migrating workspace history",
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: "Waiting for session history to flush…" });
          const drained =
            await agentSessionManager.flushForWorkspaceTransition();
          if (!drained.ok) {
            void vscode.window.showWarningMessage(
              "AgentLink cannot change workspace history while sessions are active. Finish or stop those sessions, then reload the window to try again.",
            );
            return;
          }
          if (choice === "Start new workspace") {
            await context.globalState.update(transitionKey, true);
            progress.report({
              message: "Reloading with a new workspace history…",
            });
            await vscode.commands.executeCommand(
              "workbench.action.reloadWindow",
            );
            return;
          }
          await migrateWorkspaceHistory({
            source: workspaceHistoryShape(source),
            destination: destinationShape,
            sourceHistoryDirectory: source.historyDirectory,
            destinationAnchorRootPath,
            destinationLegacyHistoryDirectory:
              destination.historyStorageKind === "legacy"
                ? destination.historyDirectory
                : undefined,
            onProgress: (message) => progress.report({ message }),
          });
          await context.globalState.update(transitionKey, true);
          progress.report({ message: "Reloading with migrated history…" });
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        },
      );
    } catch (error) {
      log(`[history] Workspace migration failed: ${String(error)}`);
      void vscode.window.showErrorMessage(
        "AgentLink could not migrate workspace history. The original history was left unchanged; see the AgentLink output for details.",
      );
    } finally {
      workspaceMigrationPromptInFlight = false;
    }
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const destination = resolveWorkspaceSessionLocation({
        workspaceFolders: vscode.workspace.workspaceFolders,
        workspaceFile: vscode.workspace.workspaceFile,
        fallbackCwd: process.cwd(),
      });
      if (
        workspaceSessionLocation.status !== "ready" ||
        !workspaceSessionLocation.historyDirectory ||
        !workspaceSessionLocation.stateAnchor
      ) {
        return;
      }
      void offerWorkspaceHistoryMigration(
        {
          ...workspaceHistoryShape(workspaceSessionLocation),
          historyDirectory: workspaceSessionLocation.historyDirectory,
          anchorRootPath: workspaceSessionLocation.stateAnchor.rootPath,
        },
        destination,
      );
    }),
  );
  const startupMigrationCandidate = workspaceContinuityCatalog
    .findExpansionCandidates(workspaceHistoryShape(workspaceSessionLocation))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  if (startupMigrationCandidate) {
    void offerWorkspaceHistoryMigration(
      startupMigrationCandidate,
      workspaceSessionLocation,
    );
  }

  const syncForegroundChatTab = createForegroundChatTabSync({
    getForegroundSessionId: () =>
      agentSessionManager.getForegroundSession()?.id,
    bindFocusedSession: (sessionId) =>
      chatTabController.bindFocusedSession(sessionId),
  });
  let chatTabStartupRestoreSettled = false;
  context.subscriptions.push(
    agentSessionManager.onDidChangeSessions(() => {
      if (!chatTabStartupRestoreSettled) return;
      void syncForegroundChatTab().catch((error) => {
        log(`[chat-tabs] Failed to bind foreground session: ${String(error)}`);
      });
    }),
  );

  browserGatewayService = new BrowserGatewayService(
    chatViewProvider.getUiEventHub(),
    agentSessionManager,
    () => chatViewProvider.getBrowserGatewayThemeSnapshot(),
    (sessionId) =>
      chatViewProvider.getBrowserAgentWriteApprovalState(sessionId),
    () => chatViewProvider.getBrowserThinkingEnabledState(),
    () => chatViewProvider.getBrowserReasoningEffortState(),
    () => chatViewProvider.getBrowserProjectedForegroundState(),
    () => chatViewProvider.getBrowserMcpStatusInfos(),
  );
  browserGatewayService.setChatWorkspaceProvider(
    () =>
      createChatWorkspaceViewSnapshot(
        chatTabController.getWorkspaceSnapshot(),
        agentSessionManager.getSessionInfos(),
      ),
    (listener) => chatTabController.onDidChangeWorkspace(() => listener()),
  );
  const browserGatewayRepositoryObserver = new BrowserGatewayRepositoryObserver(
    {
      getProject: () => {
        const scope = agentSessionManager?.getForegroundSession()?.projectScope;
        return scope?.rootPath
          ? { projectId: scope.projectId, rootPath: scope.rootPath }
          : undefined;
      },
      getGitExtension: () =>
        vscode.extensions.getExtension("vscode.git") as never,
    },
  );
  browserGatewayService.setRepositoryInfoProvider(() =>
    browserGatewayRepositoryObserver.getRepositoryInfo(),
  );
  browserGatewayService.subscribeToRepositoryChanges((listener) =>
    browserGatewayRepositoryObserver.onDidChange(listener),
  );
  context.subscriptions.push(browserGatewayRepositoryObserver);
  void browserGatewayRepositoryObserver.initialize();
  wireBrowserGatewayApprovalPolicies(browserGatewayService, chatViewProvider);
  browserGatewayService.subscribeToProjectedForegroundChanges((listener) =>
    chatViewProvider.onDidChangeBrowserProjectedForeground(listener),
  );
  browserGatewayService.subscribeToSessionChanges((listener) =>
    agentSessionManager!.onDidChangeSessions(() => {
      browserGatewayRepositoryObserver.rebindProject();
      listener();
    }),
  );
  browserGatewayService.subscribeToSurfaceChanges((listener) =>
    chatViewProvider.onDidChangeBrowserGatewaySurface(listener),
  );
  context.subscriptions.push(
    browserGatewayService,
    approvalManager.onDidChange(() => {
      agentSessionManager?.refreshBackgroundApprovalInheritance();
      browserGatewayService?.invalidateBrowserSnapshot();
    }),
    vscode.window.onDidChangeActiveColorTheme(() => {
      browserGatewayService?.notifyOwnerProjectionSource("theme");
      browserGatewayService?.invalidateBrowserSnapshot({
        publishWithoutClients: true,
      });
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      const affectsCommandPolicy = event.affectsConfiguration(
        "agentlink.commandAutoApproveTier",
      );
      const affectsTerminalTheme = [
        "fontFamily",
        "fontSize",
        "lineHeight",
        "letterSpacing",
        "fontWeight",
      ].some((key) => event.affectsConfiguration(`terminal.integrated.${key}`));
      if (!affectsCommandPolicy && !affectsTerminalTheme) return;
      if (affectsCommandPolicy) {
        browserGatewayService?.notifyOwnerProjectionSource("policies");
      }
      if (affectsTerminalTheme) {
        browserGatewayService?.notifyOwnerProjectionSource("theme");
      }
      browserGatewayService?.invalidateBrowserSnapshot({
        publishWithoutClients: affectsTerminalTheme,
      });
    }),
  );
  // Keep the browser model list in parity after a dynamic capability refresh.
  chatViewProvider.setBrowserModelsChangedNotifier(() => {
    browserGatewayService?.bumpModelsVersion();
  });
  browserGatewayAuthToken = randomUUID();
  const browserGatewayWindowId = randomUUID();
  const browserGatewayInstanceId = `${browserGatewayWorkspaceInstanceId}:${browserGatewayWindowId}`;
  const browserGatewayDataPlaneConfiguration = vscode.workspace
    .getConfiguration("agentlink")
    .inspect<BrowserGatewayDataPlaneMode>("browserGateway.dataPlane");
  const configuredBrowserGatewayDataPlaneMode =
    browserGatewayDataPlaneConfiguration?.workspaceFolderValue ??
    browserGatewayDataPlaneConfiguration?.workspaceValue ??
    browserGatewayDataPlaneConfiguration?.globalValue;
  const browserGatewayDataPlaneMode = normalizeBrowserGatewayDataPlaneMode(
    configuredBrowserGatewayDataPlaneMode,
    BROWSER_GATEWAY_DATA_PLANE_DEFAULT,
  );
  const firstWorkspace = vscode.workspace.workspaceFolders?.[0];
  const browserWorkspaceName =
    firstWorkspace?.name ?? path.basename(workspaceCwd);
  const browserWorkspacePath = firstWorkspace?.uri.fsPath ?? workspaceCwd;
  setBrowserGatewayRegistryLogger(log);
  log(
    `[browser-gateway] activation identity instanceId=${browserGatewayInstanceId} workspaceSeed=${browserGatewayWorkspaceInstanceId} windowId=${browserGatewayWindowId} pid=${process.pid} workspace=${JSON.stringify(browserWorkspaceName)} path=${JSON.stringify(browserWorkspacePath)}`,
  );
  browserGatewayServer = new BrowserGatewayServer(
    browserGatewayService,
    chatViewProvider,
    browserGatewayAuthToken,
    browserGatewayInstanceId,
    browserWorkspaceName,
    browserWorkspacePath,
    log,
    undefined,
    () => browserGatewayHelperDiscovery?.clientSharedSecret ?? null,
    browserGatewayDataPlaneMode,
  );
  context.subscriptions.push(browserGatewayServer);
  const browserGatewayPort = getConfig<number>("browserGatewayPort") || 47137;
  const helperVersion =
    (context.extension.packageJSON as { version?: string })?.version ??
    "unknown";
  const helperClientId = browserGatewayInstanceId;
  const helperCoreOwnerGenerationId = randomUUID();
  const helperCoreOwner: BrowserGatewayCoreOwnerLeaseRegistration = {
    ownerId: browserGatewayInstanceId,
    ownerKind: "vscode",
    displayName: `VS Code — ${browserWorkspaceName}`,
    scope: {
      kind: "workspace",
      workspaceId: browserGatewayWorkspaceInstanceId,
      displayName: browserWorkspaceName,
      rootPathLabel: browserWorkspacePath,
    },
    ownerGenerationId: helperCoreOwnerGenerationId,
    memoryRuntime: {
      mode:
        autonomousMemoryMigrationsPending > 0
          ? "off"
          : getAutonomousMemoryMode(),
      retrievalStoreRoot: getRetrievalStoreRoot(
        context.globalStorageUri.fsPath,
      ),
    },
    capabilities: isBrowserGatewayOwnerPublicationEnabled(
      browserGatewayDataPlaneMode,
    )
      ? BROWSER_GATEWAY_PRODUCTION_OWNER_COMMAND_CAPABILITIES.map(
          (capabilityId) => ({ capabilityId, state: "enabled" as const }),
        )
      : [],
    instanceId: browserGatewayInstanceId,
    processId: process.pid,
  };

  const refreshMemoryRuntimeAfterMigration = (): void => {
    helperCoreOwner.memoryRuntime = {
      mode: "off",
      retrievalStoreRoot: getRetrievalStoreRoot(
        context.globalStorageUri.fsPath,
      ),
    };
    void browserGatewayHelperLeaseClient?.refresh();
    void runLegacyMemoryMigration().finally(() => {
      helperCoreOwner.memoryRuntime = {
        mode:
          autonomousMemoryMigrationsPending > 0
            ? "off"
            : getAutonomousMemoryMode(),
        retrievalStoreRoot: getRetrievalStoreRoot(
          context.globalStorageUri.fsPath,
        ),
      };
      void browserGatewayHelperLeaseClient?.refresh();
      void chatViewProvider.refreshContextHealth();
    });
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("agentlink.memory.mode")) return;
      if (getAutonomousMemoryMode() === "off") {
        helperCoreOwner.memoryRuntime = {
          mode: "off",
          retrievalStoreRoot: getRetrievalStoreRoot(
            context.globalStorageUri.fsPath,
          ),
        };
        void browserGatewayHelperLeaseClient?.refresh();
        void chatViewProvider.refreshContextHealth();
        return;
      }
      refreshMemoryRuntimeAfterMigration();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (getAutonomousMemoryMode() === "autonomous") {
        refreshMemoryRuntimeAfterMigration();
      }
    }),
  );

  let browserGatewayActivationDisposed = false;
  let browserGatewayHelperBootstrapPromise: Promise<string> | null = null;
  let browserGatewayBridgeStartPromise: Promise<number> | null = null;
  let browserGatewayRuntimeEnsurePromise: Promise<void> | null = null;
  let browserGatewayRestartInProgress = false;
  let browserGatewayHealthCheckTimer: NodeJS.Timeout | undefined;
  let browserGatewayOwnerRuntime: BrowserGatewayOwnerRuntime | null = null;
  let browserGatewayOwnerRuntimeGenerationId: string | null = null;
  context.subscriptions.push({
    dispose: () => {
      log(
        `[browser-gateway] disposing instanceId=${browserGatewayInstanceId} pid=${process.pid}`,
      );
      browserGatewayActivationDisposed = true;
      browserGatewayHelperBootstrapPromise = null;
      browserGatewayBridgeStartPromise = null;
      browserGatewayRuntimeEnsurePromise = null;
      browserGatewayRestartInProgress = false;
      const runtime = browserGatewayOwnerRuntime;
      browserGatewayOwnerRuntime = null;
      browserGatewayOwnerRuntimeGenerationId = null;
      const leaseClient = browserGatewayHelperLeaseClient;
      browserGatewayHelperLeaseClient = null;
      browserGatewayShutdownPromise = (async () => {
        await runtime?.close();
        await leaseClient?.stop();
      })().catch((error) => {
        log(`[browser-gateway] shutdown cleanup failed: ${String(error)}`);
      });
      if (browserGatewayHealthCheckTimer) {
        clearInterval(browserGatewayHealthCheckTimer);
        browserGatewayHealthCheckTimer = undefined;
      }
    },
  });

  const stopBrowserGatewayOwnerRuntime = async (): Promise<void> => {
    const runtime = browserGatewayOwnerRuntime;
    browserGatewayOwnerRuntime = null;
    browserGatewayOwnerRuntimeGenerationId = null;
    if (!runtime) return;
    await runtime.close();
  };

  const ensureBrowserGatewayOwnerRuntime = async (): Promise<void> => {
    if (!isBrowserGatewayOwnerPublicationEnabled(browserGatewayDataPlaneMode)) {
      await stopBrowserGatewayOwnerRuntime();
      return;
    }
    const discovery = browserGatewayHelperDiscovery;
    const service = browserGatewayService;
    if (!discovery?.helperGenerationId || !service) {
      throw new Error("browser_gateway_owner_runtime_helper_unavailable");
    }
    if (
      browserGatewayOwnerRuntime &&
      browserGatewayOwnerRuntimeGenerationId === discovery.helperGenerationId
    ) {
      return;
    }
    await stopBrowserGatewayOwnerRuntime();
    const runtime = new BrowserGatewayOwnerRuntime({
      helperUrl: discovery.url,
      clientSharedSecret: discovery.clientSharedSecret,
      helperGenerationId: discovery.helperGenerationId,
      owner: helperCoreOwner,
      sources: service.getOwnerProjectionSources(),
      executor: new ProductionBrowserGatewayOwnerCommandExecutor(
        chatViewProvider,
        browserGatewayInstanceId,
        (selection) => service.getSerializableSessionDetail(selection),
      ),
      commandCapabilities:
        BROWSER_GATEWAY_PRODUCTION_OWNER_COMMAND_CAPABILITIES,
      log,
    });
    await runtime.start();
    if (browserGatewayActivationDisposed) {
      await runtime.close();
      throw new Error("browser_gateway_activation_disposed");
    }
    if (
      browserGatewayHelperDiscovery?.helperGenerationId !==
      discovery.helperGenerationId
    ) {
      await runtime.close();
      throw new Error("browser_gateway_owner_runtime_helper_superseded");
    }
    browserGatewayOwnerRuntime = runtime;
    browserGatewayOwnerRuntimeGenerationId = discovery.helperGenerationId;
    log(
      `[browser-gateway-data-plane] owner active mode=${browserGatewayDataPlaneMode} helperGenerationId=${discovery.helperGenerationId}`,
    );
  };

  const formatBrowserGatewayHelperError = (err: unknown): string => {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "helper_start_timeout") {
      return "AgentLink browser gateway helper did not become ready in time.";
    }
    if (message.startsWith("helper_bundle_missing:")) {
      return "AgentLink browser gateway helper bundle is missing. Reinstall or rebuild the extension.";
    }
    if (message === "browser_gateway_activation_disposed") {
      return "AgentLink is shutting down; browser gateway helper startup was cancelled.";
    }
    return `AgentLink browser gateway helper failed to start: ${message}`;
  };

  const getDesiredBrowserGatewayHelperConfig = () => {
    const lanAccess = getConfig<boolean>("browserGatewayLanAccess") === true;
    return {
      lanAccess,
      mdnsName:
        getConfig<string>("browserGatewayMdnsName")?.trim() || "agentlink",
      secureLanAccess:
        lanAccess &&
        getConfig<boolean>("browserGatewaySecureLanAccess") === true,
      helperVersion,
    };
  };

  const isBrowserGatewayBridgeHealthy = async (
    url: string,
  ): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(`${url}/health`, {
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  const ensureBrowserGatewayBridgeReady = async (): Promise<number> => {
    if (browserGatewayBridgeStartPromise) {
      return await browserGatewayBridgeStartPromise;
    }

    browserGatewayBridgeStartPromise = (async () => {
      if (browserGatewayActivationDisposed) {
        throw new Error("browser_gateway_activation_disposed");
      }
      if (!browserGatewayServer) {
        throw new Error("browser_gateway_bridge_unavailable");
      }

      const existingUrl = browserGatewayServer.getUrl();
      if (existingUrl && (await isBrowserGatewayBridgeHealthy(existingUrl))) {
        return Number(new URL(existingUrl).port);
      }
      if (existingUrl) {
        log(
          `[browser-gateway] bridge health check failed for ${existingUrl}; restarting bridge`,
        );
        await browserGatewayServer.stop();
      }

      return await browserGatewayServer.start(0).catch((err) => {
        log(`[browser-gateway] failed to start: ${err}`);
        throw err;
      });
    })().finally(() => {
      browserGatewayBridgeStartPromise = null;
    });

    return await browserGatewayBridgeStartPromise;
  };

  const ensureBrowserGatewayHelperReady = async (): Promise<string> => {
    if (browserGatewayHelperBootstrapPromise) {
      return await browserGatewayHelperBootstrapPromise;
    }
    if (browserGatewayActivationDisposed) {
      throw new Error("browser_gateway_activation_disposed");
    }

    browserGatewayHelperBootstrapPromise = (async () => {
      const desired = getDesiredBrowserGatewayHelperConfig();
      const result = await bootstrapBrowserGatewayHelper({
        extensionRootPath: context.extensionUri.fsPath,
        browserGatewayPort,
        helperVersion,
        lanAccess: desired.lanAccess,
        mdnsName: desired.mdnsName,
        secureLanAccess: desired.secureLanAccess,
        log,
      });

      if (browserGatewayActivationDisposed) {
        throw new Error("browser_gateway_activation_disposed");
      }

      if (
        browserGatewayOwnerRuntimeGenerationId &&
        browserGatewayOwnerRuntimeGenerationId !==
          result.discovery.helperGenerationId
      ) {
        await stopBrowserGatewayOwnerRuntime();
      }
      browserGatewayHelperDiscovery = result.discovery;
      const discovered = result.discovery;
      const externalUrl =
        discovered.mdnsUrl ?? discovered.lanUrls?.[0] ?? discovered.url;
      log(
        `[browser-gateway-helper] ready (${result.source}) loopback=${discovered.url} external=${externalUrl} mdns=${discovered.mdnsUrl ?? "off"}`,
      );

      browserGatewayHelperLeaseClient?.dispose();
      browserGatewayHelperLeaseClient = new BrowserGatewayHelperLeaseClient({
        helperUrl: result.discovery.url,
        clientId: helperClientId,
        clientSharedSecret: result.discovery.clientSharedSecret,
        coreOwner: helperCoreOwner,
        log,
      });
      await browserGatewayHelperLeaseClient.start();

      if (browserGatewayHelperAdminClient) {
        browserGatewayHelperAdminClient.setHelperUrl(result.discovery.url);
        browserGatewayHelperAdminClient.setSharedSecret(
          result.discovery.clientSharedSecret,
        );
      } else {
        browserGatewayHelperAdminClient = new BrowserGatewayHelperAdminClient({
          helperUrl: result.discovery.url,
          clientSharedSecret: result.discovery.clientSharedSecret,
          log,
        });
      }
      chatViewProvider.setBrowserGatewayAdminClient(
        browserGatewayHelperAdminClient,
      );

      if (browserGatewayHelperModelAuthLeaseClient) {
        browserGatewayHelperModelAuthLeaseClient.setHelperUrl(
          result.discovery.url,
        );
        browserGatewayHelperModelAuthLeaseClient.setSharedSecret(
          result.discovery.clientSharedSecret,
        );
      } else {
        browserGatewayHelperModelAuthLeaseClient =
          new BrowserGatewayHelperModelAuthLeaseClient({
            helperUrl: result.discovery.url,
            clientSharedSecret: result.discovery.clientSharedSecret,
            grantedByOwnerId: helperCoreOwner.ownerId,
            getGrantedByOwnerId: () =>
              browserGatewayHelperLeaseClient?.getEffectiveOwnerId() ??
              helperCoreOwner.ownerId,
            grantedByOwnerGenerationId: helperCoreOwner.ownerGenerationId,
            resolveModelAuth: async (request) => {
              // Legacy lease callers omitted providerId when Codex was the only
              // browser-helper credential family. Preserve that default while
              // accepting the VS Code registry provider id (`codex`) as an alias.
              const providerId =
                normalizeBrowserGatewayModelCredentialProviderId(
                  request?.providerId ?? "openai-codex",
                );
              if (providerId === "openai-codex") {
                const auth = await openAiCodexAuthManager.resolveModelAuth();
                if (!auth) return null;
                return {
                  providerId: "openai-codex",
                  method: auth.method,
                  bearerToken: auth.bearerToken,
                  accountId: auth.accountId,
                  accountLabel:
                    auth.oauthAccountLabel ?? auth.oauthAccountEmail,
                  canRefresh: auth.canRefresh,
                };
              }
              if (providerId === "anthropic") {
                const auth = resolveAnthropicModelAuth();
                if (!auth) return null;
                return {
                  providerId: "anthropic",
                  method: auth.method,
                  bearerToken: auth.bearerToken,
                  accountLabel: auth.accountLabel,
                  canRefresh: auth.canRefresh,
                };
              }
              if (providerId.startsWith("openai-compatible:")) {
                const authKey =
                  openAiCompatibleProviderManager.getAuthKey(providerId);
                if (!authKey) return null;
                const bearerToken = await context.secrets.get(
                  getOpenAiCompatibleSecretKey(authKey),
                );
                if (!bearerToken) return null;
                return {
                  providerId,
                  method: "apiKey",
                  bearerToken,
                  accountLabel: authKey,
                  canRefresh: false,
                };
              }
              return null;
            },
            log,
          });
      }
      chatViewProvider.setBrowserGatewayModelAuthProvider(
        browserGatewayHelperModelAuthLeaseClient,
      );
      if (!(await publishBrowserGatewayModelCatalog())) {
        throw new Error("browser_gateway_model_catalog_publish_failed");
      }
      await grantBrowserGatewayModelCredentials();

      return result.discovery.url;
    })()
      .catch((err) => {
        if (!browserGatewayActivationDisposed) {
          browserGatewayHelperDiscovery = null;
          log(`[browser-gateway-helper] bootstrap failed: ${err}`);
        }
        throw err;
      })
      .finally(() => {
        browserGatewayHelperBootstrapPromise = null;
      });

    return await browserGatewayHelperBootstrapPromise;
  };

  const isCurrentBrowserGatewayHelperHealthy = async (): Promise<boolean> => {
    const current = browserGatewayHelperDiscovery;
    if (!current) return false;

    const healthy = await resolveHealthyDiscoveredHelper(
      browserGatewayPort,
      getDesiredBrowserGatewayHelperConfig(),
    );
    if (!healthy) return false;

    if (
      healthy.pid !== current.pid ||
      healthy.url !== current.url ||
      healthy.clientSharedSecret !== current.clientSharedSecret
    ) {
      return false;
    }

    return true;
  };

  const ensureBrowserGatewayRuntimeReady = async (): Promise<void> => {
    if (browserGatewayRuntimeEnsurePromise) {
      return await browserGatewayRuntimeEnsurePromise;
    }

    browserGatewayRuntimeEnsurePromise = (async () => {
      await ensureBrowserGatewayBridgeReady();
      if (!(await isCurrentBrowserGatewayHelperHealthy())) {
        await ensureBrowserGatewayHelperReady();
      }
      if (
        browserGatewayModelCatalogPublishedGenerationId !==
          browserGatewayHelperDiscovery?.helperGenerationId &&
        !(await publishBrowserGatewayModelCatalog())
      ) {
        throw new Error("browser_gateway_model_catalog_publish_failed");
      }
      await grantBrowserGatewayModelCredentials();
      await ensureBrowserGatewayOwnerRuntime();
    })().finally(() => {
      browserGatewayRuntimeEnsurePromise = null;
    });

    return await browserGatewayRuntimeEnsurePromise;
  };

  const waitForBrowserGatewayHelperShutdown = async (
    helperUrl: string,
    pid: number,
  ): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 250);
      try {
        const response = await fetch(`${helperUrl}/health`, {
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!response.ok) return;
      } catch {
        clearTimeout(timer);
        return;
      }

      try {
        process.kill(pid, 0);
      } catch {
        return;
      }

      await sleep(100);
    }

    throw new Error("helper_shutdown_timeout");
  };

  const forceRestartBrowserGateway = async (): Promise<void> => {
    const previousDiscovery =
      browserGatewayHelperDiscovery ??
      (await readBrowserGatewayHelperDiscovery().catch(() => null));
    log(
      `[browser-gateway] force restart requested previousPid=${previousDiscovery?.pid ?? "none"} previousUrl=${previousDiscovery?.url ?? "none"}`,
    );

    browserGatewayRestartInProgress = true;
    try {
      await stopBrowserGatewayOwnerRuntime();
      const previousLeaseClient = browserGatewayHelperLeaseClient;
      browserGatewayHelperLeaseClient = null;
      if (previousLeaseClient) {
        await previousLeaseClient.stop();
      }

      if (previousDiscovery) {
        const adminClient =
          browserGatewayHelperAdminClient ??
          new BrowserGatewayHelperAdminClient({
            helperUrl: previousDiscovery.url,
            clientSharedSecret: previousDiscovery.clientSharedSecret,
            log,
          });
        try {
          await adminClient.shutdown();
          await waitForBrowserGatewayHelperShutdown(
            previousDiscovery.url,
            previousDiscovery.pid,
          );
        } catch (err) {
          log(
            `[browser-gateway] helper admin shutdown failed; falling back to SIGTERM: ${String(err)}`,
          );
          try {
            process.kill(previousDiscovery.pid, "SIGTERM");
          } catch (killErr) {
            log(`[browser-gateway] helper SIGTERM failed: ${String(killErr)}`);
          }
          await waitForBrowserGatewayHelperShutdown(
            previousDiscovery.url,
            previousDiscovery.pid,
          );
        }
      }

      browserGatewayHelperDiscovery = null;

      if (browserGatewayServer?.getUrl()) {
        await browserGatewayServer.stop();
      }

      browserGatewayRuntimeEnsurePromise = null;
      browserGatewayHelperBootstrapPromise = null;
      browserGatewayBridgeStartPromise = null;

      await ensureBrowserGatewayRuntimeReady();
    } finally {
      browserGatewayRestartInProgress = false;
    }
  };

  browserGatewayHealthCheckTimer = setInterval(() => {
    if (
      browserGatewayRestartInProgress ||
      autonomousMemoryMigrationsPending > 0
    ) {
      return;
    }
    void ensureBrowserGatewayRuntimeReady().catch((err) => {
      if (!browserGatewayActivationDisposed) {
        log(`[browser-gateway] periodic health check failed: ${err}`);
      }
    });
  }, BROWSER_GATEWAY_HEALTH_CHECK_INTERVAL_MS);

  void initialLegacyMemoryMigration
    .finally(() => {
      helperCoreOwner.memoryRuntime = {
        mode:
          autonomousMemoryMigrationsPending > 0
            ? "off"
            : getAutonomousMemoryMode(),
        retrievalStoreRoot: getRetrievalStoreRoot(
          context.globalStorageUri.fsPath,
        ),
      };
      void chatViewProvider.refreshContextHealth();
      return ensureBrowserGatewayRuntimeReady();
    })
    .catch((err) => {
      if (!browserGatewayActivationDisposed) {
        log(`[browser-gateway] activation auto-start failed: ${err}`);
      }
    });

  // Initialize modes, slash commands, MCP hub, and file watchers
  const chatViewProviderInitialization = chatViewProvider
    .initialize(workspaceCwd)
    .catch((err) => {
      log(`[agent] ChatViewProvider.initialize failed: ${err}`);
    });

  // Dedicated approval panel for the built-in agent — routes rich approval cards
  // (CommandCard, WriteCard, etc.) inline into the chat webview instead of the
  // separate approval panel (which is reserved for external MCP agents like Claude Code).
  builtinApprovalPanel = new ApprovalPanelProvider(
    context.extensionUri,
    statusBarManager,
    resolveApprovalProjectContext,
  );
  context.subscriptions.push(builtinApprovalPanel);
  builtinApprovalPanel.onBeforeApproval = (forwarded) =>
    agentSessionManager.coordinateBackgroundApproval(forwarded);
  builtinApprovalPanel.onForwardApproval = (...args) =>
    chatViewProvider.forwardApproval(...args);
  builtinApprovalPanel.onForwardApprovalCancelled = (...args) =>
    chatViewProvider.cancelForwardedApproval(...args);
  // Enabling Approve for Me while a command approval card is open re-resolves
  // the card; the command flow detects the policy drift and the retried
  // command is reviewed automatically by the guardian under the new policy.
  chatViewProvider.setCommandApprovalRequeueHandler((sessionId) =>
    builtinApprovalPanel.requeueCommandApprovalsForPolicyChange(
      sessionId,
      "Approve for Me was enabled while this command was awaiting approval. Retry the command so it can be reviewed automatically under the new policy.",
    ),
  );

  const fleetAutomationLifecycle = createFleetAutomationLifecycle({
    store: new FleetAutomationStore(
      path.join(context.globalStorageUri.fsPath, "fleet-automations.json"),
      (workflow) => agentSessionManager.startFleetWorkflow(workflow),
    ),
    events: agentSessionManager,
    log,
  });
  context.subscriptions.push(fleetAutomationLifecycle);

  const resolveApprovalReviewerContext = (sessionId: string) => {
    const session = agentSessionManager.getSession(sessionId);
    if (!session || session.isAborted) return undefined;
    const provider = providerRegistry.tryResolveProvider(session.model);
    return provider ? { provider, sessionModel: session.model } : undefined;
  };
  const commandApprovalReviewer = createCommandApprovalReviewer({
    resolveContext: resolveApprovalReviewerContext,
  });
  const networkApprovalReviewer = createNetworkApprovalReviewer({
    resolveContext: resolveApprovalReviewerContext,
  });
  const actionApprovalReviewer = createActionApprovalReviewer({
    resolveContext: resolveApprovalReviewerContext,
  });

  agentSessionManager.setSessionOutcomeTelemetry(
    sessionOutcomeTelemetry ?? undefined,
  );

  // Wire up window-level capabilities. MCP is captured from the session project registry.
  agentSessionManager.setToolContext({
    approvalManager,
    approvalPanel: builtinApprovalPanel,
    sessionId: "agent", // synthetic session ID for the built-in agent
    extensionUri: context.extensionUri,
    globalStorageUri: context.globalStorageUri,
    getCommandApprovalPolicy: (sessionId) =>
      agentSessionManager.getCommandApprovalPolicy(
        sessionId,
        chatViewProvider.getConfiguredCommandApprovalPolicy(),
      ),
    getCommandApprovalMode: (sessionId) =>
      agentSessionManager.getSessionApprovalMode(
        sessionId,
        chatViewProvider.getConfiguredCommandApprovalPolicy(),
      ),
    inheritSessionApprovalState: (parentSessionId, childSessionId) =>
      approvalManager.inheritSessionState(parentSessionId, childSessionId),

    commandApprovalReviewer,
    networkApprovalReviewer,
    actionApprovalReviewer,
    isSessionActive: (sessionId) => {
      const session = agentSessionManager.getSession(sessionId);
      return Boolean(session && !session.isAborted);
    },
    getCommandReviewObjective: (sessionId) => {
      const messages = agentSessionManager
        .getSession(sessionId)
        ?.getAllMessages();
      if (!messages) return undefined;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message?.role === "user" && typeof message.content === "string") {
          return message.content;
        }
      }
      return undefined;
    },
    getCommandReviewContext: (sessionId) => {
      const messages = agentSessionManager
        .getSession(sessionId)
        ?.getAllMessages();
      return messages ? buildCommandReviewContext(messages) : [];
    },
    onModeSwitch: (sessionId, mode, reason, silent) =>
      chatViewProvider.handleModeSwitch(mode, reason, silent, sessionId),
    onApprovalRequest: (request, sessionId) =>
      chatViewProvider.requestApproval(request, sessionId),
    onQuestion: chatViewProvider.handleToolQuestion,
    onFileRead: (filePath) => {
      agentSessionManager.getForegroundSession()?.trackFileRead(filePath);
    },
    onSpawnBackground: (callerSessionId, request, skillAuthority) =>
      agentSessionManager.spawnBackground(
        request,
        callerSessionId,
        skillAuthority,
      ),
    onGetBackgroundStatus: (callerSessionId, sessionId) =>
      agentSessionManager.getAuthorizedBackgroundStatus(
        callerSessionId,
        sessionId,
      ),
    onGetBackgroundResult: (callerSessionId, sessionId) =>
      agentSessionManager.waitForAuthorizedBackgroundContent(
        callerSessionId,
        sessionId,
      ),
    onKillBackground: (callerSessionId, sessionId, reason) =>
      agentSessionManager.killAuthorizedBackground(
        callerSessionId,
        sessionId,
        reason,
      ),
    onSteerBackground: (callerSessionId, sessionId, message) =>
      agentSessionManager.steerAuthorizedBackground(
        callerSessionId,
        sessionId,
        message,
      ),
    onDetachBackground: (callerSessionId, sessionId) =>
      agentSessionManager.detachAuthorizedBackground(
        callerSessionId,
        sessionId,
      ),
    onStartFleetWorkflow: (callerSessionId, request, skillAuthority) =>
      agentSessionManager.startFleetWorkflow(
        request,
        callerSessionId,
        skillAuthority,
      ),
    onScheduleFleetAutomation: (input) =>
      fleetAutomationLifecycle.schedule(input),
    onCollectFleetWorkflow: (workflowId, kind) =>
      agentSessionManager.collectFleetWorkflow(workflowId, kind),
    onManageFleetAutomations: (input) => fleetAutomationLifecycle.manage(input),
    terminalProvider: undefined,
    worktreeAgentLaunchProvider: createVscodeWorktreeAgentLaunchProvider({
      globalStorageUri: context.globalStorageUri,
      onApprovalRequest: (request, sessionId) =>
        chatViewProvider.requestApproval(request, sessionId),
      sessionId: () =>
        agentSessionManager.getForegroundSession()?.id ?? "agent",
    }),
    toolCallTracker,
    memoryToolProvider: autonomousMemoryToolProvider,
    toolUsageTelemetry: toolUsageTelemetry ?? undefined,
  });

  chatViewProvider.setApprovalManager(approvalManager);
  chatViewProvider.setToolCallTracker(toolCallTracker);
  if (contextUsageTelemetry) {
    chatViewProvider.setContextUsageTelemetry(contextUsageTelemetry);
  }
  chatViewProvider.setSessionManager(agentSessionManager);
  sidebarProvider.setAgentWriteApprovalHandler((mode, sessionIds) =>
    chatViewProvider.setSidebarWriteApproval(mode, sessionIds),
  );

  const chatTabStartupRestore = chatTabControllerInitialization
    .then(() =>
      restoreChatTabStartup({
        getLayout: () => chatTabController.getLayout(),
        getFocusedTab: () => chatTabController.getFocusedTab(),
        getForegroundSession: () => agentSessionManager.getForegroundSession(),
        getSession: (sessionId) => agentSessionManager.getSession(sessionId),
        getTabForSession: (sessionId) =>
          chatTabController.getTabForSession(sessionId),
        hydratePersistedSession: (sessionId) =>
          agentSessionManager.hydratePersistedSession(sessionId),
        restoreLastSession: () => agentSessionManager.restoreLastSession(),
        restorePersistedBackgroundSessions: (rootSessionIds) =>
          agentSessionManager.restorePersistedBackgroundSessions(
            rootSessionIds,
          ),
        switchTo: (sessionId) => agentSessionManager.switchTo(sessionId),
        createTab: (sessionId) => chatTabController.createTab(sessionId),
        focusTab: (tabId) => chatTabController.focusTab(tabId),
        setPlacement: (tabId, expectedPlacement, placement) =>
          chatTabController.setPlacement(tabId, expectedPlacement, placement),
        replaceSession: (tabId, expectedSessionId, sessionId) =>
          chatTabController.replaceSession(tabId, expectedSessionId, sessionId),
      }),
    )
    .catch((error) => {
      log(`[chat-tabs] Failed to restore tab sessions: ${String(error)}`);
      throw error;
    })
    .finally(() => {
      chatTabStartupRestoreSettled = true;
      void syncForegroundChatTab().catch((error) => {
        log(`[chat-tabs] Failed to bind restored foreground: ${String(error)}`);
      });
    });
  chatViewProvider.setChatTabStartupRestore(chatTabStartupRestore);

  void Promise.all([chatTabStartupRestore, chatViewProviderInitialization])
    .then(async () => {
      chatTabPanelHost?.markRuntimeReady();
      await chatTabPanelHost?.restoreMissingPanels();
    })
    .catch((error) => {
      log(`[chat-tabs] Failed to restore tab panels: ${String(error)}`);
      chatTabPanelHost?.markRuntimeReady();
    });

  void consumeWorktreeStartupIntent(context, chatViewProvider, log);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
  void openDefaultAgentViewOnce({
    terminalViewId: AgentTerminalViewProvider.viewType,
    agentViewId: ChatViewProvider.viewType,
    workspaceState: context.workspaceState,
    waitForTerminalReady: () => hostTerminalCoordinator.whenIdle(),
    isTerminalAvailable: () => hostTerminalCoordinator.isAcceptingRequests,
    log,
  });

  // Update agent config when settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentlink.disabledProviders")) {
        void applyDisabledProviders();
      }
      if (e.affectsConfiguration("agentlink.openaiCompatible.connections")) {
        void refreshOpenAiCompatibleProviders();
      }
      if (
        e.affectsConfiguration("agentlink.modeModelPreferences") ||
        e.affectsConfiguration("agentlink.modeReasoningEffortPreferences") ||
        e.affectsConfiguration("agentlink.defaultMode") ||
        e.affectsConfiguration("agentlink.agentMaxTokens") ||
        e.affectsConfiguration("agentlink.thinkingBudget") ||
        e.affectsConfiguration("agentlink.showThinking") ||
        e.affectsConfiguration("agentlink.autoCondense") ||
        e.affectsConfiguration("agentlink.modelCondenseThresholds") ||
        e.affectsConfiguration("agentlink.codexStatefulResponses") ||
        e.affectsConfiguration("agentlink.codexStoreResponses") ||
        e.affectsConfiguration("agentlink.codexProMode") ||
        e.affectsConfiguration("agentlink.modelPromptProfiles") ||
        e.affectsConfiguration("agentlink.skills.disabledIds")
      ) {
        const activeScope =
          agentSessionManager.getForegroundSession()?.projectScope ??
          agentSessionManager.getDefaultProjectScope();
        const config = vscode.workspace.getConfiguration(
          "agentlink",
          activeScope
            ? vscode.Uri.parse(activeScope.workspaceFolderUri)
            : undefined,
        );
        const windowConfig = vscode.workspace.getConfiguration("agentlink");
        const fgMode = agentSessionManager.getForegroundSession()?.mode;
        const effectiveMode =
          fgMode ??
          (projectCatalog.listProjects().length === 0
            ? "ask"
            : (config.get<string>("defaultMode")?.trim() ?? "code"));
        const configuredModel = resolveModelForMode(
          config,
          effectiveMode,
          FALLBACK_AGENT_MODEL,
        );
        const model =
          providerRegistry.resolveAvailableModel(configuredModel)?.model ??
          configuredModel;
        agentSessionManager.updateConfig({
          model,
          maxTokens: config.get<number>("agentMaxTokens") ?? 8192,
          thinkingBudget: config.get<number>("thinkingBudget") ?? 10000,
          showThinking: windowConfig.get<boolean>("showThinking") ?? true,
          autoCondense: config.get<boolean>("autoCondense") ?? true,
          autoCondenseThreshold: getConfiguredBaseThresholdForModel(
            config,
            model,
            providerRegistry.tryResolveProvider(model)?.getCapabilities(model),
          ),
          codexStatefulResponses:
            config.get<boolean>("codexStatefulResponses") ?? true,
          codexStoreResponses:
            config.get<boolean>("codexStoreResponses") ?? false,
          codexProMode: config.get<boolean>("codexProMode") ?? false,
          promptProfileOverrides: normalizePromptProfileOverrides(
            config.get<unknown>("modelPromptProfiles"),
          ),
          disabledSkillIds: config.get<string[]>("skills.disabledIds") ?? [],
        });
        if (e.affectsConfiguration("agentlink.skills.disabledIds")) {
          const affectedProjectIds = getAffectedProjectSettingIds(
            e,
            "skills.disabledIds",
            projectCatalog.listProjects(),
          );
          for (const projectId of affectedProjectIds) {
            void chatViewProvider.refreshSkillConfiguration(projectId);
          }
        }
        if (e.affectsConfiguration("agentlink.modelPromptProfiles")) {
          const affectedProjectIds = getAffectedProjectSettingIds(
            e,
            "modelPromptProfiles",
            projectCatalog.listProjects(),
          );
          for (const projectId of affectedProjectIds) {
            void agentSessionManager.rebuildSystemPrompts(projectId);
          }
          void publishBrowserGatewayModelCatalog();
        }
      }
    }),
  );

  const codexAuthFlows = createCodexAuthFlows({
    authManager: openAiCodexAuthManager,
    queryUsage: queryCodexCliUsage,
    log,
  });

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("agentlink.showWorkspaceHistory", () => {
      chatViewProvider.showWorkspaceHistory();
    }),
    vscode.commands.registerCommand("agentlink.popChatTab", async () => {
      const tab = chatTabController.getFocusedTab();
      if (await chatTabPanelHost?.popOut(tab.id)) return;
      void vscode.window.showWarningMessage(
        "This chat tab could not be popped out. At least one chat tab must remain docked.",
      );
    }),
    vscode.commands.registerCommand("agentlink.dockChatTab", async () => {
      const poppedTabs = chatTabController
        .getLayout()
        .tabs.filter((tab) => tab.placement === "popped");
      if (poppedTabs.length === 0) {
        void vscode.window.showInformationMessage(
          "There are no popped-out AgentLink chat tabs.",
        );
        return;
      }
      const selected =
        poppedTabs.length === 1
          ? poppedTabs[0]
          : await vscode.window.showQuickPick(
              poppedTabs.map((tab) => ({
                label: `T${tab.displayNumber}`,
                description:
                  agentSessionManager.getSession(tab.sessionId ?? "")?.title ??
                  "New Chat",
                tabId: tab.id,
              })),
              { placeHolder: "Choose a chat tab to dock" },
            );
      if (!selected) return;
      const tabId = "tabId" in selected ? selected.tabId : selected.id;
      if (await chatTabPanelHost?.dock(tabId)) return;
      void vscode.window.showWarningMessage(
        "This chat tab could not be docked. Please try again.",
      );
    }),
    ...registerDiffViewCommands(),
    ...registerAgentActivityCommands({
      addTrustedCommand: () => addTrustedCommandViaUi(approvalManager),
      approvalPanel,
      pendingInteractionTarget: chatViewProvider,
      toolCallTracker,
      approvalManager,
    }),
    ...registerAgentWorkbenchLayout({
      terminalViewId: AgentTerminalViewProvider.viewType,
      agentViewId: ChatViewProvider.viewType,
      workspaceState: context.workspaceState,
      waitForTerminalReady: () => hostTerminalCoordinator.whenIdle(),
      isTerminalAvailable: () => hostTerminalCoordinator.isAcceptingRequests,
      log,
    }),
    ...registerBrowserGatewayCommands({
      ensureRuntimeReady: ensureBrowserGatewayRuntimeReady,
      forceRestart: forceRestartBrowserGateway,
      pairBrowserDevice: () => chatViewProvider.handlePairCommand(),
      managePairedDevices: () => chatViewProvider.showPairedDevicesList(),
      getDiscovery: () => browserGatewayHelperDiscovery,
      extensionVersion: helperVersion,
      formatError: formatBrowserGatewayHelperError,
      log,
    }),
    registerOpenAiCompatibleModelConfigurationWizard({
      credentials: openAiCompatibleCredentials,
      getGlobalConnections: () =>
        openAiCompatibleConfiguration.inspect<unknown>("connections")
          ?.globalValue ?? [],
      updateGlobalConnections: async (value) => {
        await openAiCompatibleConfiguration.update(
          "connections",
          value,
          vscode.ConfigurationTarget.Global,
        );
      },
      validateConnections: (raw) =>
        openAiCompatibleProviderManager.validateConnections(raw),
      getReservedModelIds: () =>
        providerRegistry
          .listProviders()
          .flatMap((provider) => [
            ...provider.listModels().map((model) => model.id),
            ...(provider.listRoutableModelIds?.() ?? []),
          ]),
      refreshProviders: refreshOpenAiCompatibleProviders,
      discoverModels: (options) =>
        discoverOpenAiCompatibleModels({
          ...options,
          fetch: agentLinkFetch,
        }),
      openSettings: async () => {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "agentlink.openaiCompatible.connections",
        );
      },
      log,
    }),
    ...registerOpenAiCompatibleAuthCommands({
      secrets: context.secrets,
      state: context.globalState,
      getConfiguredAuthKeys: () =>
        openAiCompatibleProviderManager.listConfiguredAuthKeys(),
      onCredentialChanged: async () => {
        chatViewProvider.refreshModels();
        await publishBrowserGatewayModelCatalog();
        await grantBrowserGatewayModelCredentials();
      },
    }),
    ...registerModelAuthCommands({
      openAiAuthManager: openAiCodexAuthManager,
      secrets: context.secrets,
      setAnthropicApiKey: setStoredAnthropicApiKey,
      refreshModels: () => chatViewProvider.refreshModels(),
      publishBrowserModelCatalog: async () => {
        await publishBrowserGatewayModelCatalog();
      },
      grantBrowserModelCredentials: grantBrowserGatewayModelCredentials,
    }),
    ...registerCodexAuthCommands({
      authManager: openAiCodexAuthManager,
      ...codexAuthFlows,
      log,
    }),
  );

  context.subscriptions.push(
    ...registerEditorContextCommands(chatViewProvider),
  );

  // --- Codebase indexer ---
  const semanticEnabled = vscode.workspace
    .getConfiguration("agentlink")
    .get<boolean>("semanticSearchEnabled", true);
  chatViewProvider.setContextHealthListener((health) =>
    sidebarProvider.updateContextHealth(health),
  );
  chatViewProvider.setContextHealthSources({
    memory: autonomousMemoryToolProvider,
    memoryInspection: autonomousMemoryToolProvider,
    retrieval: createCodeRetrievalHealthProvider({
      globalStoragePath: context.globalStorageUri.fsPath,
      enabled: semanticEnabled,
      getWorkspaceRoots: () =>
        (vscode.workspace.workspaceFolders ?? []).map(
          (folder) => folder.uri.fsPath,
        ),
    }),
    semanticIndexEnabled: semanticEnabled,
  });

  if (semanticEnabled) {
    indexerManager = new IndexerManager(
      context.extensionUri,
      context.globalStorageUri,
      log,
    );
    context.subscriptions.push(indexerManager);
    chatViewProvider.updateContextIndexHealth(indexerManager.getStatus(), true);

    // Forward index status to sidebar + status bar error
    indexerManager.onStatusChanged((status) => {
      sidebarProvider.updateIndexStatus(status);
      chatViewProvider.updateContextIndexHealth(status, true);
      if (status.state === "idle" || status.state === "error") {
        void chatViewProvider.refreshContextHealth();
      }
      if (status.state === "error" && status.error) {
        statusBarManager.setError(`Indexing: ${status.error}`);

        const dismissed = context.globalState.get<boolean>(
          SEMANTIC_SETUP_PROMPT_DISMISSED_KEY,
          false,
        );
        if (
          !dismissed &&
          status.readinessReason &&
          (status.readinessReason === "missing_embeddings_auth" ||
            status.readinessReason === "missing_index" ||
            status.readinessReason === "store_unavailable" ||
            status.readinessReason === "disabled")
        ) {
          void vscode.window
            .showInformationMessage(
              "Semantic search/indexing needs setup.",
              "Set Up Semantic Search",
              "Dismiss",
            )
            .then(async (choice) => {
              if (choice === "Set Up Semantic Search") {
                await vscode.commands.executeCommand(
                  "agentlink.setupSemanticSearch",
                  status.readinessReason,
                );
                return;
              }
              if (choice === "Dismiss") {
                await context.globalState.update(
                  SEMANTIC_SETUP_PROMPT_DISMISSED_KEY,
                  true,
                );
              }
            });
        }
      } else if (status.state !== "error") {
        statusBarManager.clearError();
      }
    });

    // Start file watching for incremental updates
    indexerManager.startWatching();
    if (
      vscode.workspace
        .getConfiguration("agentlink")
        .get<boolean>("autoIndex", true)
    ) {
      indexerManager.startIndexing();
    }

    context.subscriptions.push(...registerIndexCommands(() => indexerManager));
  }

  // Cleanup on deactivation
  context.subscriptions.push({
    dispose: () => {
      chatTabPanelHost?.dispose();
      chatTabPanelHost = null;
      agentSessionManager.saveAllSessions();
      void agentSessionManager.flushActivityTrace();
      agentSessionManager.disposeFleetVisibilityExpiry();
      disposeTerminalManager();
      void browserGatewayServer?.stop();
      browserGatewayServer = null;
      browserGatewayService = null;
      browserGatewayAuthToken = null;
      browserGatewayHelperDiscovery = null;
      diffSnapshotHub.dispose();
    },
  });
}

export async function deactivate(): Promise<void> {
  toolUsageTelemetry?.dispose();
  toolUsageTelemetry = null;
  await browserGatewayShutdownPromise;
  browserGatewayShutdownPromise = null;
  await skillCatalogShutdownPromise;
  skillCatalogShutdownPromise = null;
  contextUsageTelemetry?.dispose();
  contextUsageTelemetry = null;
  sessionOutcomeTelemetry?.dispose();
  sessionOutcomeTelemetry = null;
}
