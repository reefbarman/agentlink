import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

import { StatusBarManager } from "./util/StatusBarManager.js";
import { sleep } from "./util/sleep.js";
import {
  disposeTerminalManager,
  initializeTerminalManager,
} from "./integrations/TerminalManager.js";
import { registerDiffViewCommands } from "./integrations/diffViewCommands.js";
import { registerDiffViewContentProvider } from "./integrations/diffViewContentProvider.js";
import { SidebarProvider } from "./sidebar/SidebarProvider.js";
import {
  ApprovalManager,
  type CommandRule,
} from "./approvals/ApprovalManager.js";
import { ApprovalPanelProvider } from "./approvals/ApprovalPanelProvider.js";
import { ConfigStore } from "./approvals/ConfigStore.js";
import { AgentToolCallTracker } from "./agent/AgentToolCallTracker.js";
import { registerAgentActivityCommands } from "./agent/agentActivityCommands.js";
import { registerCodexAuthCommands } from "./agent/codexAuthCommands.js";
import { runLegacyAgentIntegrationCleanup } from "./util/legacyAgentIntegrationCleanup.js";

import {
  resolveAnthropicModelAuth,
  setStoredAnthropicApiKey,
} from "./agent/clientFactory.js";
import { IndexerManager } from "./indexer/IndexerManager.js";
import { ChatViewProvider } from "./agent/ChatViewProvider.js";
import { AgentSessionManager } from "./agent/AgentSessionManager.js";
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
import type {
  CodexRateLimitSnapshot,
  CodexSubscriptionUsage,
} from "./agent/providers/codex/CodexCliUsageClient.js";
import type { CodexCredentials } from "./agent/providers/codex/CodexOAuthManager.js";
import { CodexOAuthFlowError } from "./agent/providers/codex/CodexOAuthManager.js";
import { BrowserGatewayService } from "./browser-gateway/BrowserGatewayService.js";
import { BrowserGatewayServer } from "./browser-gateway/BrowserGatewayServer.js";
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
import { installAgentLinkHttpDispatcher } from "./util/httpDispatcher.js";
import { resolveWorkspaceSessionLocation } from "./agent/workspaceSessionIdentity.js";
import {
  createToolUsageTelemetry,
  type ToolUsageTelemetry,
} from "./telemetry/ToolUsageTelemetry.js";

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

/**
 * Preferred → fallback URL list for opening the browser gateway from VS Code.
 * Order: mDNS (works on LAN), direct LAN IP, loopback (this machine only).
 */
function collectGatewayUrls(
  discovery: import("./browser-gateway/protocol.js").BrowserGatewayHelperDiscoveryRecord,
): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  const push = (url: string | undefined) => {
    if (!url) return;
    if (seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };
  if (discovery.lanAccess) {
    push(discovery.mdnsUrl);
    for (const url of discovery.lanUrls ?? []) push(url);
  }
  push(discovery.url);
  return urls;
}
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

async function addTrustedCommandViaUI(): Promise<void> {
  const pattern = await vscode.window.showInputBox({
    title: "Built-In Agent Trusted Command Pattern",
    prompt: "Enter a command pattern to trust for built-in agent sessions",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? null : "Pattern cannot be empty"),
  });
  if (!pattern) return;

  const modes: Array<vscode.QuickPickItem & { mode: CommandRule["mode"] }> = [
    {
      label: "Prefix Match",
      description: `Trust commands starting with "${pattern.trim()}"`,
      mode: "prefix",
    },
    {
      label: "Exact Match",
      description: `Trust only "${pattern.trim()}"`,
      mode: "exact",
    },
    {
      label: "Regex Match",
      description: `Trust commands matching /${pattern.trim()}/`,
      mode: "regex",
    },
  ];

  const picked = await vscode.window.showQuickPick(modes, {
    title: "Match Mode",
    placeHolder: "How should this pattern match commands?",
    ignoreFocusOut: true,
  });
  if (!picked) return;

  // Scope selection
  const scopeItems: Array<
    vscode.QuickPickItem & { scope: "project" | "global" }
  > = [];
  const roots = vscode.workspace.workspaceFolders;
  if (roots && roots.length > 0) {
    scopeItems.push({
      label: "$(folder) This Project",
      description: ".agentlink/agentlink.json",
      scope: "project",
    });
  }
  scopeItems.push({
    label: "$(globe) Global",
    description: "~/.agentlink/agentlink.json",
    scope: "global",
  });

  const scopePick = await vscode.window.showQuickPick(scopeItems, {
    title: "Rule Scope",
    placeHolder: "Where should this rule be saved?",
    ignoreFocusOut: true,
  });
  if (!scopePick) return;

  approvalManager.addCommandRule(
    "_global",
    { pattern: pattern.trim(), mode: picked.mode },
    scopePick.scope,
  );
  vscode.window.showInformationMessage(
    `Added trusted command (${scopePick.scope}): ${picked.mode} "${pattern.trim()}"`,
  );
}

