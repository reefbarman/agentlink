import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getOpenAtLoginStatus,
  initializeOpenAtLogin,
  setOpenAtLogin,
  wasOpenedAtLogin,
} from "./desktopLoginItem.js";
import { mkdtemp, rm } from "node:fs/promises";

import { readDesktopPreferences } from "./desktopPreferences.js";
import { tmpdir } from "node:os";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

async function preferencesPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agentlink-login-item-"));
  dirs.push(dir);
  return path.join(dir, "desktop-preferences.json");
}

function fakeApp(isPackaged = true) {
  const state = { openAtLogin: false };
  return {
    state,
    isPackaged,
    setLoginItemSettings: vi.fn((settings: { openAtLogin?: boolean }) => {
      state.openAtLogin = settings.openAtLogin ?? false;
    }),
    getLoginItemSettings: vi.fn(() => ({
      openAtLogin: state.openAtLogin,
      status: "enabled",
      wasOpenedAtLogin: true,
    })),
  };
}

describe("desktop login item", () => {
  it("opens at login by default on first run only", async () => {
    const app = fakeApp();
    const prefs = await preferencesPath();
    await initializeOpenAtLogin(app as never, prefs);
    expect(app.state.openAtLogin).toBe(true);
    expect(await readDesktopPreferences(prefs)).toMatchObject({
      openAtLoginInitialized: true,
    });

    // The user removes it in System Settings; later launches respect that.
    app.state.openAtLogin = false;
    await initializeOpenAtLogin(app as never, prefs);
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(1);
    expect(getOpenAtLoginStatus(app as never).enabled).toBe(false);
  });

  it("toggles the login item from settings", async () => {
    const app = fakeApp();
    const prefs = await preferencesPath();
    await expect(setOpenAtLogin(app as never, prefs, true)).resolves.toEqual({
      available: true,
      enabled: true,
      requiresApproval: false,
    });
    await setOpenAtLogin(app as never, prefs, false);
    expect(app.state.openAtLogin).toBe(false);
  });

  it("never registers development builds", async () => {
    const app = fakeApp(false);
    const prefs = await preferencesPath();
    await initializeOpenAtLogin(app as never, prefs);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(getOpenAtLoginStatus(app as never).available).toBe(false);
    expect(wasOpenedAtLogin(app as never)).toBe(false);
    await expect(setOpenAtLogin(app as never, prefs, true)).rejects.toThrow(
      "open_at_login_unavailable",
    );
  });
});
