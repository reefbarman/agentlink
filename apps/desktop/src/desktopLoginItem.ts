import {
  readDesktopPreferences,
  updateDesktopPreferences,
} from "./desktopPreferences.js";

import type { App } from "electron";

export interface OpenAtLoginStatus {
  /**
   * False for unpackaged development builds, which must not register a login
   * item, and on Linux, where Electron has no login item API.
   */
  available: boolean;
  enabled: boolean;
  /** macOS is waiting for approval in System Settings → General → Login Items. */
  requiresApproval: boolean;
}

type LoginItemApp = Pick<
  App,
  "isPackaged" | "getLoginItemSettings" | "setLoginItemSettings"
>;

function loginItemsSupported(
  app: LoginItemApp,
  platform: NodeJS.Platform,
): boolean {
  return app.isPackaged && platform === "darwin";
}

/**
 * Registers the app to open at login the first time it runs. Afterwards the
 * system login item is the source of truth, so removing it in System Settings
 * is respected rather than silently re-added on the next launch.
 */
export async function initializeOpenAtLogin(
  app: LoginItemApp,
  preferencesPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (!loginItemsSupported(app, platform)) return;
  const preferences = await readDesktopPreferences(preferencesPath);
  if (preferences.openAtLoginInitialized) return;
  app.setLoginItemSettings({ openAtLogin: true });
  await updateDesktopPreferences(preferencesPath, {
    openAtLoginInitialized: true,
  });
}

export function getOpenAtLoginStatus(
  app: LoginItemApp,
  platform: NodeJS.Platform = process.platform,
): OpenAtLoginStatus {
  if (!loginItemsSupported(app, platform)) {
    return { available: false, enabled: false, requiresApproval: false };
  }
  const settings = app.getLoginItemSettings();
  return {
    available: true,
    enabled: settings.openAtLogin,
    requiresApproval: settings.status === "requires-approval",
  };
}

export async function setOpenAtLogin(
  app: LoginItemApp,
  preferencesPath: string,
  enabled: boolean,
  platform: NodeJS.Platform = process.platform,
): Promise<OpenAtLoginStatus> {
  if (!loginItemsSupported(app, platform)) {
    throw new Error("open_at_login_unavailable");
  }
  app.setLoginItemSettings({ openAtLogin: enabled });
  await updateDesktopPreferences(preferencesPath, {
    openAtLoginInitialized: true,
  });
  return getOpenAtLoginStatus(app, platform);
}

/** True when macOS launched the app as a login item, so it should start in the menu bar only. */
export function wasOpenedAtLogin(
  app: LoginItemApp,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    loginItemsSupported(app, platform) &&
    app.getLoginItemSettings().wasOpenedAtLogin
  );
}
