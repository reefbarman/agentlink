import type { BrowserWindowConstructorOptions } from "electron";

/** Desktop runs on macOS and Linux (an AppImage on glibc distributions). */
export function isSupportedDesktopPlatform(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

/**
 * Title bar options for Desktop's regular windows. macOS hides the title bar
 * behind the traffic lights, which the page leaves room for. Linux keeps the
 * window manager's frame (a hidden title bar there removes the frame and its
 * buttons), hides the menu bar until Alt is pressed, and sets the window icon,
 * which X11 window managers do not take from the desktop entry.
 */
export function desktopWindowChrome(
  platform: NodeJS.Platform,
  iconPath: string,
): Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "autoHideMenuBar" | "icon"
> {
  if (platform === "darwin") return { titleBarStyle: "hiddenInset" };
  return { autoHideMenuBar: true, icon: iconPath };
}

/**
 * The tray icon. macOS uses a template image it tints for the menu bar; Linux
 * panels show images as they are, so a black template would vanish on a dark
 * panel. Linux uses the full-colour app icon instead.
 */
export function desktopTrayIcon(
  platform: NodeJS.Platform,
  assetPath: (fileName: string) => string,
): { path: string; template: boolean; size?: number } {
  return platform === "darwin"
    ? { path: assetPath("trayTemplate.png"), template: true }
    : { path: assetPath("icon.png"), template: false, size: 22 };
}
