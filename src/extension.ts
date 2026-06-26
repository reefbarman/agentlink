import * as vscode from "vscode";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

import { McpServerHost } from "./server/McpServerHost.js";
import { StatusBarManager } from "./util/StatusBarManager.js";
import {
  disposeTerminalManager,
  initializeTerminalManager,
} from "./integrations/TerminalManager.js";
import {
  resolveCurrentDiff,
  showDiffMoreOptions,
} from "./integrations/DiffViewProvider.js";
import { SidebarProvider } from "./sidebar/SidebarProvider.js";
import {
  ApprovalManager,
  type CommandRule,
} from "./approvals/ApprovalManager.js";
import { ApprovalPanelProvider } from "./approvals/ApprovalPanelProvider.js";
import { ConfigStore } from "./approvals/ConfigStore.js";
import { ToolCallTracker } from "./server/ToolCallTracker.js";
import { KNOWN_AGENTS, getAgentById } from "./agents/registry.js";
import { createConfigWriter } from "./agents/configWriters.js";
import { parseJsonWithComments } from "./util/jsonc.js";
import type { ConfigWriter } from "./agents/types.js";
import {
  setupInstructions,
  setupAllInstructions,
  installHooks,
} from "./setup.js";

import {
  resolveAnthropicModelAuth,
  setStoredAnthropicApiKey,
} from "./agent/clientFactory.js";
import { IndexerManager } from "./indexer/IndexerManager.js";
import type { SemanticReadinessReason } from "./shared/semanticReadiness.js";
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
import { AgentCodeActionProvider } from "./agent/AgentCodeActionProvider.js";
import { AnthropicProvider } from "./agent/providers/anthropic/index.js";
import {
  providerRegistry,
  CodexProvider,
  openAiCodexAuthManager,
} from "./agent/providers/index.js";
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
import { installAgentLinkHttpDispatcher } from "./util/httpDispatcher.js";
import { resolveWorkspaceSessionLocation } from "./agent/workspaceSessionIdentity.js";
import {
  createToolUsageTelemetry,
  type ToolUsageTelemetry,
} from "./telemetry/ToolUsageTelemetry.js";

export const DIFF_VIEW_URI_SCHEME = "agentlink-diff";
const BROWSER_GATEWAY_HEALTH_CHECK_INTERVAL_MS = 30_000;

let outputChannel: vscode.OutputChannel;
let httpServer: http.Server | null = null;
let mcpHost: McpServerHost | null = null;
let statusBarManager: StatusBarManager;
let sidebarProvider: SidebarProvider;
let approvalManager: ApprovalManager;
let approvalPanel: ApprovalPanelProvider;
let toolCallTracker: ToolCallTracker;
let builtinApprovalPanel: ApprovalPanelProvider;
let activePort: number | null = null;
let activeAuthToken: string | undefined;
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

function getOrCreateAuthToken(context: vscode.ExtensionContext): string {
  let token = context.globalState.get<string>("authToken");
  if (!token) {
    token = randomUUID();
    context.globalState.update("authToken", token);
    log("Generated new auth token");
  }
  return token;
}

function getSemanticSetupTitle(reason?: SemanticReadinessReason): string {
  switch (reason) {
    case "missing_embeddings_auth":
      return "Set up semantic search: OpenAI API key required";
    case "missing_index":
      return "Set up semantic search: build codebase index";
    case "qdrant_unavailable":
      return "Semantic search unavailable: Qdrant is not reachable";
    case "disabled":
      return "Semantic search is disabled";
    case "no_workspace":
      return "Semantic search requires an open workspace";
    default:
      return "Set up semantic search";
  }
}

