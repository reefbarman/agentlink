import {
  readDesktopPreferences,
  updateDesktopPreferences,
} from "./desktopPreferences.js";

import type { App } from "electron";

export interface OpenAtLoginStatus {
  /** False for unpackaged development builds, which must not register a login item. */
  available: boolean;
  enabled: boolean;
  /** macOS is waiting for approval in System Settings → General → Login Items. */
  requiresApproval: boolean;
}

type LoginItemApp = Pick<
  App,
  "isPackaged" | "getLoginItemSettings" | "setLoginItemSettings"
>;

/**
 * Registers the app to open at login the first time it runs. Afterwards the
 * system login item is the source of truth, so removing it in System Settings
 * is respected rather than silently re-added on the next launch.
 */
export async function initializeOpenAtLogin(
  app: LoginItemApp,
  preferencesPath: string,
): Promise<void> {
  if (!app.isPackaged) return;
  const preferences = await readDesktopPreferences(preferencesPath);
  if (preferences.openAtLoginInitialized) return;
  app.setLoginItemSettings({ openAtLogin: true });
  await updateDesktopPreferences(preferencesPath, {
    openAtLoginInitialized: true,
  });
}

export function getOpenAtLoginStatus(app: LoginItemApp): OpenAtLoginStatus {
  if (!app.isPackaged) {
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
): Promise<OpenAtLoginStatus> {
  if (!app.isPackaged) throw new Error("open_at_login_unavailable");
  app.setLoginItemSettings({ openAtLogin: enabled });
  await updateDesktopPreferences(preferencesPath, {
    openAtLoginInitialized: true,
  });
  return getOpenAtLoginStatus(app);
}

/** True when macOS launched the app as a login item, so it should start in the menu bar only. */
export function wasOpenedAtLogin(app: LoginItemApp): boolean {
  return app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin;
}
