import { randomUUID } from "node:crypto";
import * as path from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import type { BrowserGatewayHelperLeaseClient } from "../../../src/browser-gateway/helper/BrowserGatewayHelperLeaseClient.js";
import type { BrowserGatewayHelperModelAuthLeaseClient } from "../../../src/browser-gateway/helper/BrowserGatewayHelperModelAuthLeaseClient.js";
import type { BrowserGatewayHelperDiscoveryRecord } from "../../../src/browser-gateway/protocol.js";
import {
  AGENTLINK_DESKTOP_OWNER_ARGUMENT_PREFIX,
  AGENTLINK_DESKTOP_OWNER_ID,
} from "../../../src/shared/desktopBridge.js";
import {
  DesktopAuthController,
  type DesktopResolvedModelAuth,
} from "./desktopAuth.js";
import { buildDesktopCodexCatalog } from "./desktopModelCatalog.js";
import { DesktopOpenAiCompatibleController } from "./desktopOpenAiCompatible.js";
import {
  getOpenAtLoginStatus,
  initializeOpenAtLogin,
  setOpenAtLogin,
  wasOpenedAtLogin,
} from "./desktopLoginItem.js";
import { refreshDesktopOwner } from "./desktopOwnerRouting.js";
import {
  DesktopQuickAsk,
  QUICK_ASK_PANEL_HEIGHT,
  QUICK_ASK_PANEL_WIDTH,
} from "./DesktopQuickAsk.js";
import { DesktopRemoteView } from "./DesktopRemoteView.js";
import {
  DesktopMcpWindow,
  isDesktopMcpManagerOpenRequest,
  isDesktopMcpConfigScope,
} from "./DesktopMcpWindow.js";
import { openExternalLink } from "./desktopExternalLinks.js";
import { resolveDesktopMcpPath } from "./desktopMcpPath.js";
import { getAskAgentMcpConfigPaths } from "../../../src/agent/mcpConfig.js";
import type { ReleaseUpdateService } from "../../../src/updates/ReleaseUpdateService.js";
import type { ReleaseUpdateState } from "../../../src/updates/releaseUpdateTypes.js";
import { createDesktopReleaseUpdateService } from "./desktopReleaseUpdates.js";
import {
  DesktopReleaseInstaller,
  drainDesktopUpdateHelper,
} from "./desktopReleaseInstall.js";
import { registerDesktopReleaseInstallIpc } from "./desktopReleaseInstallIpc.js";
import { BrowserGatewayHelperAdminClient } from "../../../src/browser-gateway/helper/BrowserGatewayHelperAdminClient.js";
import type { ReleaseInstallState } from "../../../src/updates/releaseInstall.js";

declare const __AGENTLINK_HOST_VERSION__: string;

const CHAT_LOAD_ATTEMPTS = 2;
const CHAT_LOAD_RETRY_MS = 250;
const OWNER_ID = AGENTLINK_DESKTOP_OWNER_ID;
const OWNER_GENERATION_ID = randomUUID();
const CLIENT_ID = `${AGENTLINK_DESKTOP_OWNER_ID}:${OWNER_GENERATION_ID}`;
const CREDENTIAL_REFRESH_MS = 45 * 60_000;
const CODEX_AUTH_RESOLUTION_TIMEOUT_MS = 3_000;
const authController = new DesktopAuthController();
const compatibleController = new DesktopOpenAiCompatibleController();

let chatWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let leaseClient: BrowserGatewayHelperLeaseClient | null = null;
let authClient: BrowserGatewayHelperModelAuthLeaseClient | null = null;
let discovery: BrowserGatewayHelperDiscoveryRecord | null = null;
let credentialRefreshTimer: NodeJS.Timeout | null = null;
let releaseUpdateService: ReleaseUpdateService | null = null;
let releaseInstaller: DesktopReleaseInstaller | null = null;
let releaseInstallerReady = false;
let releaseUpdateUnsubscribe: (() => void) | null = null;
let cachedCodexAuth: DesktopResolvedModelAuth | null = null;
let tray: Tray | null = null;
let quitting = false;
const preferencesPath = path.join(
  app.getPath("userData"),
  "desktop-preferences.json",
);
const mcpManagerWindow = new DesktopMcpWindow({
  getDiscovery: () => discovery,
  getPreloadPath: () => getDesktopAssetPath("chat-preload.cjs"),
  onVisibilityChange: syncDockVisibility,
  log,
});
const quickAsk = new DesktopQuickAsk({
  preferencesPath,
  createWindow: createQuickAskWindow,
  openChat: async () => {
    await showChatWindow();
    return chatWindow?.webContents ?? null;
  },
  canAsk: async () => discovery !== null && (await hasDesktopModel()),
  openSetup: () => {
    void showSetupWindow().catch((error) =>
      log(`setup window failed: ${String(error)}`),
    );
  },
  onShortcutChanged: () => {
    installApplicationMenu();
    updateTrayMenu();
  },
  log,
});

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
  const mcpPath = await resolveDesktopMcpPath();
  const result = await bootstrapModule.bootstrapBrowserGatewayHelper({
    extensionRootPath: getResourceRoot(),
    browserGatewayPort,
    helperVersion: __AGENTLINK_HOST_VERSION__,
    idleShutdownMs: 60_000,
    spawnEnv: {
      ELECTRON_RUN_AS_NODE: "1",
      AGENTLINK_BROWSER_GATEWAY_STANDALONE_MCP: "1",
      ...(mcpPath ? { PATH: mcpPath } : {}),
      ...(app.isPackaged
        ? {
            NODE_PATH: path.join(
              process.resourcesPath,
              "app.asar.unpacked",
              "node_modules",
            ),
          }
        : {}),
    },
    log,
  });
  discovery = result.discovery;

  const registeredHelperGeneration = discovery.helperGenerationId;
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
    productUpdates: {
      getSnapshot: () => {
        if (!releaseUpdateService)
          throw new Error("release_update_unavailable");
        return releaseUpdateService.snapshot();
      },
      onCheckRequested: async (request) => {
        if (
          !releaseUpdateService ||
          discovery?.helperGenerationId !== registeredHelperGeneration ||
          request.expiresAt <= Date.now()
        ) {
          return;
        }
        return releaseUpdateService.check(true);
      },
    },
    onEffectiveOwnerIdChanged: (ownerId) => {
      if (!authClient) return;
      void refreshDesktopOwner({
        ownerId,
        refresh: publishDesktopModelOwner,
        notify: (nextOwnerId) => {
          for (const contents of [
            chatWindow?.webContents,
            quickAsk.getPanelContents(),
          ]) {
            if (contents && !contents.isDestroyed()) {
              contents.send("agentlink:ask-agent-owner-id", nextOwnerId);
            }
          }
        },
        log,
      });
    },
  });
  await leaseClient.start();

  authClient = new authLeaseModule.BrowserGatewayHelperModelAuthLeaseClient({
    helperUrl: discovery.url,
    clientSharedSecret: discovery.clientSharedSecret,
    grantedByOwnerId: OWNER_ID,
    getGrantedByOwnerId: () => leaseClient?.getEffectiveOwnerId() ?? OWNER_ID,
    grantedByOwnerGenerationId: OWNER_GENERATION_ID,
    resolveModelAuth: async (request) => {
      if (request?.providerId?.startsWith("openai-compatible:")) {
        return await compatibleController.resolveModelAuth(request.providerId);
      }
      return cachedCodexAuth;
    },
    log,
    defaultTtlMs: 55 * 60_000,
  });

  if (await hasDesktopModel()) await publishDesktopModelOwner();
  credentialRefreshTimer = setInterval(() => {
    void compatibleController
      .initialize()
      .then(() => publishDesktopModelOwner())
      .catch((error) => log(`credential refresh failed: ${String(error)}`));
  }, CREDENTIAL_REFRESH_MS);
  credentialRefreshTimer.unref();
  return discovery;
}

async function hasDesktopModel(): Promise<boolean> {
  return (
    (await authController.hasModelAuth()) ||
    compatibleController.hasUsableModel()
  );
}