async function promptForCodexAccountLabel(
  defaultValue = "",
): Promise<string | undefined> {
  const label = await vscode.window.showInputBox({
    title: "Codex Account Label",
    prompt:
      "Optional: name this Codex OAuth account (email is used automatically when available).",
    value: defaultValue,
    ignoreFocusOut: true,
  });
  return label?.trim() || undefined;
}

async function completeCodexOAuthSignIn(options?: {
  replaceAccountId?: string;
  forceLabelPrompt?: boolean;
}): Promise<{
  accountLabel: string;
  accountEmail?: string;
  action: "added" | "updated" | "replaced";
  accountId: string;
} | null> {
  const authUrl = openAiCodexAuthManager.startAuthorizationFlow();
  await vscode.env.openExternal(vscode.Uri.parse(authUrl));
  log("[codex] Opened browser for OAuth sign-in");

  const creds: CodexCredentials =
    await openAiCodexAuthManager.waitForCallback();
  const label =
    options?.forceLabelPrompt || !creds.email
      ? await promptForCodexAccountLabel(creds.email ?? "")
      : undefined;

  const result = await openAiCodexAuthManager.saveOAuthCredentials(creds, {
    replaceAccountId: options?.replaceAccountId,
    label,
    makeActive: true,
  });

  return {
    accountLabel: result.account.label,
    accountEmail: result.account.email,
    action: result.action,
    accountId: result.account.id,
  };
}

async function pickOAuthAccount(
  title: string,
  placeHolder: string,
): Promise<
  | {
      id: string;
      label: string;
      email?: string;
      chatgptAccountId?: string;
      isActive: boolean;
    }
  | undefined
> {
  const accounts = await openAiCodexAuthManager.listOAuthAccounts();
  if (accounts.length === 0) {
    vscode.window.showInformationMessage(
      "No ChatGPT/Codex OAuth accounts are signed in.",
    );
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    accounts.map((a) => ({
      label: `${a.isActive ? "$(check) " : ""}${a.label}`,
      description: a.email ?? a.chatgptAccountId ?? a.id,
      detail: a.isActive ? "Active account" : undefined,
      account: a,
    })),
    {
      title,
      placeHolder,
      ignoreFocusOut: true,
    },
  );

  return picked?.account;
}

