import * as vscode from "vscode";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";

import { McpServerHost } from "./server/McpServerHost.js";
import { disposeQuickPickQueue } from "./util/quickPickQueue.js";
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
import { ConfigStore } from "./approvals/ConfigStore.js";

export const DIFF_VIEW_URI_SCHEME = "native-claude-diff";

let outputChannel: vscode.OutputChannel;
let httpServer: http.Server | null = null;
let mcpHost: McpServerHost | null = null;
let statusBarItem: vscode.StatusBarItem;
let sidebarProvider: SidebarProvider;
let approvalManager: ApprovalManager;
let activePort: number | null = null;
let activeAuthToken: string | undefined;

function log(message: string): void {
  const timestamp = new Date().toISOString();
  outputChannel.appendLine(`[${timestamp}] ${message}`);
}

function getConfig<T>(key: string): T {
  return vscode.workspace.getConfiguration("native-claude").get(key) as T;
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

function updateClaudeConfig(port: number, authToken?: string): boolean {
  const config = readClaudeConfig();
  if (!config) {
    log(
      `Warning: ~/.claude.json contains malformed JSON — skipping auto-configuration`,
    );
    return false;
  }

  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }

  const mcpServers = config.mcpServers as Record<string, unknown>;
  const url = `http://localhost:${port}/mcp`;

  const existing = mcpServers["native-claude"] as
    | Record<string, unknown>
    | undefined;
  if (
    existing &&
    existing.type === "http" &&
    existing.url === url &&
    (!authToken ||
      (existing.headers &&
        (existing.headers as Record<string, string>).Authorization ===
          `Bearer ${authToken}`))
  ) {
    log("~/.claude.json global entry already up to date");
    return true;
  }

  const entry: Record<string, unknown> = { type: "http", url };
  if (authToken) {
    entry.headers = { Authorization: `Bearer ${authToken}` };
  }
  mcpServers["native-claude"] = entry;

  if (writeClaudeConfig(config)) {
    log(`Updated ~/.claude.json with native-claude MCP server (port ${port})`);
    return true;
  }
  return false;
}

// --- Per-project MCP config in ~/.claude.json ---
// Claude Code stores local-scoped MCP servers in ~/.claude.json under
// projects.<workspace-path>.mcpServers. This keeps the workspace clean
// (no .mcp.json files) and uses the same precedence as `claude mcp add --scope local`.

function readClaudeConfig(): Record<string, unknown> | null {
  const configPath = path.join(os.homedir(), ".claude.json");
  try {
    if (!fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeClaudeConfig(config: Record<string, unknown>): boolean {
  const configPath = path.join(os.homedir(), ".claude.json");
  const tmpPath = configPath + ".tmp." + process.pid;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    fs.renameSync(tmpPath, configPath);
    return true;
  } catch (err) {
    log(`Warning: Could not write ~/.claude.json: ${err}`);
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    return false;
  }
}

function updateProjectMcpConfig(port: number, authToken?: string): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return;

  const config = readClaudeConfig();
  if (!config) return;

  if (!config.projects || typeof config.projects !== "object") {
    config.projects = {};
  }
  const projects = config.projects as Record<string, Record<string, unknown>>;

  const url = `http://localhost:${port}/mcp`;
  const entry: Record<string, unknown> = { type: "http", url };
  if (authToken) {
    entry.headers = { Authorization: `Bearer ${authToken}` };
  }

  let changed = false;
  for (const folder of folders) {
    const folderPath = folder.uri.fsPath;
    if (!projects[folderPath]) {
      projects[folderPath] = {};
    }
    const project = projects[folderPath];
    if (!project.mcpServers || typeof project.mcpServers !== "object") {
      project.mcpServers = {};
    }
    const mcpServers = project.mcpServers as Record<string, unknown>;
    mcpServers["native-claude"] = entry;
    changed = true;
    log(`Set native-claude for project ${folderPath} (port ${port})`);
  }

  if (changed) {
    writeClaudeConfig(config);
  }
}

function updateProjectMcpConfigForFolder(
  folderPath: string,
  port: number,
  authToken?: string,
): void {
  const config = readClaudeConfig();
  if (!config) return;

  if (!config.projects || typeof config.projects !== "object") {
    config.projects = {};
  }
  const projects = config.projects as Record<string, Record<string, unknown>>;
  if (!projects[folderPath]) {
    projects[folderPath] = {};
  }
  const project = projects[folderPath];
  if (!project.mcpServers || typeof project.mcpServers !== "object") {
    project.mcpServers = {};
  }

  const url = `http://localhost:${port}/mcp`;
  const entry: Record<string, unknown> = { type: "http", url };
  if (authToken) {
    entry.headers = { Authorization: `Bearer ${authToken}` };
  }
  (project.mcpServers as Record<string, unknown>)["native-claude"] = entry;

  writeClaudeConfig(config);
  log(`Set native-claude for project ${folderPath} (port ${port})`);
}

function cleanupProjectMcpConfig(): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return;

  const config = readClaudeConfig();
  if (!config) return;

  const projects = config.projects as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!projects) return;

  let changed = false;
  for (const folder of folders) {
    const project = projects[folder.uri.fsPath];
    if (!project) continue;
    const mcpServers = project.mcpServers as
      | Record<string, unknown>
      | undefined;
    if (!mcpServers || !("native-claude" in mcpServers)) continue;
    delete mcpServers["native-claude"];
    changed = true;
    log(`Removed native-claude from project ${folder.uri.fsPath}`);
  }

  if (changed) {
    writeClaudeConfig(config);
  }
}

