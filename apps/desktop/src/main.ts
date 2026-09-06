import { randomUUID } from "node:crypto";
import * as path from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  type WebContents,
} from "electron";
import { listCodexModels } from "@agentlink/core/codex";
import type { CoreModelCatalogEntry } from "@agentlink/protocol/model-catalog";

import type { BrowserGatewayHelperLeaseClient } from "../../../src/browser-gateway/helper/BrowserGatewayHelperLeaseClient.js";
import type { BrowserGatewayHelperModelAuthLeaseClient } from "../../../src/browser-gateway/helper/BrowserGatewayHelperModelAuthLeaseClient.js";
import type { BrowserGatewayHelperDiscoveryRecord } from "../../../src/browser-gateway/protocol.js";
import { DesktopAuthController } from "./desktopAuth.js";
import { DesktopRemoteView } from "./DesktopRemoteView.js";

declare const __AGENTLINK_HOST_VERSION__: string;

const CHAT_LOAD_ATTEMPTS = 2;
const CHAT_LOAD_RETRY_MS = 250;
const OWNER_ID = "agentlink-desktop";
const OWNER_GENERATION_ID = randomUUID();
const CLIENT_ID = `agentlink-desktop:${OWNER_GENERATION_ID}`;
const CREDENTIAL_REFRESH_MS = 45 * 60_000;
const authController = new DesktopAuthController();

let chatWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let leaseClient: BrowserGatewayHelperLeaseClient | null = null;
let authClient: BrowserGatewayHelperModelAuthLeaseClient | null = null;
let discovery: BrowserGatewayHelperDiscoveryRecord | null = null;
let credentialRefreshTimer: NodeJS.Timeout | null = null;

function log(message: string): void {
  process.stderr.write(`[agentlink-desktop] ${message}\n`);
}

function getResourceRoot(): string {
  const configured = process.env.AGENTLINK_DESKTOP_RESOURCE_ROOT?.trim();
  if (configured) return path.resolve(configured);
  if (app.isPackaged) return path.join(process.resourcesPath, "runtime");
  return path.resolve(app.getAppPath(), "../..");
}

function getDesktopAssetPath(fileName: string): string {
  return path.join(__dirname, fileName);
}

function buildCodexCatalog(
  authMethod: "oauth" | "apiKey",
): CoreModelCatalogEntry[] {
  return listCodexModels("openai-codex", authMethod).map((model) => ({
    id: model.id,
    displayName: model.displayName,
    providerId: "openai-codex",
    providerDisplayName: "OpenAI",
    supportsToolUse: model.capabilities.supportsToolUse,
    supportsImages: model.capabilities.supportsImages,
    contextWindow: model.capabilities.contextWindow,
    maxInputTokens: model.capabilities.maxInputTokens,
    maxOutputTokens: model.capabilities.maxOutputTokens,
    reasoningEfforts: model.capabilities.reasoningEfforts,
    defaultReasoningEffort: model.capabilities.defaultReasoningEffort,
    authenticated: true,
    readiness: { status: "ready" },
  }));
}