async function resolveCodexAuthForPublication() {
  const timeout = new Promise<null>((resolve) => {
    const timer = setTimeout(
      () => resolve(null),
      CODEX_AUTH_RESOLUTION_TIMEOUT_MS,
    );
    timer.unref();
  });
  const resolved = await Promise.race([
    authController.resolveModelAuth(),
    timeout,
  ]);
  if (!resolved) {
    log("Codex auth resolution timed out; publishing other available models");
  }
  return resolved;
}

async function publishDesktopModelOwner(): Promise<void> {
  if (!authClient || !discovery?.helperGenerationId) {
    throw new Error("desktop_service_not_ready");
  }
  log("publishing desktop model owner: resolving Codex auth");
  const resolvedAuth = await resolveCodexAuthForPublication();
  cachedCodexAuth = resolvedAuth;
  log(
    `publishing desktop model owner: Codex auth ${resolvedAuth ? "ready" : "unavailable"}`,
  );
  const compatibleModels = compatibleController.getModels();
  if (!resolvedAuth && compatibleModels.length === 0) {
    throw new Error("model_credentials_missing");
  }
  log(
    `publishing desktop model owner: publishing ${compatibleModels.length + (resolvedAuth ? buildDesktopCodexCatalog(resolvedAuth.method).length : 0)} models`,
  );
  await authClient.publishModelCatalog({
    helperGenerationId: discovery.helperGenerationId,
    models: [
      ...(resolvedAuth ? buildDesktopCodexCatalog(resolvedAuth.method) : []),
      ...compatibleModels,
    ],
    openAiCompatibleRuntimeProfiles: compatibleController.getRuntimeProfiles(),
  });
  log("publishing desktop model owner: catalog published");
  void publishDesktopCredentials(resolvedAuth !== null);
}

async function publishDesktopCredentials(hasCodexAuth: boolean): Promise<void> {
  if (!authClient || !discovery?.helperGenerationId) return;
  const providerIds = [
    ...(hasCodexAuth ? ["openai-codex"] : []),
    ...compatibleController.listCredentialProviderIds(),
  ];
  await Promise.all(
    providerIds.map(async (providerId) => {
      log(`publishing desktop credential: ${providerId}`);
      const credential = await authClient!.grantCredential({
        helperGenerationId: discovery!.helperGenerationId!,
        modelScopes: ["chat"],
        now: Date.now(),
        providerId,
      });
      log(
        `publishing desktop credential: ${providerId} ${credential ? "ready" : "unavailable"}`,
      );
    }),
  ).catch((error) => log(`credential publication failed: ${String(error)}`));
}

function allowOnlyLocalService(
  contents: WebContents,
  serviceUrl: string,
): void {
  const allowedOrigin = new URL(serviceUrl).origin;
  contents.on("will-navigate", (event, targetUrl) => {
    if (new URL(targetUrl).origin === allowedOrigin) return;
    event.preventDefault();
    openExternalLink(targetUrl, [allowedOrigin]);
  });
  contents.on("will-redirect", (event, targetUrl) => {
    if (new URL(targetUrl).origin !== allowedOrigin) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url, [allowedOrigin]);
    return { action: "deny" };
  });
}

/**
 * AgentLink lives in the menu bar; the Dock icon only appears while one of
 * its regular windows is visible.
 */
function syncDockVisibility(): void {
  const visible = [chatWindow, setupWindow, mcpManagerWindow].some(
    (window) => window && !window.isDestroyed() && window.isVisible(),
  );
  if (visible) void app.dock?.show();
  else app.dock?.hide();
}