async function manageCodexAccountsFlow(): Promise<void> {
  const accounts = await openAiCodexAuthManager.listOAuthAccounts();
  if (accounts.length === 0) {
    vscode.window.showInformationMessage(
      "No ChatGPT/Codex OAuth accounts are signed in yet.",
    );
    return;
  }

  const account = await pickOAuthAccount(
    "Manage ChatGPT/Codex Accounts",
    "Select an account",
  );
  if (!account) return;

  const action = await vscode.window.showQuickPick(
    [
      { label: "View subscription usage", value: "usage" },
      { label: "Set active", value: "setActive" },
      { label: "Re-sign in / replace", value: "replace" },
      { label: "Rename label", value: "rename" },
      { label: "Remove account", value: "remove" },
    ],
    {
      title: `Manage account: ${account.label}`,
      ignoreFocusOut: true,
    },
  );

  if (!action) return;

  if (action.value === "usage") {
    await showCodexSubscriptionUsage();
    return;
  }

  if (action.value === "setActive") {
    await openAiCodexAuthManager.setActiveOAuthAccount(account.id);
    vscode.window.showInformationMessage(
      `Active Codex account set to ${account.label}.`,
    );
    return;
  }

  if (action.value === "replace") {
    try {
      const result = await completeCodexOAuthSignIn({
        replaceAccountId: account.id,
      });
      if (!result) return;
      vscode.window.showInformationMessage(
        `Updated ChatGPT/Codex account ${result.accountLabel}${
          result.accountEmail ? ` (${result.accountEmail})` : ""
        }.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[codex] Re-sign-in failed: ${message}`);
      if (err instanceof CodexOAuthFlowError && err.code === "timeout") {
        vscode.window.showWarningMessage(
          "OpenAI/Codex sign-in timed out. If the browser flow is still open, close it and try again.",
        );
      } else if (
        err instanceof CodexOAuthFlowError &&
        err.code === "port_in_use"
      ) {
        vscode.window.showErrorMessage(
          "OpenAI/Codex sign-in couldn't start because port 1455 is already in use. Close other Codex/Roo login flows and try again.",
        );
      } else {
        vscode.window.showErrorMessage(`Codex sign-in failed: ${message}`);
      }
    }
    return;
  }

  if (action.value === "rename") {
    const nextLabel = await promptForCodexAccountLabel(account.label);
    if (!nextLabel) return;
    await openAiCodexAuthManager.updateOAuthAccountLabel(account.id, nextLabel);
    vscode.window.showInformationMessage(
      `Updated account label to ${nextLabel}.`,
    );
    return;
  }

  if (action.value === "remove") {
    const confirm = await vscode.window.showWarningMessage(
      `Remove ChatGPT/Codex account ${account.label}?`,
      { modal: true },
      "Remove",
    );
    if (confirm !== "Remove") return;
    await openAiCodexAuthManager.removeOAuthAccount(account.id);
    vscode.window.showInformationMessage(`Removed account ${account.label}.`);
  }
}

function formatResetTime(timestamp: number | null): string {
  if (timestamp === null) return "reset time unavailable";
  return `resets ${new Date(timestamp * 1_000).toLocaleString()}`;
}

function rateLimitDetail(snapshot: CodexRateLimitSnapshot): string {
  const windows = [snapshot.primary, snapshot.secondary]
    .filter((window) => window !== null)
    .map(
      (window) =>
        `${Math.round(window.usedPercent)}% used · ${formatResetTime(window.resetsAt)}`,
    );
  return windows.length > 0 ? windows.join(" · ") : "No window data";
}

function usageQuickPickItems(usage: CodexSubscriptionUsage): Array<{
  label: string;
  description?: string;
  detail?: string;
}> {
  const buckets = usage.rateLimitsByLimitId
    ? Object.entries(usage.rateLimitsByLimitId)
    : [[usage.rateLimits.limitId ?? "codex", usage.rateLimits] as const];
  const items: Array<{
    label: string;
    description?: string;
    detail?: string;
  }> = buckets.map(([id, snapshot]) => ({
    label: `$(dashboard) ${snapshot.limitName ?? id}`,
    description: snapshot.planType ?? undefined,
    detail: rateLimitDetail(snapshot),
  }));

  const summary = usage.tokenUsage.summary;
  if (summary.lifetimeTokens !== null) {
    items.push({
      label: "$(symbol-numeric) Lifetime token activity",
      description: summary.lifetimeTokens.toLocaleString(),
      ...(summary.peakDailyTokens === null
        ? {}
        : {
            detail: `Peak daily activity: ${summary.peakDailyTokens.toLocaleString()} tokens`,
          }),
    });
  }
  if (usage.rateLimitResetCredits?.availableCount) {
    items.push({
      label: "$(refresh) Rate-limit resets available",
      description: String(usage.rateLimitResetCredits.availableCount),
    });
  }
  return items;
}

