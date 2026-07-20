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
import { AgentToolCallTracker } from "./agent/AgentToolCallTracker.js";
import { registerAgentActivityCommands } from "./agent/agentActivityCommands.js";
import {
  openDefaultAgentViewOnce,
  registerAgentWorkbenchLayout,
} from "./agent/workbenchLayout.js";
import { normalizeBackgroundMaxConcurrent } from "./agent/background/backgroundConcurrency.js";
import { addTrustedCommandViaUi } from "./agent/trustedCommandFlow.js";
import { registerCodexAuthCommands } from "./agent/codexAuthCommands.js";
import { createCodexAuthFlows } from "./agent/codexAuthFlows.js";
import { runLegacyAgentIntegrationCleanup } from "./util/legacyAgentIntegrationCleanup.js";

import {
  resolveAnthropicModelAuth,
  setStoredAnthropicApiKey,
} from "./agent/clientFactory.js";
import { IndexerManager } from "./indexer/IndexerManager.js";
import { registerIndexCommands } from "./indexer/indexCommands.js";
import { ChatViewProvider } from "./agent/ChatViewProvider.js";
import { AgentSessionManager } from "./agent/AgentSessionManager.js";
import { ProjectCustomizationRegistry } from "./agent/ProjectCustomizationRegistry.js";
import {
  getConfiguredBaseThresholdForModel,
  getMigratedModelCondenseThresholdMap,
} from "./agent/modelCondenseThresholds.js";
import {
  resolveModelForMode,
  FALLBACK_AGENT_MODEL,
} from "./agent/modeModelPreferences.js";
import { SessionStore } from "./agent/SessionStore.js";
import type { AgentConfig } from "./agent/types.js";
import { registerEditorContextCommands } from "./agent/editorContextCommands.js";
import { registerModelAuthCommands } from "./agent/modelAuthCommands.js";
import { AnthropicProvider } from "./agent/providers/anthropic/index.js";
import {
  providerRegistry,
  CodexProvider,
  openAiCodexAuthManager,
  queryCodexCliUsage,
} from "./agent/providers/index.js";
import { BrowserGatewayService } from "./browser-gateway/BrowserGatewayService.js";
import { BrowserGatewayRepositoryObserver } from "./browser-gateway/BrowserGatewayRepositoryObserver.js";
import { BrowserGatewayServer } from "./browser-gateway/BrowserGatewayServer.js";
import { registerBrowserGatewayCommands } from "./browser-gateway/browserGatewayCommands.js";
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
import { normalizeBrowserGatewayModelCredentialProviderId } from "./browser-gateway/browserGatewayModelProviderIds.js";
import { setBrowserGatewayRegistryLogger } from "./browser-gateway/browserGatewayRegistry.js";
import { WorktreeAgentIntentStore } from "./worktree/WorktreeAgentIntentStore.js";
import { WorktreeFleetExchangeStore } from "./worktree/WorktreeFleetExchangeStore.js";
import { createVscodeWorktreeAgentLaunchProvider } from "./adapters/vscode/worktreeAgentLaunchCapabilities.js";
import { FleetAutomationStore } from "./agent/FleetAutomationStore.js";
import { createFleetAutomationLifecycle } from "./agent/fleetAutomationLifecycle.js";
import { installAgentLinkHttpDispatcher } from "./util/httpDispatcher.js";
import { resolveWorkspaceSessionLocation } from "./agent/workspaceSessionIdentity.js";
import { createSessionProjectScope } from "./core/workspaceProjects.js";
import { createWorkspaceProjectCatalog } from "./adapters/vscode/workspaceProjectCapabilities.js";
import {
  createToolUsageTelemetry,
  type ToolUsageTelemetry,
} from "./telemetry/ToolUsageTelemetry.js";
import { createVscodeTerminalProvider } from "./adapters/vscode/terminalCapabilities.js";
import { AgentTerminalViewProvider } from "./terminal/AgentTerminalViewProvider.js";
import { createDeferredNodePtyLoader } from "./terminal/deferredNodePtyLoader.js";
import { LiveHostTerminalSurfaceController } from "./terminal/LiveHostTerminalSurfaceController.js";
import { Phase1HostTerminalCoordinator } from "./terminal/Phase1HostTerminalCoordinator.js";
import {
  AgentTerminalProviderRouter,
  type SandboxPreparationAvailability,
} from "./terminal/sandbox/AgentTerminalProviderRouter.js";
import { BaselineSandboxLaunchAuthorizer } from "./terminal/sandbox/BaselineSandboxLaunchAuthorizer.js";
import { SandboxHelperClient } from "./terminal/sandbox/SandboxHelperClient.js";
import { createNodeSandboxHelperTransportFactory } from "./terminal/sandbox/NodeSandboxHelperTransport.js";
import { SandboxTerminalChannelHub } from "./terminal/sandbox/SandboxTerminalChannelHub.js";
import { SandboxTerminalCoordinator } from "./terminal/sandbox/SandboxTerminalCoordinator.js";
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
let browserGatewayService: BrowserGatewayService | null = null;
let browserGatewayServer: BrowserGatewayServer | null = null;
let browserGatewayAuthToken: string | null = null;
let browserGatewayHelperDiscovery:
  | import("./browser-gateway/protocol.js").BrowserGatewayHelperDiscoveryRecord
  | null = null;