function getSemanticSetupDetail(reason?: SemanticReadinessReason): string {
  switch (reason) {
    case "missing_embeddings_auth":
      return "Semantic indexing and search need embeddings auth. Configure an OpenAI API key for embeddings, or use API key mode for models + embeddings.";
    case "missing_index":
      return "Embeddings auth is configured, but this workspace has not been indexed yet.";
    case "qdrant_unavailable":
      return "Qdrant must be reachable at the configured URL before semantic indexing/search can run.";
    case "disabled":
      return "Enable agentlink.semanticSearchEnabled in settings to use semantic indexing and search.";
    case "no_workspace":
      return "Open a workspace folder to build and query a semantic codebase index.";
    default:
      return "Semantic search requires setup before it can run.";
  }
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
    await provider.startPromptInMode({
      prompt: intent.prompt,
      mode: intent.mode,
      autoSubmit: intent.autoSubmit,
    });
  } catch (err) {
    logFn(
      `[worktree-agent] failed to consume startup intent: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// --- Multi-agent config management ---
// Uses the agent abstraction layer to write/cleanup config for all configured agents.

let activeConfigWriters: ConfigWriter[] = [];

/** Read the port from the first workspace's .mcp.json, if it exists. */
function readPortFromMcpJson(): number | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  try {
    const mcpPath = path.join(folder.uri.fsPath, ".mcp.json");
    const raw = fs.readFileSync(mcpPath, "utf-8");
    const config = parseJsonWithComments<{
      mcpServers?: { agentlink?: { url?: string } };
    }>(raw);
    const url = config?.mcpServers?.agentlink?.url as string | undefined;
    if (!url) return undefined;
    const match = url.match(/:(\d+)\//);
    if (!match) return undefined;
    const port = parseInt(match[1], 10);
    if (port > 0 && port < 65536) {
      log(`Found previous port ${port} in .mcp.json`);
      return port;
    }
  } catch {
    // file doesn't exist or is malformed — ignore
  }
  return undefined;
}

function getConfiguredAgentIds(): string[] {
  return getConfig<string[]>("agents") ?? [];
}

function hasHookConfiguredAgent(agentIds: string[]): boolean {
  return agentIds.some((id) => getAgentById(id)?.supportsHooks);
}

function updateAllAgentConfigs(port: number, authToken?: string): boolean {
  const agentIds = getConfiguredAgentIds();
  activeConfigWriters = [];
  let anyConfigured = false;

  for (const id of agentIds) {
    const agent = getAgentById(id);
    if (!agent) {
      log(`Unknown agent ID in agentlink.agents: "${id}" — skipping`);
      continue;
    }
    const writer = createConfigWriter(agent, log);
    if (!writer) continue;

    if (writer.write(port, authToken)) {
      anyConfigured = true;
    }
    activeConfigWriters.push(writer);
  }

  return anyConfigured;
}

function cleanupAllAgentConfigs(): void {
  for (const writer of activeConfigWriters) {
    writer.cleanup();
  }
  activeConfigWriters = [];
}

function updateAgentConfigsForFolder(
  folderPath: string,
  port: number,
  authToken?: string,
): void {
  for (const writer of activeConfigWriters) {
    writer.writeForFolder?.(folderPath, port, authToken);
  }
}

function cleanupAgentConfigsForFolder(folderPath: string): void {
  for (const writer of activeConfigWriters) {
    writer.cleanupFolder?.(folderPath);
  }
}

function collectRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function startServer(context: vscode.ExtensionContext): Promise<void> {
  if (httpServer) {
    log("Server already running");
    return;
  }

  const port = getConfig<number>("port") || readPortFromMcpJson();
  const requireAuth = getConfig<boolean>("requireAuth");
  const authToken = requireAuth ? getOrCreateAuthToken(context) : undefined;

  mcpHost = new McpServerHost(
    authToken,
    approvalManager,
    approvalPanel,
    toolCallTracker,
    context.extensionUri,
    context.globalStorageUri,
  );

  // Notify sidebar + status bar when sessions change (connect/disconnect/trust)
  mcpHost.onSessionChanged = () => {
    const sessions = mcpHost?.getSessionInfos() ?? [];
    sidebarProvider?.updateState({
      sessions: sessions.length,
    });
    if (activePort !== null) {
      statusBarManager.setRunning(activePort, sessions);
    }
  };
  sidebarProvider?.setMcpSessionProvider(
    () => mcpHost?.getSessionInfos() ?? [],
  );

  httpServer = http.createServer(async (req, res) => {
    const url = req.url ?? "";

    if (url === "/mcp" || url.startsWith("/mcp?")) {
      // Buffer and parse the body — SDK expects parsedBody as 3rd arg to handleRequest
      let parsedBody: unknown;
      try {
        const body = await collectRequestBody(req);
        const text = body.toString();
        if (text.length > 0) {
          parsedBody = JSON.parse(text);
        }
      } catch {
        // GET/DELETE requests may have no body — that's fine
      }

      // Detect client disconnect so tool handlers can react
      let clientDisconnected = false;
      res.on("close", () => {
        if (!res.writableFinished) {
          clientDisconnected = true;
          log(
            `Client disconnected before response completed (${req.method} ${url})`,
          );
        }
      });

      try {
        if (!mcpHost) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Server is shutting down" }));
          return;
        }
        await mcpHost.handleRequest(req, res, parsedBody);
      } catch (err) {
        if (clientDisconnected) {
          log(`MCP request aborted (client disconnected): ${err}`);
        } else {
          log(`MCP request error: ${err}`);
        }
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
      return;
    }

    // Health check
    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ status: "ok", sessions: mcpHost?.sessionCount ?? 0 }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "not_found",
        error_description:
          "This server does not support OAuth. Authentication is managed via Bearer tokens configured automatically by the extension.",
      }),
    );
  });

  const onListening = (actualPort: number) => {
    activePort = actualPort;
    activeAuthToken = authToken;
    log(`MCP server listening on http://127.0.0.1:${actualPort}/mcp`);
    const configured = updateAllAgentConfigs(actualPort, authToken);
    updateStatusBar(actualPort, configured);

    // Auto-update instruction files + hooks if opted in
    const agentIds = getConfiguredAgentIds();
    if (getConfig<boolean>("autoUpdateInstructions")) {
      setupAllInstructions(context.extensionUri, agentIds, log, {
        silent: true,
      });
    }
    if (
      getConfig<boolean>("autoUpdateHooks") &&
      hasHookConfiguredAgent(agentIds)
    ) {
      installHooks(context.extensionUri, log, { silent: true });
    }
  };

  return new Promise<void>((resolve, reject) => {
    httpServer!.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        log(`Port ${port} in use, trying OS-assigned port...`);
        httpServer!.listen(0, "127.0.0.1", () => {
          const addr = httpServer!.address();
          const actualPort = typeof addr === "object" && addr ? addr.port : 0;
          onListening(actualPort);
          resolve();
        });
      } else {
        log(`Server error: ${err.message}`);
        reject(err);
      }
    });

    httpServer!.listen(port, "127.0.0.1", () => {
      const addr = httpServer!.address();
      const actualPort =
        typeof addr === "object" && addr ? addr.port : (port ?? 0);
      onListening(actualPort);
      resolve();
    });
  });
}