async function startLocalService(): Promise<BrowserGatewayHelperDiscoveryRecord> {
  process.env.AGENTLINK_BROWSER_GATEWAY_DISCOVERY_NAMESPACE ??= "desktop";
  const [bootstrapModule, leaseModule, authLeaseModule] = await Promise.all([
    import("../../../src/browser-gateway/helper/bootstrapHelper.js"),
    import("../../../src/browser-gateway/helper/BrowserGatewayHelperLeaseClient.js"),
    import("../../../src/browser-gateway/helper/BrowserGatewayHelperModelAuthLeaseClient.js"),
  ]);
  const configuredPort = Number.parseInt(
    process.env.AGENTLINK_DESKTOP_HELPER_PORT ?? "",
    10,
  );
  const browserGatewayPort =
    Number.isInteger(configuredPort) &&
    configuredPort > 0 &&
    configuredPort <= 65_535
      ? configuredPort
      : 47_138;
  const result = await bootstrapModule.bootstrapBrowserGatewayHelper({
    extensionRootPath: getResourceRoot(),
    browserGatewayPort,
    helperVersion: __AGENTLINK_HOST_VERSION__,
    idleShutdownMs: 60_000,
    spawnEnv: {
      ELECTRON_RUN_AS_NODE: "1",
      AGENTLINK_BROWSER_GATEWAY_STANDALONE_MCP: "1",
      ...(app.isPackaged
        ? {
            NODE_PATH: path.join(process.resourcesPath, "node_modules"),
          }
        : {}),
    },
    log,
  });
  discovery = result.discovery;

  leaseClient = new leaseModule.BrowserGatewayHelperLeaseClient({
    helperUrl: discovery.url,
    clientId: CLIENT_ID,
    clientSharedSecret: discovery.clientSharedSecret,
    coreOwner: {
      ownerId: OWNER_ID,
      ownerKind: "desktop",
      displayName: "AgentLink Desktop",
      scope: {
        kind: "projectless",
        scopeId: "default-ask-agent",
        displayName: "Ask Agent",
      },
      ownerGenerationId: OWNER_GENERATION_ID,
      processId: process.pid,
    },
    log,
  });
  await leaseClient.start();

  authClient = new authLeaseModule.BrowserGatewayHelperModelAuthLeaseClient({
    helperUrl: discovery.url,
    clientSharedSecret: discovery.clientSharedSecret,
    grantedByOwnerId: OWNER_ID,
    getGrantedByOwnerId: () => leaseClient?.getEffectiveOwnerId() ?? OWNER_ID,
    grantedByOwnerGenerationId: OWNER_GENERATION_ID,
    resolveModelAuth: async () => await authController.resolveModelAuth(),
    log,
    defaultTtlMs: 55 * 60_000,
  });

  if (await authController.hasModelAuth()) await publishDesktopModelOwner();
  credentialRefreshTimer = setInterval(() => {
    void publishDesktopModelOwner().catch((error) =>
      log(`credential refresh failed: ${String(error)}`),
    );
  }, CREDENTIAL_REFRESH_MS);
  credentialRefreshTimer.unref();
  return discovery;
}

async function publishDesktopModelOwner(): Promise<void> {
  if (!authClient || !discovery?.helperGenerationId) {
    throw new Error("desktop_service_not_ready");
  }
  const resolvedAuth = await authController.resolveModelAuth();
  if (!resolvedAuth) throw new Error("model_credentials_missing");
  await authClient.publishModelCatalog({
    helperGenerationId: discovery.helperGenerationId,
    models: buildCodexCatalog(resolvedAuth.method),
  });
  const credential = await authClient.grantCredential({
    helperGenerationId: discovery.helperGenerationId,
    modelScopes: ["chat"],
    now: Date.now(),
    providerId: "openai-codex",
  });
  if (!credential) throw new Error("model_credentials_missing");
}

function allowOnlyLocalService(
  contents: WebContents,
  serviceUrl: string,
): void {
  const allowedOrigin = new URL(serviceUrl).origin;
  contents.on("will-navigate", (event, targetUrl) => {
    if (new URL(targetUrl).origin !== allowedOrigin) event.preventDefault();
  });
  contents.on("will-redirect", (event, targetUrl) => {
    if (new URL(targetUrl).origin !== allowedOrigin) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    const target = new URL(url);
    if (target.protocol === "https:")
      void shell.openExternal(target.toString());
    return { action: "deny" };
  });
}

async function showChatWindow(): Promise<void> {
  if (!discovery) throw new Error("desktop_service_not_ready");

  if (chatWindow) {
    chatWindow.show();
    chatWindow.focus();
    return;
  }

  const nextWindow = new BrowserWindow({
    title: "AgentLink",
    show: false,
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: "#181a1b",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: getDesktopAssetPath("chat-preload.cjs"),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  chatWindow = nextWindow;
  allowOnlyLocalService(nextWindow.webContents, discovery.url);
  new DesktopRemoteView(nextWindow, new URL(discovery.url).origin);
  nextWindow.on("closed", () => {
    if (chatWindow === nextWindow) chatWindow = null;
  });

  try {
    const desktopUrl = new URL(discovery.url);
    desktopUrl.searchParams.set("surface", "desktop");
    let lastError: unknown;
    for (let attempt = 1; attempt <= CHAT_LOAD_ATTEMPTS; attempt += 1) {
      try {
        await nextWindow.loadURL(desktopUrl.toString());
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < CHAT_LOAD_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(resolve, CHAT_LOAD_RETRY_MS),
          );
        }
      }
    }
    if (lastError) throw lastError;
    nextWindow.show();
    nextWindow.focus();
    setupWindow?.destroy();
    setupWindow = null;
  } catch (error) {
    if (!nextWindow.isDestroyed()) nextWindow.destroy();
    if (chatWindow === nextWindow) chatWindow = null;
    throw error;
  }
}