async function revealWindow(window: BrowserWindow): Promise<void> {
  // Showing the Dock first switches the app back to a regular app, which
  // macOS requires before a window can take focus from another app.
  await app.dock?.show();
  app.focus({ steal: true });
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function showChatWindow(): Promise<void> {
  if (!discovery) throw new Error("desktop_service_not_ready");

  if (chatWindow) {
    await revealWindow(chatWindow);
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
      additionalArguments: [
        `${AGENTLINK_DESKTOP_OWNER_ARGUMENT_PREFIX}${leaseClient?.getEffectiveOwnerId() ?? OWNER_ID}`,
      ],
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  chatWindow = nextWindow;
  allowOnlyLocalService(nextWindow.webContents, discovery.url);
  new DesktopRemoteView(nextWindow, new URL(discovery.url).origin);
  // Closing hides the chat so reopening is instant and drafts survive; the
  // app keeps running in the menu bar for Quick Ask.
  nextWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    nextWindow.hide();
  });
  nextWindow.on("show", syncDockVisibility);
  nextWindow.on("focus", () => releaseUpdateService?.checkDue());
  nextWindow.on("hide", syncDockVisibility);
  nextWindow.on("closed", () => {
    if (chatWindow === nextWindow) chatWindow = null;
    syncDockVisibility();
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
    await revealWindow(nextWindow);
    setupWindow?.destroy();
    setupWindow = null;
  } catch (error) {
    if (!nextWindow.isDestroyed()) nextWindow.destroy();
    if (chatWindow === nextWindow) chatWindow = null;
    throw error;
  }
}

async function createQuickAskWindow(): Promise<BrowserWindow> {
  if (!discovery) throw new Error("desktop_service_not_ready");
  const panel = new BrowserWindow({
    title: "Quick Ask",
    show: false,
    width: QUICK_ASK_PANEL_WIDTH,
    height: QUICK_ASK_PANEL_HEIGHT,
    // A non-activating panel floats over full-screen apps and every Space
    // without pulling the main window forward.
    type: "panel",
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: getDesktopAssetPath("chat-preload.cjs"),
      additionalArguments: [
        `${AGENTLINK_DESKTOP_OWNER_ARGUMENT_PREFIX}${leaseClient?.getEffectiveOwnerId() ?? OWNER_ID}`,
      ],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  allowOnlyLocalService(panel.webContents, discovery.url);
  const panelUrl = new URL(discovery.url);
  panelUrl.searchParams.set("surface", "desktop");
  panelUrl.searchParams.set("quickAsk", "1");
  try {
    await panel.loadURL(panelUrl.toString());
  } catch (error) {
    if (!panel.isDestroyed()) panel.destroy();
    throw error;
  }
  return panel;
}

async function showSetupWindow(): Promise<void> {
  if (setupWindow) {
    await revealWindow(setupWindow);
    return;
  }
  await app.dock?.show();
  app.focus({ steal: true });
  setupWindow = new BrowserWindow({
    title: "AgentLink Settings",
    width: 580,
    height: 720,
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
  setupWindow.on("focus", () => releaseUpdateService?.checkDue());
  setupWindow.on("closed", () => {
    setupWindow = null;
    syncDockVisibility();
  });
  await setupWindow.loadFile(getDesktopAssetPath("setup.html"));
}

function openMcpManager(request: {
  view: "status" | "config";
  action: "open" | "refresh";
}): void {
  void mcpManagerWindow
    .open(request)
    .catch((error) => log(`MCP manager window failed: ${String(error)}`));
}

function checkForUpdates(): void {
  openSettings();
  if (!releaseUpdateService) return;
  void releaseUpdateService
    .check(true)
    .catch((error) => log(`update check failed: ${String(error)}`));
}

function publishReleaseUpdateState(state: ReleaseUpdateState): void {
  for (const window of [chatWindow, setupWindow]) {
    if (window && !window.isDestroyed()) {
      window.webContents.send("agentlink:release-update:state", state);
    }
  }
  void leaseClient?.refresh();
  updateTrayMenu();
}

async function prepareReleaseUpdateService(): Promise<void> {
  releaseUpdateService = await createDesktopReleaseUpdateService(
    app,
    preferencesPath,
  );
  releaseInstaller = new DesktopReleaseInstaller({
    packaged: app.isPackaged,
    executable: app.getPath("exe"),
    userData: app.getPath("userData"),
    identity: releaseUpdateService.snapshot().identity,
    getCandidate: async () => {
      if (!releaseUpdateService) throw new Error("release_update_unavailable");
      return (await releaseUpdateService.check(true)).candidate ?? undefined;
    },
    confirmInstall: async (version, { localTeamId }) =>
      (
        await dialog.showMessageBox({
          type: "warning",
          title: "Install Desktop update",
          message: `Download and prepare AgentLink Desktop ${version}?`,
          detail: localTeamId
            ? `This replaces your locally signed build (Team ID ${localTeamId}) with the unsigned release preview. macOS will ask for Keychain access again (choose Always Allow), and permissions granted to the local build may need to be granted again. Run npm run desktop:install to switch back to a local build. The download checksum verifies integrity, not publisher authenticity. Restart is a separate confirmation.`
            : "This installs an unsigned preview. The download checksum verifies integrity, not publisher authenticity. Keychain access may be requested again. Restart is a separate confirmation.",
          buttons: ["Install update", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        })
      ).response === 0,
    confirmRestart: async (version) =>
      (
        await dialog.showMessageBox({
          type: "warning",
          title: "Restart to update",
          message: `Restart AgentLink Desktop to use ${version}?`,
          detail:
            "Restart interrupts all Desktop agent sessions, including sessions connected through a browser. VS Code sessions are not stopped.",
          buttons: ["Restart Now", "Later"],
          defaultId: 1,
          cancelId: 1,
        })
      ).response === 0,
    drainHelper: async () => {
      if (!discovery)
        throw new Error(
          "Desktop helper is unavailable. Quit and reopen Desktop before restarting to update.",
        );
      // Never send shutdown to a helper launched by VS Code, even if discovery
      // namespace or port settings were overridden in the launch environment.
      const helper = discovery;
      await drainDesktopUpdateHelper({
        executable: app.getPath("exe"),
        helperPid: helper.pid,
        shutdown: () =>
          new BrowserGatewayHelperAdminClient({
            helperUrl: helper.url,
            clientSharedSecret: helper.clientSharedSecret,
            log,
          }).shutdown(),
      });
    },
    quit: () => app.quit(),
    onState: publishReleaseInstallState,
    log,
  });
  releaseUpdateUnsubscribe = releaseUpdateService.subscribe(
    publishReleaseUpdateState,
  );
}

async function startReleaseUpdateService(): Promise<void> {
  if (!releaseUpdateService) await prepareReleaseUpdateService();
  await releaseUpdateService!.start();
  publishReleaseUpdateState(releaseUpdateService!.snapshot());
}

function openSettings(): void {
  void showSetupWindow().catch((error) =>
    log(`settings window failed: ${String(error)}`),
  );
}

function showQuickAsk(): void {
  void quickAsk
    .show()
    .catch((error) => log(`quick ask failed: ${String(error)}`));
}

function openMainWindow(): void {
  void hasDesktopModel()
    .then((hasModelAuth) =>
      hasModelAuth ? showChatWindow() : showSetupWindow(),
    )
    .catch((error) => log(`window failed: ${String(error)}`));
}

function quickAskMenuItem(): MenuItemConstructorOptions {
  const { shortcut, registered } = quickAsk.getShortcutStatus();
  return {
    label: "Quick Ask",
    ...(shortcut && registered
      ? { accelerator: shortcut, registerAccelerator: false }
      : {}),
    click: showQuickAsk,
  };
}

function publishReleaseInstallState(state: ReleaseInstallState): void {
  for (const window of [chatWindow, setupWindow]) {
    if (window && !window.isDestroyed())
      window.webContents.send("agentlink:release-update:install-state", state);
  }
  updateTrayMenu();
}

function updateTrayMenu(): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      quickAskMenuItem(),
      { label: "Open AgentLink", click: openMainWindow },
      { label: "Check for Updates…", click: checkForUpdates },
      ...(releaseInstaller?.snapshot().phase === "ready_to_restart"
        ? [
            {
              label: "Restart to Update…",
              click: () => {
                void releaseInstaller?.restart();
              },
            },
          ]
        : []),
      { type: "separator" },
      { label: "Settings…", click: openSettings },
      { type: "separator" },
      { label: "Quit AgentLink", click: () => app.quit() },
    ]),
  );
}

function installTray(): void {
  const image = nativeImage.createFromPath(
    getDesktopAssetPath("trayTemplate.png"),
  );
  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip("AgentLink");
  updateTrayMenu();
}

function registerCredentialIpc(): void {
  registerDesktopReleaseInstallIpc({
    ipc: ipcMain,
    assertSender: (event) =>
      assertSetupOrChatSender(event.sender, event.senderFrame),
    getInstaller: () => releaseInstaller,
    isReady: () => releaseInstallerReady,
  });
  ipcMain.handle("agentlink:credentials:status", async (event) => {
    assertSetupSender(event.sender);
    return {
      ...(await authController.getStatus()),
      openAiCompatibleCredentialCount:
        compatibleController.getCredentialCount(),
      hasUsableOpenAiCompatibleModel: compatibleController.hasUsableModel(),
    };
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
    if (await authController.hasModelAuth()) {
      await publishDesktopModelOwner();
    } else {
      await authClient?.clearCredential("openai-codex");
      if (compatibleController.hasUsableModel()) {
        await publishDesktopModelOwner();
      }
    }
    return await authController.getStatus();
  });
  ipcMain.handle("agentlink:continue-to-chat", async (event) => {
    assertSetupSender(event.sender);
    if (!(await hasDesktopModel())) {
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
  ipcMain.handle("agentlink:quick-ask:shortcut:get", (event) => {
    assertSetupSender(event.sender);
    return quickAsk.getShortcutStatus();
  });
  ipcMain.handle("agentlink:quick-ask:shortcut:set", async (event, value) => {
    assertSetupSender(event.sender);
    if (value !== null && typeof value !== "string") {
      throw new Error("invalid_shortcut");
    }
    return await quickAsk.setShortcut(value);
  });
  ipcMain.handle("agentlink:open-at-login:get", (event) => {
    assertSetupSender(event.sender);
    return getOpenAtLoginStatus(app);
  });
  ipcMain.handle("agentlink:open-at-login:set", async (event, value) => {
    assertSetupSender(event.sender);
    if (typeof value !== "boolean") throw new Error("invalid_open_at_login");
    return await setOpenAtLogin(app, preferencesPath, value);
  });
  ipcMain.handle("agentlink:release-update:get", (event) => {
    assertSetupOrChatSender(event.sender, event.senderFrame);
    if (!releaseUpdateService) throw new Error("release_update_unavailable");
    return releaseUpdateService.snapshot();
  });
  ipcMain.handle("agentlink:release-update:check", async (event) => {
    assertSetupOrChatSender(event.sender, event.senderFrame);
    if (!releaseUpdateService) throw new Error("release_update_unavailable");
    return await releaseUpdateService.check(true);
  });
  ipcMain.handle("agentlink:release-update:dismiss", async (event) => {
    assertSetupOrChatSender(event.sender, event.senderFrame);
    if (!releaseUpdateService) throw new Error("release_update_unavailable");
    return await releaseUpdateService.dismiss();
  });
  ipcMain.handle("agentlink:release-update:automatic", async (event, value) => {
    assertSetupIpcSender(event.sender, event.senderFrame);
    if (typeof value !== "boolean") throw new Error("invalid_automatic_checks");
    if (!releaseUpdateService) throw new Error("release_update_unavailable");
    await releaseUpdateService.setAutomaticChecks(value);
    return releaseUpdateService.snapshot();
  });
  ipcMain.handle("agentlink:release-update:open-link", async (event, value) => {
    assertSetupIpcSender(event.sender, event.senderFrame);
    const candidate = releaseUpdateService?.snapshot().candidate;
    if (
      typeof value !== "string" ||
      !candidate ||
      (value !== candidate.releaseUrl && value !== candidate.instructionsUrl)
    ) {
      throw new Error("invalid_release_update_link");
    }
    openExternalLink(value, []);
    return { ok: true };
  });
  ipcMain.on("agentlink:mcp-manager:open", (event, request) => {
    if (
      !chatWindow ||
      event.sender.id !== chatWindow.webContents.id ||
      event.senderFrame !== event.sender.mainFrame ||
      !isDesktopMcpManagerOpenRequest(request)
    ) {
      return;
    }
    openMcpManager(request);
  });
  ipcMain.handle("agentlink:mcp-manager:open-config", async (event, scope) => {
    if (
      !mcpManagerWindow.ownsSender(event.sender) ||
      event.senderFrame !== event.sender.mainFrame ||
      !isDesktopMcpConfigScope(scope)
    ) {
      throw new Error("unauthorized_desktop_ipc_sender");
    }
    const configPath = path.join(
      app.getPath("home"),
      ".agentlink",
      ...(scope === "ask-agent-global" ? ["ask-agent"] : []),
      "mcp.json",
    );
    if (!getAskAgentMcpConfigPaths().includes(configPath)) {
      throw new Error("desktop_mcp_config_path_unavailable");
    }
    const openError = await shell.openPath(configPath);
    if (openError) throw new Error(openError);
    return { ok: true };
  });
  ipcMain.on("agentlink:mcp-manager:operation", (event, operationId) => {
    if (
      !mcpManagerWindow.ownsSender(event.sender) ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      return;
    }
    mcpManagerWindow.setOperation(operationId);
  });
  ipcMain.on("agentlink:open-settings", (event) => {
    if (chatWindow && event.sender.id === chatWindow.webContents.id) {
      openSettings();
    }
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
            label: "Check for Updates…",
            click: checkForUpdates,
          },
          {
            label: "Settings…",
            accelerator: "Command+,",
            click: openSettings,
          },
          {
            label: "MCP Servers…",
            click: () => openMcpManager({ view: "status", action: "open" }),
          },
          { type: "separator" },
          quickAskMenuItem(),
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

function assertSetupOrChatSender(
  sender: WebContents,
  senderFrame: Electron.WebFrameMain | null,
): void {
  if (senderFrame !== sender.mainFrame) {
    throw new Error("unauthorized_desktop_ipc_sender");
  }
  if (setupWindow && sender.id === setupWindow.webContents.id) return;
  if (chatWindow && sender.id === chatWindow.webContents.id) return;
  throw new Error("unauthorized_desktop_ipc_sender");
}

function assertSetupIpcSender(
  sender: WebContents,
  senderFrame: Electron.WebFrameMain | null,
): void {
  assertSetupSender(sender);
  if (senderFrame !== sender.mainFrame) {
    throw new Error("unauthorized_desktop_ipc_sender");
  }
}

function assertSetupSender(sender: WebContents): void {
  if (!setupWindow || sender.id !== setupWindow.webContents.id) {
    throw new Error("unauthorized_desktop_ipc_sender");
  }
}

async function shutdown(): Promise<void> {
  quickAsk.dispose();
  releaseUpdateUnsubscribe?.();
  releaseUpdateUnsubscribe = null;
  releaseUpdateService?.dispose();
  releaseUpdateService = null;
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

  // Login launches start quietly in the menu bar, ready for Quick Ask.
  const startInBackground = wasOpenedAtLogin(app);
  if (startInBackground) app.dock?.hide();
  if (!app.isPackaged) {
    app.dock?.setIcon(path.join(app.getAppPath(), "assets", "icon.png"));
  }

  registerCredentialIpc();
  await quickAsk.initialize();
  installApplicationMenu();
  installTray();
  await initializeOpenAtLogin(app, preferencesPath).catch((error) =>
    log(`open at login setup failed: ${String(error)}`),
  );
  await Promise.all([
    authController.initialize(),
    compatibleController.initialize().catch((error) => {
      log(`OpenAI-compatible config unavailable: ${String(error)}`);
    }),
  ]);
  await prepareReleaseUpdateService();
  await startLocalService();
  if (await hasDesktopModel()) {
    if (!startInBackground) await showChatWindow();
    quickAsk.prewarm();
  } else {
    await showSetupWindow();
  }
  // Only a successfully initialized new app may remove the recovery backup.
  await releaseInstaller
    ?.reconcile()
    .then(() => {
      releaseInstallerReady = true;
      publishReleaseInstallState(releaseInstaller!.snapshot());
    })
    .catch((error) => log(`update reconciliation failed: ${String(error)}`));
  void startReleaseUpdateService().catch((error) =>
    log(`update service failed to start: ${String(error)}`),
  );
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  // Opening the app again (Finder, Spotlight, Dock) brings the window back.
  app.on("second-instance", () => {
    if (discovery) openMainWindow();
  });
  app.on("activate", () => {
    releaseUpdateService?.checkDue();
    if (discovery) openMainWindow();
  });
  // Stay running in the menu bar so the Quick Ask shortcut keeps working.
  app.on("window-all-closed", () => undefined);
  app.on("before-quit", (event) => {
    quitting = true;
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