function cleanupProjectMcpConfigForFolder(folderPath: string): void {
  const config = readClaudeConfig();
  if (!config) return;

  const projects = config.projects as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!projects) return;

  const project = projects[folderPath];
  if (!project) return;
  const mcpServers = project.mcpServers as Record<string, unknown> | undefined;
  if (!mcpServers || !("native-claude" in mcpServers)) return;

  delete mcpServers["native-claude"];
  writeClaudeConfig(config);
  log(`Removed native-claude from project ${folderPath}`);
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

  const port = getConfig<number>("port");
  const requireAuth = getConfig<boolean>("requireAuth");
  const authToken = requireAuth ? getOrCreateAuthToken(context) : undefined;

  mcpHost = new McpServerHost(authToken, approvalManager);

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

      try {
        await mcpHost!.handleRequest(req, res, parsedBody);
      } catch (err) {
        log(`MCP request error: ${err}`);
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
        JSON.stringify({ status: "ok", sessions: mcpHost!.sessionCount }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const onListening = (actualPort: number) => {
    activePort = actualPort;
    activeAuthToken = authToken;
    log(`MCP server listening on http://127.0.0.1:${actualPort}/mcp`);
    const configured = updateClaudeConfig(actualPort, authToken);
    updateProjectMcpConfig(actualPort, authToken);
    updateStatusBar(actualPort, configured);
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
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      onListening(actualPort);
      resolve();
    });
  });
}

async function stopServer(): Promise<void> {
  cleanupProjectMcpConfig();
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

function updateStatusBar(
  port: number | null,
  claudeConfigured?: boolean,
): void {
  if (port !== null) {
    statusBarItem.text = `$(chip) Native Claude :${port}`;
    statusBarItem.tooltip = `Native Claude MCP server running on port ${port}`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = `$(chip) Native Claude`;
    statusBarItem.tooltip = "Native Claude MCP server stopped";
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
  }
  statusBarItem.show();

  // Update sidebar
  sidebarProvider?.updateState({
    serverRunning: port !== null,
    port,
    sessions: mcpHost?.sessionCount ?? 0,
    authEnabled: getConfig<boolean>("requireAuth"),
    claudeConfigured: claudeConfigured ?? false,
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
      description: ".claude/native-claude.json",
      scope: "project",
    });
  }
  scopeItems.push({
    label: "$(globe) Global",
    description: "~/.claude/native-claude.json",
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

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Native Claude");
  context.subscriptions.push(outputChannel);

  initializeTerminalManager(context.extensionUri);

  log("Activating Native Claude extension");

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

  // Sidebar
  sidebarProvider = new SidebarProvider(context.extensionUri);
  sidebarProvider.setApprovalManager(approvalManager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewType,
      sidebarProvider,
    ),
  );

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.command = "native-claude.showStatus";
  context.subscriptions.push(statusBarItem);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("native-claude.acceptDiff", () =>
      resolveCurrentDiff("accept"),
    ),
    vscode.commands.registerCommand("native-claude.acceptDiffMore", () =>
      showDiffMoreOptions(),
    ),
    vscode.commands.registerCommand("native-claude.rejectDiff", () =>
      resolveCurrentDiff("reject"),
    ),
    vscode.commands.registerCommand("native-claude.addTrustedCommand", () =>
      addTrustedCommandViaUI(),
    ),
    vscode.commands.registerCommand(
      "native-claude.clearSessionApprovals",
      () => {
        for (const s of approvalManager.getActiveSessions()) {
          approvalManager.clearSession(s.id);
        }
        approvalManager.resetWriteApproval();
        vscode.window.showInformationMessage("All session approvals cleared.");
      },
    ),
    vscode.commands.registerCommand("native-claude.startServer", () =>
      startServer(context),
    ),
    vscode.commands.registerCommand("native-claude.stopServer", () =>
      stopServer(),
    ),
    vscode.commands.registerCommand("native-claude.showStatus", () => {
      const port = httpServer?.address();
      const portNum = typeof port === "object" && port ? port.port : null;
      if (portNum) {
        vscode.window.showInformationMessage(
          `Native Claude MCP server running on port ${portNum} with ${mcpHost?.sessionCount ?? 0} active session(s).`,
        );
      } else {
        vscode.window.showWarningMessage(
          "Native Claude MCP server is not running.",
        );
      }
    }),
  );

  // Handle workspace folders being added/removed
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      if (activePort === null) return;
      for (const added of e.added) {
        updateProjectMcpConfigForFolder(
          added.uri.fsPath,
          activePort,
          activeAuthToken,
        );
      }
      for (const removed of e.removed) {
        cleanupProjectMcpConfigForFolder(removed.uri.fsPath);
      }
    }),
  );

  // Cleanup on deactivation
  context.subscriptions.push({
    dispose: () => {
      stopServer();
      disposeTerminalManager();
      disposeQuickPickQueue();
    },
  });

  // Auto-start with retry
  const autoStart = getConfig<boolean>("autoStart");
  if (autoStart) {
    const MAX_RETRIES = 3;
    const startWithRetry = async (attempt: number): Promise<void> => {
      try {
        await startServer(context);
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          const delay = 1000 * 2 ** attempt; // 2s, 4s, 8s
          log(
            `Server start attempt ${attempt + 1} failed, retrying in ${delay}ms: ${err}`,
          );
          setTimeout(() => startWithRetry(attempt + 1), delay);
        } else {
          log(
            `Failed to start server after ${MAX_RETRIES + 1} attempts: ${err}`,
          );
          vscode.window.showErrorMessage(
            `Native Claude: Failed to start MCP server after ${MAX_RETRIES + 1} attempts: ${err}`,
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
  stopServer();
}