async function showSetupWindow(): Promise<void> {
  if (setupWindow) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    title: "Set up AgentLink",
    width: 580,
    height: 620,
    minWidth: 500,
    minHeight: 560,
    resizable: true,
    backgroundColor: "#16191a",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: getDesktopAssetPath("preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  setupWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  setupWindow.on("closed", () => {
    setupWindow = null;
  });
  await setupWindow.loadFile(getDesktopAssetPath("setup.html"));
}

function registerCredentialIpc(): void {
  ipcMain.handle("agentlink:credentials:status", (event) => {
    assertSetupSender(event.sender);
    return authController.getStatus();
  });
  ipcMain.handle(
    "agentlink:credentials:store-openai-api-key",
    async (event, value) => {
      assertSetupSender(event.sender);
      if (typeof value !== "string" || value.length > 8_192) {
        throw new Error("invalid_api_key");
      }
      authController.setOpenAiApiKey(value);
      await publishDesktopModelOwner();
      setTimeout(() => {
        void showChatWindow().catch((error) =>
          log(`chat window failed: ${String(error)}`),
        );
      }, 0);
      return { ok: true };
    },
  );
  ipcMain.handle("agentlink:oauth:sign-in", async (event) => {
    assertSetupSender(event.sender);
    const account = await authController.signIn();
    await publishDesktopModelOwner();
    return { account, status: await authController.getStatus() };
  });
  ipcMain.handle("agentlink:oauth:set-active", async (event, accountId) => {
    assertSetupSender(event.sender);
    if (typeof accountId !== "string" || accountId.length > 200) {
      throw new Error("invalid_oauth_account_id");
    }
    await authController.setActiveAccount(accountId);
    await publishDesktopModelOwner();
    return await authController.getStatus();
  });
  ipcMain.handle("agentlink:oauth:remove", async (event, accountId) => {
    assertSetupSender(event.sender);
    if (typeof accountId !== "string" || accountId.length > 200) {
      throw new Error("invalid_oauth_account_id");
    }
    await authController.removeAccount(accountId);
    if (await authController.hasModelAuth()) await publishDesktopModelOwner();
    else await authClient?.clearCredential("openai-codex");
    return await authController.getStatus();
  });
  ipcMain.handle("agentlink:continue-to-chat", async (event) => {
    assertSetupSender(event.sender);
    if (!(await authController.hasModelAuth())) {
      throw new Error("model_credentials_missing");
    }
    await publishDesktopModelOwner();
    setTimeout(() => {
      void showChatWindow().catch((error) =>
        log(`chat window failed: ${String(error)}`),
      );
    }, 0);
    return { ok: true };
  });
}

function installApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          {
            label: "Manage Accounts…",
            click: () => void showSetupWindow(),
          },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

function assertSetupSender(sender: WebContents): void {
  if (!setupWindow || sender.id !== setupWindow.webContents.id) {
    throw new Error("unauthorized_desktop_ipc_sender");
  }
}

async function shutdown(): Promise<void> {
  if (credentialRefreshTimer) clearInterval(credentialRefreshTimer);
  credentialRefreshTimer = null;
  authController.cancelSignIn();
  await leaseClient?.stop();
  leaseClient = null;
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    await dialog.showMessageBox({
      type: "error",
      title: "AgentLink Desktop",
      message: "This first desktop preview currently supports macOS only.",
    });
    app.quit();
    return;
  }

  if (!app.isPackaged) {
    app.dock?.setIcon(path.join(app.getAppPath(), "assets", "icon.png"));
  }

  registerCredentialIpc();
  installApplicationMenu();
  await authController.initialize();
  await startLocalService();
  if (await authController.hasModelAuth()) await showChatWindow();
  else await showSetupWindow();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = chatWindow ?? setupWindow;
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.on("activate", () => {
    if (chatWindow || setupWindow) return;
    void authController
      .hasModelAuth()
      .then((hasModelAuth) =>
        hasModelAuth ? showChatWindow() : showSetupWindow(),
      );
  });
  app.on("before-quit", (event) => {
    if (!leaseClient) return;
    event.preventDefault();
    void shutdown().finally(() => {
      app.exit(0);
    });
  });
  app
    .whenReady()
    .then(main)
    .catch(async (error) => {
      log(`startup failed: ${String(error)}`);
      await dialog.showMessageBox({
        type: "error",
        title: "AgentLink Desktop could not start",
        message: error instanceof Error ? error.message : String(error),
        detail:
          "Build the AgentLink helper first, then try again. A running incompatible helper is never replaced automatically.",
      });
      app.quit();
    });
}