async function stopServer(): Promise<void> {
  cleanupAllAgentConfigs();
  activePort = null;
  activeAuthToken = undefined;

  if (mcpHost) {
    await mcpHost.close();
    mcpHost = null;
  }
  if (httpServer) {
    return new Promise<void>((resolve) => {
      httpServer!.close(() => {
        httpServer = null;
        log("MCP server stopped");
        updateStatusBar(null);
        resolve();
      });
    });
  }
}

function updateStatusBar(port: number | null, agentConfigured?: boolean): void {
  if (port !== null) {
    const sessions = mcpHost?.getSessionInfos() ?? [];
    statusBarManager.setRunning(port, sessions);
  } else {
    statusBarManager.setStopped();
  }

  // Update sidebar
  sidebarProvider?.updateState({
    serverRunning: port !== null,
    port,
    sessions: mcpHost?.sessionCount ?? 0,
    authEnabled: getConfig<boolean>("requireAuth"),
    agentConfigured: agentConfigured ?? false,
  });
}

async function addTrustedCommandViaUI(): Promise<void> {
  const pattern = await vscode.window.showInputBox({
    title: "Trusted Command Pattern",
    prompt: "Enter a command pattern to trust",
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

function showAgentPickerInSidebar(): void {
  const currentAgents = getConfiguredAgentIds();
  sidebarProvider?.updateState({
    ...sidebarProvider.getState(),
    onboardingStep: 1,
    knownAgents: KNOWN_AGENTS.map((a) => ({
      id: a.id,
      name: a.name,
      selected: currentAgents.includes(a.id),
    })),
  });
  // Reveal the sidebar so the user sees the picker
  vscode.commands.executeCommand("agentLink.statusView.focus");
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

  // Config store for disk-based approval rules
  const configStore = new ConfigStore();
  context.subscriptions.push({ dispose: () => configStore.dispose() });

  // Approval manager (must be created before server start)
  approvalManager = new ApprovalManager(context.globalState, configStore);
  approvalManager.migrateFromGlobalState().catch((err) => {
    log(`Migration warning: ${err}`);
  });

  // Register TextDocumentContentProvider for diff view (readonly left side)
  const diffContentProvider = new (class
    implements vscode.TextDocumentContentProvider
  {
    provideTextDocumentContent(uri: vscode.Uri): string {
      return Buffer.from(uri.query, "base64").toString("utf-8");
    }
  })();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      DIFF_VIEW_URI_SCHEME,
      diffContentProvider,
    ),
  );

  // Tool call tracker (wraps tool handlers for cancel/complete from sidebar)
  const extVersion =
    (context.extension.packageJSON as { version?: string })?.version ??
    "unknown";
  toolUsageTelemetry = createToolUsageTelemetry({
    extensionVersion: extVersion,
    log,
  });
  context.subscriptions.push(toolUsageTelemetry);
  toolCallTracker = new ToolCallTracker(log, extVersion, toolUsageTelemetry);

  // Status bar manager (unified status bar for port info + approval alerts)
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

      await new Promise((resolve) => setTimeout(resolve, 100));
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

  // Wire up tool dispatch context (mcpHub provided by ChatViewProvider after initialize)
  agentSessionManager.setToolContext({
    approvalManager,
    approvalPanel: builtinApprovalPanel,
    sessionId: "agent", // synthetic session ID for the built-in agent
    extensionUri: context.extensionUri,
    globalStorageUri: context.globalStorageUri,
    mcpHub: chatViewProvider.getMcpHub(),
    onModeSwitch: (mode, reason, silent) =>
      chatViewProvider.handleModeSwitch(mode, reason, silent),
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
    onSpawnBackground: (request) =>
      agentSessionManager.spawnBackground(request),
    onGetBackgroundStatus: (sessionId) =>
      agentSessionManager.getBackgroundStatus(sessionId),
    onGetBackgroundResult: (sessionId) =>
      agentSessionManager.waitForBackground(sessionId),
    onKillBackground: (sessionId, reason) =>
      agentSessionManager.killBackground(sessionId, reason),
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
        e.affectsConfiguration("agentlink.codexStoreResponses")
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
        });
      }
    }),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("agentlink.acceptDiff", () =>
      resolveCurrentDiff("accept"),
    ),
    vscode.commands.registerCommand("agentlink.acceptDiffMore", () =>
      showDiffMoreOptions(),
    ),
    vscode.commands.registerCommand("agentlink.rejectDiff", () =>
      resolveCurrentDiff("reject"),
    ),
    vscode.commands.registerCommand("agentlink.addTrustedCommand", () =>
      addTrustedCommandViaUI(),
    ),
    vscode.commands.registerCommand("agentLink.focusApproval", () =>
      approvalPanel.focusApproval(),
    ),
    vscode.commands.registerCommand("agentlink.cancelToolCall", (id: string) =>
      toolCallTracker.cancelCall(id, approvalPanel),
    ),
    vscode.commands.registerCommand(
      "agentlink.completeToolCall",
      (id: string) => toolCallTracker.completeCall(id, approvalPanel),
    ),
    vscode.commands.registerCommand("agentlink.clearSessionApprovals", () => {
      for (const s of approvalManager.getActiveSessions()) {
        approvalManager.clearSession(s.id);
      }
      approvalManager.resetWriteApproval();
      approvalManager.resetAgentWriteApproval();
      vscode.window.showInformationMessage("All session approvals cleared.");
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
    vscode.commands.registerCommand("agentlink.setOpenaiApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "OpenAI API Key (Embeddings)",
        prompt:
          "Enter your OpenAI API key for semantic search and indexing embeddings. This command stores an embeddings-only key and does not replace ChatGPT/Codex OAuth model auth.",
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? null : "API key cannot be empty"),
      });
      if (!key) return;
      await openAiCodexAuthManager.storeApiKey(key.trim(), "embeddings-only");
      vscode.window.showInformationMessage(
        "OpenAI API key stored securely for embeddings (semantic search/indexing).",
      );
    }),
    vscode.commands.registerCommand(
      "agentlink.setupSemanticSearch",
      async (reason?: SemanticReadinessReason) => {
        const action = await vscode.window.showQuickPick(
          [
            {
              label: "Set OpenAI API key for embeddings only",
              description:
                "Best when model chat already uses OAuth and only embeddings setup is missing",
              value: "embeddingsKey",
            },
            {
              label: "Set OpenAI API key for models + embeddings",
              description:
                "Use one API key for model chat and semantic search/indexing",
              value: "modelsAndEmbeddingsKey",
            },
            {
              label: "Sign in with ChatGPT/Codex (OAuth)",
              description:
                "Model-chat auth only. Embeddings still require an API key",
              value: "oauth",
            },
            {
              label: "Build/Rebuild codebase index",
              description:
                "Use after embeddings auth is configured for this workspace",
              value: "rebuild",
            },
            {
              label: "Open AgentLink settings",
              value: "settings",
            },
          ],
          {
            title: getSemanticSetupTitle(reason),
            placeHolder: getSemanticSetupDetail(reason),
            ignoreFocusOut: true,
          },
        );

        if (!action) return;

        if (action.value === "embeddingsKey") {
          await vscode.commands.executeCommand("agentlink.setOpenaiApiKey");
          const start = await vscode.window.showInformationMessage(
            "Embeddings key configured. Start indexing now?",
            "Index Codebase",
          );
          if (start === "Index Codebase") {
            await vscode.commands.executeCommand("agentlink.rebuildIndex");
          }
          return;
        }

        if (action.value === "modelsAndEmbeddingsKey") {
          const key = await vscode.window.showInputBox({
            title: "OpenAI API Key",
            prompt:
              "Enter your OpenAI API key for models and embeddings. OAuth remains preferred for model chat if also configured.",
            password: true,
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? null : "API key cannot be empty"),
          });
          if (!key) return;
          await openAiCodexAuthManager.storeApiKey(
            key.trim(),
            "models+embeddings",
          );
          vscode.window.showInformationMessage(
            "OpenAI API key stored securely for models and embeddings.",
          );
          const start = await vscode.window.showInformationMessage(
            "API key configured. Start indexing now?",
            "Index Codebase",
          );
          if (start === "Index Codebase") {
            await vscode.commands.executeCommand("agentlink.rebuildIndex");
          }
          return;
        }

        if (action.value === "oauth") {
          await vscode.commands.executeCommand("agentlink.codexSignIn");
          return;
        }

        if (action.value === "rebuild") {
          await vscode.commands.executeCommand("agentlink.rebuildIndex");
          return;
        }

        if (action.value === "settings") {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "agentlink",
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.setAnthropicApiKey",
      async () => {
        const key = await vscode.window.showInputBox({
          title: "Anthropic API Key",
          prompt:
            "Get your API key at https://platform.claude.com/settings/keys — or set ANTHROPIC_API_KEY as an environment variable instead",
          password: true,
          ignoreFocusOut: true,
          validateInput: (v) => (v.trim() ? null : "API key cannot be empty"),
        });
        if (!key) return;
        await context.secrets.store("anthropicApiKey", key.trim());
        setStoredAnthropicApiKey(key.trim());
        chatViewProvider.refreshModels();
        void publishBrowserGatewayModelCatalog();
        void grantBrowserGatewayModelCredentials();
        vscode.window.showInformationMessage(
          "Anthropic API key stored securely.",
        );
      },
    ),
    vscode.commands.registerCommand("agentlink.configureAgents", () =>
      showAgentPickerInSidebar(),
    ),
    vscode.commands.registerCommand("agentlink.resetOnboarding", () => {
      // Only show picker in current window — don't touch globalState
      showAgentPickerInSidebar();
    }),
    vscode.commands.registerCommand(
      "agentlink.applyAgentConfig",
      (opts?: { skipAutoUpdate?: boolean }) => {
        if (activePort !== null) {
          cleanupAllAgentConfigs();
          const configured = updateAllAgentConfigs(activePort, activeAuthToken);
          updateStatusBar(activePort, configured);

          if (!opts?.skipAutoUpdate) {
            const ids = getConfiguredAgentIds();
            if (getConfig<boolean>("autoUpdateInstructions")) {
              setupAllInstructions(context.extensionUri, ids, log, {
                silent: true,
              });
            }
            if (
              getConfig<boolean>("autoUpdateHooks") &&
              hasHookConfiguredAgent(ids)
            ) {
              installHooks(context.extensionUri, log, { silent: true });
            }
          }
        }
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.setupInstructions",
      (agentId?: string) => {
        if (agentId) {
          setupInstructions(context.extensionUri, agentId, log);
        } else {
          // Run for all configured agents
          for (const id of getConfiguredAgentIds()) {
            setupInstructions(context.extensionUri, id, log);
          }
        }
      },
    ),
    vscode.commands.registerCommand("agentlink.installHooks", () => {
      installHooks(context.extensionUri, log);
    }),
    vscode.commands.registerCommand(
      "agentlink.codexSignIn",
      async (preferredChoice?: "apiKeyOnly") => {
        const choice =
          preferredChoice === "apiKeyOnly"
            ? { value: "apiKey" }
            : await vscode.window.showQuickPick(
                [
                  {
                    label: "Sign in with ChatGPT/Codex",
                    description:
                      "Use your ChatGPT/Codex OAuth sessions for model chat",
                    value: "oauth",
                  },
                  {
                    label: "Use OpenAI API key",
                    description:
                      "Use an OpenAI API key for models and embeddings",
                    value: "apiKey",
                  },
                ],
                {
                  title: "OpenAI/Codex Authentication",
                  placeHolder:
                    "Choose model auth. Embeddings always use an API key. OAuth is preferred for model chat when both are configured.",
                  ignoreFocusOut: true,
                },
              );
        if (!choice) return;

        if (choice.value === "apiKey") {
          const key = await vscode.window.showInputBox({
            title: "OpenAI API Key",
            prompt:
              "Enter your OpenAI API key for models and embeddings. OAuth remains preferred for model chat if also configured.",
            password: true,
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? null : "API key cannot be empty"),
          });
          if (!key) return;
          await openAiCodexAuthManager.storeApiKey(
            key.trim(),
            "models+embeddings",
          );
          vscode.window.showInformationMessage(
            "OpenAI API key stored securely for models and embeddings.",
          );
          return;
        }

        try {
          const result = await completeCodexOAuthSignIn();
          if (!result) return;
          log(
            `[codex] Signed in as ${result.accountEmail ?? result.accountLabel}`,
          );
          vscode.window.showInformationMessage(
            `${
              result.action === "added"
                ? "Added"
                : result.action === "updated"
                  ? "Updated"
                  : "Replaced"
            } ChatGPT/Codex account ${result.accountLabel}${
              result.accountEmail ? ` (${result.accountEmail})` : ""
            }. OAuth is preferred for model chat and will round-robin on usage-limit 429s.`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`[codex] Sign-in failed: ${message}`);
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
      },
    ),
    vscode.commands.registerCommand("agentlink.codexAddAccount", async () => {
      try {
        const result = await completeCodexOAuthSignIn();
        if (!result) return;
        const actionLabel =
          result.action === "added"
            ? "Added"
            : result.action === "updated"
              ? "Updated"
              : "Replaced";
        vscode.window.showInformationMessage(
          `${actionLabel} ChatGPT/Codex account ${result.accountLabel}${
            result.accountEmail ? ` (${result.accountEmail})` : ""
          } and set it active.`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`[codex] Add-account sign-in failed: ${message}`);
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
          vscode.window.showErrorMessage(
            `Codex add-account failed: ${message}`,
          );
        }
      }
    }),
    vscode.commands.registerCommand(
      "agentlink.codexSwitchAccount",
      async () => {
        const account = await pickOAuthAccount(
          "Switch Active ChatGPT/Codex Account",
          "Select an account to make active",
        );
        if (!account) return;
        await openAiCodexAuthManager.setActiveOAuthAccount(account.id);
        vscode.window.showInformationMessage(
          `Active Codex account set to ${account.label}.`,
        );
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.codexReplaceAccount",
      async () => {
        const account = await pickOAuthAccount(
          "Replace ChatGPT/Codex Account",
          "Select an account to re-sign in / replace",
        );
        if (!account) return;
        try {
          const result = await completeCodexOAuthSignIn({
            replaceAccountId: account.id,
          });
          if (!result) return;
          vscode.window.showInformationMessage(
            `Replaced account ${result.accountLabel}${
              result.accountEmail ? ` (${result.accountEmail})` : ""
            } and set it active.`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`[codex] Replace-account sign-in failed: ${message}`);
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
            vscode.window.showErrorMessage(
              `Codex replace-account failed: ${message}`,
            );
          }
        }
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.codexManageAccounts",
      async () => {
        await manageCodexAccountsFlow();
      },
    ),
    vscode.commands.registerCommand("agentlink.codexSignOut", async () => {
      const hasOAuth = await openAiCodexAuthManager.hasOAuth();
      const hasApiKey = await openAiCodexAuthManager.hasApiKey();

      if (hasOAuth && hasApiKey) {
        const choice = await vscode.window.showQuickPick(
          [
            {
              label: "Remove one ChatGPT/Codex account",
              description: "Keeps other signed-in OAuth accounts",
              value: "removeOneOAuth",
            },
            {
              label: "Remove all ChatGPT/Codex accounts",
              description: "Clears all OAuth sessions",
              value: "oauth",
            },
            {
              label: "Remove OpenAI API key",
              description: "Keeps ChatGPT/Codex OAuth if present",
              value: "apiKey",
            },
            {
              label: "Remove both",
              description: "Clears OAuth accounts and API key",
              value: "both",
            },
          ],
          {
            title: "Manage OpenAI/Codex Authentication",
            placeHolder:
              "Choose which auth method to remove. OAuth is preferred when both are present.",
            ignoreFocusOut: true,
          },
        );
        if (!choice) return;

        if (choice.value === "removeOneOAuth") {
          const account = await pickOAuthAccount(
            "Remove ChatGPT/Codex Account",
            "Select an account to remove",
          );
          if (!account) return;
          await openAiCodexAuthManager.removeOAuthAccount(account.id);
        } else if (choice.value === "oauth") {
          await openAiCodexAuthManager.clearOAuth();
        } else if (choice.value === "apiKey") {
          await openAiCodexAuthManager.clearApiKey();
        } else {
          await openAiCodexAuthManager.clearAll();
        }
        vscode.window.showInformationMessage(
          "Updated OpenAI/Codex authentication. OAuth is preferred for model chat when present; embeddings require an API key.",
        );
        log(`[codex] Removed auth method: ${choice.value}`);
        return;
      }

      if (hasOAuth) {
        const accounts = await openAiCodexAuthManager.listOAuthAccounts();
        if (accounts.length > 1) {
          const action = await vscode.window.showQuickPick(
            [
              { label: "Remove one account", value: "one" },
              { label: "Remove all accounts", value: "all" },
            ],
            {
              title: "Remove ChatGPT/Codex Account",
              ignoreFocusOut: true,
            },
          );
          if (!action) return;
          if (action.value === "one") {
            const account = await pickOAuthAccount(
              "Remove ChatGPT/Codex Account",
              "Select an account to remove",
            );
            if (!account) return;
            await openAiCodexAuthManager.removeOAuthAccount(account.id);
          } else {
            await openAiCodexAuthManager.clearOAuth();
          }
        } else {
          await openAiCodexAuthManager.clearOAuth();
        }

        vscode.window.showInformationMessage(
          "Updated ChatGPT/Codex OAuth accounts.",
        );
        log("[codex] Updated OAuth accounts");
        return;
      }

      if (hasApiKey) {
        await openAiCodexAuthManager.clearApiKey();
        vscode.window.showInformationMessage(
          "Removed OpenAI API key. Semantic search/indexing embeddings require an API key. Model chat can still use ChatGPT/Codex OAuth.",
        );
        log("[codex] Removed OpenAI API key");
        return;
      }

      vscode.window.showInformationMessage(
        "No OpenAI/Codex credentials are currently configured for model chat or embeddings.",
      );
      log("[codex] Sign-out requested, but no credentials were configured");
    }),
    vscode.commands.registerCommand("agentlink.startServer", () =>
      startServer(context),
    ),
    vscode.commands.registerCommand("agentlink.stopServer", () => stopServer()),
    vscode.commands.registerCommand("agentlink.showStatus", () => {
      vscode.commands.executeCommand("agentLink.statusView.focus");
    }),
  );

  // ── Code Actions & Context Menu Commands ──

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new AgentCodeActionProvider(),
      {
        providedCodeActionKinds:
          AgentCodeActionProvider.providedCodeActionKinds,
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "agentlink.fixWithAgent",
      (
        uri: vscode.Uri,
        range: vscode.Range,
        diagnostics: vscode.Diagnostic[],
      ) => {
        const relPath = vscode.workspace.asRelativePath(uri);
        const diagText = diagnostics
          .map(
            (d) =>
              `[${d.source ?? ""}] ${d.message} (line ${d.range.start.line + 1})`,
          )
          .join("\n");
        const prompt = `Fix the following issue(s) in \`${relPath}\`:\n\n${diagText}`;
        chatViewProvider.injectPrompt(prompt, [relPath]);
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.explainWithAgent",
      (uri?: vscode.Uri, range?: vscode.Range) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        // When invoked from context menu, no args are passed — use editor selection
        const targetUri = uri ?? editor.document.uri;
        const targetRange = range ?? editor.selection;
        if (targetRange.isEmpty) return;
        const selection = editor.document.getText(targetRange);
        const relPath = vscode.workspace.asRelativePath(targetUri);
        const startLine = targetRange.start.line + 1;
        const endLine = targetRange.end.line + 1;
        const prompt = `Explain this code from \`${relPath}\` (lines ${startLine}-${endLine}):\n\n\`\`\`\n${selection}\n\`\`\``;
        chatViewProvider.injectPrompt(prompt, [], true);
      },
    ),
    vscode.commands.registerCommand(
      "agentlink.addFileToChat",
      (uri?: vscode.Uri) => {
        const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) return;
        const relPath = vscode.workspace.asRelativePath(targetUri);
        chatViewProvider.injectAttachment(relPath);
      },
    ),
    vscode.commands.registerCommand("agentlink.addSelectionToChat", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) return;
      const selection = editor.document.getText(editor.selection);
      const relPath = vscode.workspace.asRelativePath(editor.document.uri);
      const startLine = editor.selection.start.line + 1;
      const endLine = editor.selection.end.line + 1;
      const context = `From \`${relPath}\` (lines ${startLine}-${endLine}):\n\`\`\`\n${selection}\n\`\`\``;
      chatViewProvider.injectContext(context);
    }),
  );

  // Handle workspace folders being added/removed
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      if (activePort === null) return;
      for (const added of e.added) {
        updateAgentConfigsForFolder(
          added.uri.fsPath,
          activePort,
          activeAuthToken,
        );
      }
      for (const removed of e.removed) {
        cleanupAgentConfigsForFolder(removed.uri.fsPath);
      }
    }),
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
      stopServer();
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

  // Onboarding: show agent picker in sidebar on first activation
  const onboardingComplete =
    context.globalState.get<boolean>("onboardingComplete");
  if (!onboardingComplete) {
    context.globalState.update("onboardingComplete", true);
    showAgentPickerInSidebar();
  }

  // Auto-start with retry
  const autoStart = getConfig<boolean>("autoStart");
  if (autoStart) {
    const MAX_RETRIES = 3;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // Track retry timer for cleanup on deactivation
    context.subscriptions.push({
      dispose: () => {
        if (retryTimer) clearTimeout(retryTimer);
      },
    });
    const startWithRetry = async (attempt: number): Promise<void> => {
      try {
        await startServer(context);
        // Trigger auto-index after server starts (first attempt only)
        if (attempt === 0 && indexerManager) {
          const autoIndex = vscode.workspace
            .getConfiguration("agentlink")
            .get<boolean>("autoIndex", true);
          if (autoIndex) {
            indexerManager.startIndexing();
          }
        }
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          const delay = 1000 * 2 ** attempt; // 2s, 4s, 8s
          log(
            `Server start attempt ${attempt + 1} failed, retrying in ${delay}ms: ${err}`,
          );
          retryTimer = setTimeout(() => startWithRetry(attempt + 1), delay);
        } else {
          log(
            `Failed to start server after ${MAX_RETRIES + 1} attempts: ${err}`,
          );
          statusBarManager.setError(`Server failed to start: ${err}`);
          vscode.window.showErrorMessage(
            `AgentLink: Failed to start MCP server after ${MAX_RETRIES + 1} attempts: ${err}`,
          );
        }
      }
    };
    startWithRetry(0);
  } else {
    updateStatusBar(null);
  }
}

export function deactivate(): void {
  toolUsageTelemetry?.dispose();
  toolUsageTelemetry = null;
  stopServer();
}