let toolUsageTelemetry: ToolUsageTelemetry | null = null;

let browserGatewayHelperLeaseClient: BrowserGatewayHelperLeaseClient | null =
  null;
let browserGatewayHelperAdminClient: BrowserGatewayHelperAdminClient | null =
  null;
let browserGatewayHelperModelAuthLeaseClient: BrowserGatewayHelperModelAuthLeaseClient | null =
  null;

const SEMANTIC_SETUP_PROMPT_DISMISSED_KEY =
  "semanticSetupPromptDismissedGlobally";

function log(message: string): void {
  const timestamp = new Date().toISOString();
  outputChannel.appendLine(`[${timestamp}] ${message}`);
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

function getExplicitAgentModel(
  config: vscode.WorkspaceConfiguration,
): string | undefined {
  const inspected = config.inspect<string>("agentModel");
  return (
    inspected?.workspaceFolderValue ??
    inspected?.workspaceValue ??
    inspected?.globalValue
  );
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

export function activate(context: vscode.ExtensionContext): void {
  installAgentLinkHttpDispatcher();

  outputChannel = vscode.window.createOutputChannel("AgentLink");
  context.subscriptions.push(outputChannel);

  let agentTerminalViewProvider: AgentTerminalViewProvider | undefined;
  const sandboxTerminalChannelHub = new SandboxTerminalChannelHub({
    onAgentCommandStarted: () => {
      if (agentTerminalViewProvider?.isVisible()) return;
      void vscode.commands
        .executeCommand(`${AgentTerminalViewProvider.viewType}.focus`)
        .then(undefined, (error) =>
          log(`Unable to reveal AgentLink Terminal: ${String(error)}`),
        );
    },
    onCallbackError: (error) =>
      log(`Unable to reveal AgentLink Terminal: ${String(error)}`),
  });
  let resolvedSandboxNodeRuntime: ResolvedSandboxNodeRuntime | undefined;
  let sandboxBehaviorAttestationService:
    | SandboxBehaviorAttestationService
    | undefined;
  let sandboxNodeRuntimePromise:
    | Promise<ResolvedSandboxNodeRuntime>
    | undefined;
  let agentTerminalProvider: AgentTerminalProviderRouter | undefined;
  let hostTerminalCoordinator!: Phase1HostTerminalCoordinator;
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
      `${error.message} AgentLink Terminal is disabled and agent commands will use VS Code's native terminal.`,
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
        if (
          event.affectsConfiguration("agentlink.terminal.enabled") ||
          event.affectsConfiguration("agentlink.terminal.nodePath")
        ) {
          resetSandboxNodeRuntime();
          listener();
        }
      }),
    createRuntime: async () => {
      await ensureSandboxNodeRuntime();
      const controller = new LiveHostTerminalSurfaceController({
        host: {
          platform: process.platform,
          remoteName: vscode.env.remoteName,
        },
        runtimeRoot: path.join(
          context.globalStorageUri.fsPath,
          "host-terminal-bootstrap",
        ),
        nodePtyLoader: createDeferredNodePtyLoader({
          extensionRoot: context.extensionPath,
        }),
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
        log,
      });
      const provider = new AgentTerminalViewProvider({
        controller,
        extensionUri: context.extensionUri,
        resolveCreateRequest: resolveVscodeTerminalCreateRequest,
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
              event.affectsConfiguration("editor.accessibilitySupport")
            ) {
              controller.updateConfiguration(
                readVscodeTerminalSurfaceConfiguration(),
              );
            }
          });
        return {
          dispose: () => {
            if (agentTerminalViewProvider === provider) {
              agentTerminalViewProvider = undefined;
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
        controller.dispose();
        provider.dispose();
        throw error;
      }
    },
    onRuntimeUnavailable: showSandboxRuntimeUnavailable,
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
  toolCallTracker = new AgentToolCallTracker(log);

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
    getSandboxAvailability:
      async (): Promise<SandboxPreparationAvailability> => {
        let runtime: ResolvedSandboxNodeRuntime;
        try {
          runtime = await ensureSandboxNodeRuntime();
        } catch (error) {
          log(
            `[sandbox-terminal] Using native terminal fallback before sandbox selection: ${error instanceof Error ? error.message : String(error)}`,
          );
          return {
            status: "runtime-unavailable",
            detail: error instanceof Error ? error.message : String(error),
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
                filesystemRead: "isolated",
                filesystemWrite: "strict",
                network: "blocked",
                privateHome: true,
                privateTmp: true,
                hostIpcBlocked: true,
                resourceLimits: "partial",
                warnings: [
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
        const coordinator = new SandboxTerminalCoordinator({
          runtime,
          authorizer: new BaselineSandboxLaunchAuthorizer({
            workspaceRoots,
            trustedRuntimeRoots: [
              path.dirname(resolvedSandboxNodeRuntime.executable),
            ],
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
  context.subscriptions.push(
    agentTerminalProvider,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("agentlink.terminal.enabled") ||
        event.affectsConfiguration("agentlink.terminal.nodePath")
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
  const projectCatalog = createWorkspaceProjectCatalog({
    workspaceFolders: vscode.workspace.workspaceFolders,
    canonicalizeFileRoot: (rootPath) => {
      try {
        return fs.realpathSync.native(rootPath);
      } catch {
        return undefined;
      }
    },
  });
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
            historyNamespace: workspaceSessionLocation.historyNamespace,
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
  const explicitAgentModel = getExplicitAgentModel(agentConfiguration);
  const configuredMode =
    agentConfiguration.get<string>("defaultMode")?.trim() || "code";
  const configuredModel =
    explicitAgentModel ??
    resolveModelForMode(
      agentConfiguration,
      configuredMode,
      FALLBACK_AGENT_MODEL,
    );
  const startupModel =
    explicitAgentModel ?? sessionStore?.list()[0]?.model ?? configuredModel;
  const migratedThresholds = getMigratedModelCondenseThresholdMap(
    agentConfiguration,
    startupModel,
  );
  let agentConfig: AgentConfig = {
    model: startupModel,
    maxTokens: agentConfiguration.get<number>("agentMaxTokens") ?? 8192,
    thinkingBudget: agentConfiguration.get<number>("thinkingBudget") ?? 10000,
    showThinking: agentConfiguration.get<boolean>("showThinking") ?? true,
    autoCondense: agentConfiguration.get<boolean>("autoCondense") ?? true,
    autoCondenseThreshold:
      migratedThresholds[startupModel] ??
      getConfiguredBaseThresholdForModel(agentConfiguration, startupModel),
    codexStatefulResponses:
      agentConfiguration.get<boolean>("codexStatefulResponses") ?? true,
    codexStoreResponses:
      agentConfiguration.get<boolean>("codexStoreResponses") ?? false,
    codexProMode: agentConfiguration.get<boolean>("codexProMode") ?? false,
  };

  // Dev builds (__DEV_BUILD__) expose the feedback tools and dev sidebar UI,
  // so they must also get the dev-mode system prompt — not just F5 sessions.
  const isDevMode =
    __DEV_BUILD__ || context.extensionMode === vscode.ExtensionMode.Development;
  const projectCustomizationRegistry = new ProjectCustomizationRegistry();
  chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    context.globalState,
    projectCustomizationRegistry,
    extVersion,
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
  providerRegistry.register(
    new CodexProvider(openAiCodexAuthManager, agentLog),
  );

  const getConfiguredThresholdWithCapabilities = (model: string): number =>
    getConfiguredBaseThresholdForModel(
      vscode.workspace.getConfiguration("agentlink"),
      model,
      providerRegistry.tryResolveProvider(model)?.getCapabilities(model),
    );
  const startupModelResolution = providerRegistry.resolveAvailableModel(
    agentConfig.model,
  );
  const resolvedStartupModel =
    startupModelResolution?.model ?? agentConfig.model;
  if (startupModelResolution?.migratedFrom) {
    log(
      `[model] migrated retired startup model "${startupModelResolution.migratedFrom}" to "${resolvedStartupModel}"`,
    );
  }
  agentConfig = {
    ...agentConfig,
    model: resolvedStartupModel,
    autoCondenseThreshold:
      migratedThresholds[resolvedStartupModel] ??
      getConfiguredThresholdWithCapabilities(resolvedStartupModel),
  };

  const publishBrowserGatewayModelCatalog = async (): Promise<void> => {
    const discovery = browserGatewayHelperDiscovery;
    const client = browserGatewayHelperModelAuthLeaseClient;
    if (!discovery?.helperGenerationId || !client) return;
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
          authenticated: model.authenticated,
          condenseThreshold: model.condenseThreshold,
        }),
      );
      const result = await client.publishModelCatalog({
        helperGenerationId: discovery.helperGenerationId,
        models,
      });
      log(
        `[browser-gateway-helper] published model catalog to helper modelCount=${result.modelCount}`,
      );
    } catch (err) {
      log(`[browser-gateway-helper] model catalog publish failed: ${err}`);
    }
  };

  const publishableBrowserGatewayModelCredentialProviderIds = [
    "openai-codex",
    "anthropic",
  ] as const;

  const grantBrowserGatewayModelCredentials = async (): Promise<void> => {
    const discovery = browserGatewayHelperDiscovery;
    const client = browserGatewayHelperModelAuthLeaseClient;
    if (!discovery?.helperGenerationId || !client) return;
    for (const providerId of publishableBrowserGatewayModelCredentialProviderIds) {
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

  // Re-send model list to webview when OpenAI/Codex auth state changes.
  openAiCodexAuthManager.onAuthStateChanged = () => {
    chatViewProvider.refreshModels();
    void publishBrowserGatewayModelCatalog();
    void grantBrowserGatewayModelCredentials();
  };
  const bgMaxConcurrent = normalizeBackgroundMaxConcurrent(
    getConfig<number>("background.maxConcurrent"),
  );
  const browserPreferredProjectId = context.workspaceState.get<string>(
    "browserPreferredProjectId",
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
      projectCustomizationRegistry,
      projectMcpHubRegistry: chatViewProvider.getProjectMcpHubRegistry(),
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
    },
  );
  browserGatewayService = new BrowserGatewayService(
    chatViewProvider.getUiEventHub(),
    agentSessionManager,
    () => chatViewProvider.getBrowserGatewayThemeSnapshot(),
    () => chatViewProvider.getBrowserAgentWriteApprovalState(),
    () => chatViewProvider.getBrowserThinkingEnabledState(),
    () => chatViewProvider.getBrowserReasoningEffortState(),
    () => chatViewProvider.getBrowserProjectedForegroundState(),
    () => chatViewProvider.getBrowserMcpStatusInfos(),
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
  browserGatewayService.setCommandApprovalPolicyGetters(
    () => chatViewProvider.getBrowserCommandApprovalPolicy(),
    () => chatViewProvider.getConfiguredCommandApprovalPolicy(),
  );
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
  const browserGatewayWorkspaceInstanceId =
    context.workspaceState.get<string>("browserGatewayInstanceId") ??
    randomUUID();
  void context.workspaceState.update(
    "browserGatewayInstanceId",
    browserGatewayWorkspaceInstanceId,
  );
  const browserGatewayWindowId = randomUUID();
  const browserGatewayInstanceId = `${browserGatewayWorkspaceInstanceId}:${browserGatewayWindowId}`;
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
    instanceId: browserGatewayInstanceId,
    processId: process.pid,
  };

  let browserGatewayActivationDisposed = false;
  let browserGatewayHelperBootstrapPromise: Promise<string> | null = null;
  let browserGatewayBridgeStartPromise: Promise<number> | null = null;
  let browserGatewayRuntimeEnsurePromise: Promise<void> | null = null;
  let browserGatewayRestartInProgress = false;
  let browserGatewayHealthCheckTimer: NodeJS.Timeout | undefined;
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
      browserGatewayHelperLeaseClient?.dispose();
      browserGatewayHelperLeaseClient = null;
      if (browserGatewayHealthCheckTimer) {
        clearInterval(browserGatewayHealthCheckTimer);
        browserGatewayHealthCheckTimer = undefined;
      }
    },
  });

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

  const getDesiredBrowserGatewayHelperConfig = () => ({
    lanAccess: getConfig<boolean>("browserGatewayLanAccess") === true,
    mdnsName:
      getConfig<string>("browserGatewayMdnsName")?.trim() || "agentlink",
  });

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
        log,
      });

      if (browserGatewayActivationDisposed) {
        throw new Error("browser_gateway_activation_disposed");
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
              return null;
            },
            log,
          });
      }
      chatViewProvider.setBrowserGatewayModelAuthProvider(
        browserGatewayHelperModelAuthLeaseClient,
      );
      void publishBrowserGatewayModelCatalog();
      void grantBrowserGatewayModelCredentials();

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
      await grantBrowserGatewayModelCredentials();
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
    if (browserGatewayRestartInProgress) return;
    void ensureBrowserGatewayRuntimeReady().catch((err) => {
      if (!browserGatewayActivationDisposed) {
        log(`[browser-gateway] periodic health check failed: ${err}`);
      }
    });
  }, BROWSER_GATEWAY_HEALTH_CHECK_INTERVAL_MS);

  void ensureBrowserGatewayRuntimeReady().catch((err) => {
    if (!browserGatewayActivationDisposed) {
      log(`[browser-gateway] activation auto-start failed: ${err}`);
    }
  });

  // Initialize modes, slash commands, MCP hub, and file watchers
  chatViewProvider.initialize(workspaceCwd).catch((err) => {
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
  builtinApprovalPanel.onForwardApproval = (req, respond) =>
    chatViewProvider.forwardApproval(req, respond);
  builtinApprovalPanel.onForwardApprovalIdle = () =>
    chatViewProvider.sendApprovalIdle();

  const fleetAutomationLifecycle = createFleetAutomationLifecycle({
    store: new FleetAutomationStore(
      path.join(context.globalStorageUri.fsPath, "fleet-automations.json"),
      (workflow) => agentSessionManager.startFleetWorkflow(workflow),
    ),
    events: agentSessionManager,
    log,
  });
  context.subscriptions.push(fleetAutomationLifecycle);

  const commandApprovalReviewer = createCommandApprovalReviewer({
    resolveContext: (sessionId) => {
      const session = agentSessionManager.getSession(sessionId);
      if (!session || session.isAborted) return undefined;
      const provider = providerRegistry.tryResolveProvider(session.model);
      return provider ? { provider, sessionModel: session.model } : undefined;
    },
  });

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
    inheritSessionApprovalState: (parentSessionId, childSessionId) =>
      approvalManager.inheritSessionApprovalState(
        parentSessionId,
        childSessionId,
      ),
    commandApprovalReviewer,
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
    onQuestion: (context, questions, sessionId, backgroundTask) =>
      chatViewProvider.requestQuestion(
        context,
        questions,
        sessionId,
        backgroundTask,
      ),
    onFileRead: (filePath) => {
      agentSessionManager.getForegroundSession()?.trackFileRead(filePath);
    },
    onSpawnBackground: (callerSessionId, request) =>
      agentSessionManager.spawnBackground(request, callerSessionId),
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
    onStartFleetWorkflow: (callerSessionId, request) =>
      agentSessionManager.startFleetWorkflow(request, callerSessionId),
    onScheduleFleetAutomation: (input) =>
      fleetAutomationLifecycle.schedule(input),
    onCollectFleetWorkflow: (workflowId, kind) =>
      agentSessionManager.collectFleetWorkflow(workflowId, kind),
    onManageFleetAutomations: (input) => fleetAutomationLifecycle.manage(input),
    terminalProvider: agentTerminalProvider,
    worktreeAgentLaunchProvider: createVscodeWorktreeAgentLaunchProvider({
      globalStorageUri: context.globalStorageUri,
      onApprovalRequest: (request, sessionId) =>
        chatViewProvider.requestApproval(request, sessionId),
      sessionId: () =>
        agentSessionManager.getForegroundSession()?.id ?? "agent",
    }),
    toolCallTracker,
    toolUsageTelemetry: toolUsageTelemetry ?? undefined,
  });

  chatViewProvider.setApprovalManager(approvalManager);
  chatViewProvider.setToolCallTracker(toolCallTracker);
  chatViewProvider.setSessionManager(agentSessionManager);

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
      if (
        e.affectsConfiguration("agentlink.agentModel") ||
        e.affectsConfiguration("agentlink.modeModelPreferences") ||
        e.affectsConfiguration("agentlink.modeReasoningEffortPreferences") ||
        e.affectsConfiguration("agentlink.defaultMode") ||
        e.affectsConfiguration("agentlink.agentMaxTokens") ||
        e.affectsConfiguration("agentlink.thinkingBudget") ||
        e.affectsConfiguration("agentlink.showThinking") ||
        e.affectsConfiguration("agentlink.autoCondense") ||
        e.affectsConfiguration("agentlink.autoCondenseThreshold") ||
        e.affectsConfiguration("agentlink.modelCondenseThresholds") ||
        e.affectsConfiguration("agentlink.codexStatefulResponses") ||
        e.affectsConfiguration("agentlink.codexStoreResponses") ||
        e.affectsConfiguration("agentlink.codexProMode")
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
          fgMode ?? config.get<string>("defaultMode")?.trim() ?? "code";
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
        });
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
    ...registerDiffViewCommands(),
    ...registerAgentActivityCommands({
      addTrustedCommand: () => addTrustedCommandViaUi(approvalManager),
      approvalPanel,
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
    ...registerModelAuthCommands({
      openAiAuthManager: openAiCodexAuthManager,
      secrets: context.secrets,
      setAnthropicApiKey: setStoredAnthropicApiKey,
      refreshModels: () => chatViewProvider.refreshModels(),
      publishBrowserModelCatalog: publishBrowserGatewayModelCatalog,
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
    .get<boolean>("semanticSearchEnabled", false);

  if (semanticEnabled) {
    indexerManager = new IndexerManager(
      context.extensionUri,
      context.globalStorageUri,
      log,
    );
    context.subscriptions.push(indexerManager);

    // Forward index status to sidebar + status bar error
    indexerManager.onStatusChanged((status) => {
      sidebarProvider.updateIndexStatus(status);
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
            status.readinessReason === "qdrant_unavailable" ||
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
      agentSessionManager.saveAllSessions();
      agentSessionManager.disposeFleetVisibilityExpiry();
      disposeTerminalManager();
      void browserGatewayServer?.stop();
      browserGatewayServer = null;
      browserGatewayService = null;
      browserGatewayAuthToken = null;
      browserGatewayHelperLeaseClient?.dispose();
      browserGatewayHelperLeaseClient = null;
      browserGatewayHelperDiscovery = null;
      diffSnapshotHub.dispose();
    },
  });
}

export function deactivate(): void {
  toolUsageTelemetry?.dispose();
  toolUsageTelemetry = null;
}