async function showCodexSubscriptionUsage(): Promise<void> {
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Reading Codex subscription usage…",
    },
    () => queryCodexCliUsage(),
  );

  if (!result.available) {
    log(`[codex] Subscription usage unavailable: ${result.reason}`);
    vscode.window.showInformationMessage(
      "Codex subscription usage is unavailable. Install and sign in to the Codex CLI to enable it.",
    );
    return;
  }

  await vscode.window.showQuickPick(usageQuickPickItems(result.usage), {
    title: "Codex Subscription Usage",
    placeHolder: "Usage is read from the locally installed Codex CLI",
    ignoreFocusOut: true,
  });
}

export function activate(context: vscode.ExtensionContext): void {
  installAgentLinkHttpDispatcher();

  outputChannel = vscode.window.createOutputChannel("AgentLink");
  context.subscriptions.push(outputChannel);

  initializeTerminalManager(context.extensionUri, log);

  // Load stored Anthropic API key into memory so createAnthropicClient can use it synchronously.
  void context.secrets.get("anthropicApiKey").then((key) => {
    setStoredAnthropicApiKey(key || undefined);
  });

  log("Activating AgentLink extension");

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

  // Approval panel (WebView-based approval UI for commands and path access)
  approvalPanel = new ApprovalPanelProvider(
    context.extensionUri,
    statusBarManager,
  );
  context.subscriptions.push(approvalPanel);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ApprovalPanelProvider.viewType,
      approvalPanel,
    ),
  );

  // Sidebar
  sidebarProvider = new SidebarProvider(context.extensionUri, log);
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
  const workspaceCwd = workspaceSessionLocation.cwd;
  const sessionStore = new SessionStore(workspaceCwd, undefined, undefined, {
    historyNamespace: workspaceSessionLocation.historyNamespace,
  });
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
    explicitAgentModel ?? sessionStore.list()[0]?.model ?? configuredModel;
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

  const isDevMode = context.extensionMode === vscode.ExtensionMode.Development;
  chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    context.globalState,
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
  agentConfig = {
    ...agentConfig,
    autoCondenseThreshold:
      migratedThresholds[startupModel] ??
      getConfiguredThresholdWithCapabilities(startupModel),
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
  agentSessionManager = new AgentSessionManager(
    agentConfig,
    workspaceCwd,
    undefined,
    isDevMode,
    sessionStore,
    log,
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
  context.subscriptions.push(browserGatewayService);
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
  );
  context.subscriptions.push(builtinApprovalPanel);
  builtinApprovalPanel.onForwardApproval = (req, respond) =>
    chatViewProvider.forwardApproval(req, respond);
  builtinApprovalPanel.onForwardApprovalIdle = () =>
    chatViewProvider.sendApprovalIdle();

  const fleetAutomationStore = new FleetAutomationStore(
    path.join(context.globalStorageUri.fsPath, "fleet-automations.json"),
    (workflow) => agentSessionManager.startFleetWorkflow(workflow),
  );
  const fleetAutomationReady = fleetAutomationStore.load();
  const removeFleetAutomationListener =
    agentSessionManager.addFleetEventListener((_sessionId, event) => {
      void fleetAutomationReady
        .then(() => fleetAutomationStore.trigger(event.type))
        .catch((error) =>
          log(`[fleet-automation] event trigger failed: ${String(error)}`),
        );
    });
  const fleetAutomationTimer = setInterval(() => {
    void fleetAutomationReady
      .then(() => fleetAutomationStore.runDue())
      .catch((error) =>
        log(`[fleet-automation] scheduled run failed: ${String(error)}`),
      );
  }, 30_000);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(fleetAutomationTimer);
      removeFleetAutomationListener();
    },
  });

  // Wire up tool dispatch context (mcpHub provided by ChatViewProvider after initialize)
  agentSessionManager.setToolContext({
    approvalManager,
    approvalPanel: builtinApprovalPanel,
    sessionId: "agent", // synthetic session ID for the built-in agent
    extensionUri: context.extensionUri,
    globalStorageUri: context.globalStorageUri,
    mcpHub: chatViewProvider.getMcpHub(),
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
      agentSessionManager.waitForAuthorizedBackground(
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
    onScheduleFleetAutomation: async (input) => {
      await fleetAutomationReady;
      return fleetAutomationStore.schedule(input);
    },
    onCollectFleetWorkflow: (workflowId, kind) =>
      agentSessionManager.collectFleetWorkflow(workflowId, kind),
    onManageFleetAutomations: async ({ action, id }) => {
      await fleetAutomationReady;
      if (action === "list") return fleetAutomationStore.list();
      if (action === "history") return fleetAutomationStore.history(id);
      if (!id) throw new Error(`${action} requires an automation id`);
      if (action === "enable") return fleetAutomationStore.setEnabled(id, true);
      if (action === "disable")
        return fleetAutomationStore.setEnabled(id, false);
      return { removed: await fleetAutomationStore.remove(id) };
    },
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

  // Update agent config when settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("agentlink.agentModel") ||
        e.affectsConfiguration("agentlink.modeModelPreferences") ||
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
        const config = vscode.workspace.getConfiguration("agentlink");
        const fgMode = agentSessionManager.getForegroundSession()?.mode;
        const effectiveMode =
          fgMode ?? config.get<string>("defaultMode")?.trim() ?? "code";
        const model = resolveModelForMode(
          config,
          effectiveMode,
          FALLBACK_AGENT_MODEL,
        );
        agentSessionManager.updateConfig({
          model,
          maxTokens: config.get<number>("agentMaxTokens") ?? 8192,
          thinkingBudget: config.get<number>("thinkingBudget") ?? 10000,
          showThinking: config.get<boolean>("showThinking") ?? true,
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

  // Commands
  context.subscriptions.push(
    ...registerDiffViewCommands(),
    ...registerAgentActivityCommands({
      addTrustedCommand: addTrustedCommandViaUI,
      approvalPanel,
      toolCallTracker,
      approvalManager,
    }),
    vscode.commands.registerCommand(
      "agentlink.restartBrowserGateway",
      async () => {
        try {
          await forceRestartBrowserGateway();
        } catch (err) {
          vscode.window.showErrorMessage(formatBrowserGatewayHelperError(err));
          return;
        }

        const discovery = browserGatewayHelperDiscovery;
        const message = discovery
          ? `AgentLink browser gateway restarted (helperVersion ${discovery.helperVersion}, extension ${helperVersion}). Refresh the browser tab to load the latest assets. If you are testing local workspace changes, reload/reinstall the extension first so the helper serves the rebuilt dist assets.`
          : "AgentLink browser gateway restarted. Refresh the browser tab to load the latest assets. If you are testing local workspace changes, reload/reinstall the extension first so the helper serves the rebuilt dist assets.";
        const action = await vscode.window.showInformationMessage(
          message,
          "Open Browser Gateway",
        );
        if (action === "Open Browser Gateway" && discovery) {
          const [url] = collectGatewayUrls(discovery);
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.openBrowserGateway",
      async () => {
        try {
          await ensureBrowserGatewayRuntimeReady();
        } catch (err) {
          vscode.window.showErrorMessage(formatBrowserGatewayHelperError(err));
          return;
        }
        const discovery = browserGatewayHelperDiscovery;
        if (!discovery) {
          vscode.window.showErrorMessage(
            "AgentLink browser gateway helper is not ready yet.",
          );
          return;
        }

        const urls = collectGatewayUrls(discovery);
        // When LAN access is off we only have loopback — open it directly.
        if (!discovery.lanAccess || urls.length <= 1) {
          await vscode.env.openExternal(vscode.Uri.parse(urls[0]));
          return;
        }

        type GatewayUrlPick = vscode.QuickPickItem & { url: string };
        const items: GatewayUrlPick[] = urls.map((url, index) => ({
          label: url,
          description:
            index === 0
              ? url.includes(".local")
                ? "mDNS — works on the same network"
                : "LAN IP"
              : url.startsWith("http://127.0.0.1")
                ? "loopback (this machine only)"
                : "LAN IP fallback",
          url,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          title: "Open Browser Gateway",
          placeHolder: "Pick the URL to open",
          ignoreFocusOut: true,
        });
        if (!picked) return;
        await vscode.env.openExternal(vscode.Uri.parse(picked.url));
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.showBrowserGatewayStatus",
      async () => {
        try {
          await ensureBrowserGatewayRuntimeReady();
        } catch (err) {
          vscode.window.showErrorMessage(formatBrowserGatewayHelperError(err));
          return;
        }
        const discovery = browserGatewayHelperDiscovery;
        if (!discovery) {
          vscode.window.showWarningMessage(
            "AgentLink browser gateway helper is not ready yet.",
          );
          return;
        }
        const lines = [
          `AgentLink browser gateway helper (pid ${discovery.pid}, helperVersion ${discovery.helperVersion})`,
          `Loopback: ${discovery.url}`,
          `LAN access: ${discovery.lanAccess ? "on" : "off"}`,
        ];
        if (discovery.mdnsUrl) {
          lines.push(`mDNS URL: ${discovery.mdnsUrl}`);
        } else if (discovery.lanAccess) {
          lines.push(
            `mDNS URL: (not advertised — check output log for mdns errors)`,
          );
        }
        if (discovery.lanUrls && discovery.lanUrls.length > 0) {
          lines.push(`LAN IP URLs: ${discovery.lanUrls.join(", ")}`);
        }
        const message = lines.join("\n");
        log(`[browser-gateway-helper] status requested:\n${message}`);
        const pick = await vscode.window.showInformationMessage(
          message,
          { modal: true },
          "Copy mDNS URL",
          "Copy loopback URL",
        );
        if (pick === "Copy mDNS URL" && discovery.mdnsUrl) {
          await vscode.env.clipboard.writeText(discovery.mdnsUrl);
        } else if (pick === "Copy loopback URL") {
          await vscode.env.clipboard.writeText(discovery.url);
        }
      },
    ),
    vscode.commands.registerCommand("agentlink.pairBrowserDevice", async () => {
      try {
        await ensureBrowserGatewayRuntimeReady();
      } catch (err) {
        vscode.window.showErrorMessage(formatBrowserGatewayHelperError(err));
        return;
      }
      await chatViewProvider.handlePairCommand();
    }),
    vscode.commands.registerCommand(
      "agentlink.managePairedDevices",
      async () => {
        try {
          await ensureBrowserGatewayRuntimeReady();
        } catch (err) {
          vscode.window.showErrorMessage(formatBrowserGatewayHelperError(err));
          return;
        }
        await chatViewProvider.showPairedDevicesList();
      },
    ),
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
      completeOAuthSignIn: completeCodexOAuthSignIn,
      pickOAuthAccount,
      manageAccounts: manageCodexAccountsFlow,
      showSubscriptionUsage: showCodexSubscriptionUsage,
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

    // Register index commands
    context.subscriptions.push(
      vscode.commands.registerCommand("agentlink.rebuildIndex", () =>
        indexerManager?.startIndexing(true),
      ),
      vscode.commands.registerCommand("agentlink.cancelIndex", () =>
        indexerManager?.cancelIndexing(),
      ),
      vscode.commands.registerCommand("agentlink.resumeIndex", () =>
        indexerManager?.startIndexing(false),
      ),
    );
  }

  // Cleanup on deactivation
  context.subscriptions.push({
    dispose: () => {
      agentSessionManager.saveAllSessions();
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
