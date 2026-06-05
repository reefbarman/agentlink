import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { BrowserGatewayThemeSnapshot } from "../shared/types.js";
import { randomUUID } from "crypto";

const CACHE_DIR = path.join(os.homedir(), ".agentlink");
const THEME_CACHE_PATH = path.join(CACHE_DIR, "browser-gateway-theme.json");

export const BAKED_BROWSER_GATEWAY_THEME: BrowserGatewayThemeSnapshot = {
  cssVariables: {
    "--vscode-editor-background": "#121314",
    "--vscode-editor-foreground": "#bbbebf",
    "--vscode-foreground": "#bfbfbf",
    "--vscode-descriptionForeground": "#8c8c8c",
    "--vscode-sideBar-background": "#191a1b",
    "--vscode-sideBar-foreground": "#bfbfbf",
    "--vscode-sideBar-border": "#2a2b2c",
    "--vscode-panel-background": "#191a1b",
    "--vscode-panel-border": "#2a2b2c",
    "--vscode-editorWidget-background": "#202122",
    "--vscode-editorWidget-foreground": "#bfbfbf",
    "--vscode-widget-border": "#2a2b2c",
    "--vscode-widget-shadow": "rgba(0, 0, 0, 0.36)",
    "--vscode-input-background": "#191a1b",
    "--vscode-input-foreground": "#bfbfbf",
    "--vscode-input-border": "#333536",
    "--vscode-input-placeholderForeground": "#555555",
    "--vscode-button-background": "#297aa0",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-button-hoverBackground": "#2b7da3",
    "--vscode-button-border": "#333536",
    "--vscode-button-secondaryBackground": "rgba(0, 0, 0, 0)",
    "--vscode-button-secondaryForeground": "#bfbfbf",
    "--vscode-button-secondaryHoverBackground": "rgba(255, 255, 255, 0.06)",
    "--vscode-badge-background": "rgba(57, 148, 188, 0.94)",
    "--vscode-badge-foreground": "#ffffff",
    "--vscode-focusBorder": "rgba(57, 148, 188, 0.7)",
    "--vscode-textLink-foreground": "#53a5ca",
    "--vscode-errorForeground": "#f48771",
    "--vscode-list-hoverBackground": "rgba(255, 255, 255, 0.05)",
    "--vscode-list-activeSelectionBackground": "rgba(57, 148, 188, 0.15)",
    "--vscode-list-activeSelectionForeground": "#ededed",
    "--vscode-list-focusBackground": "rgba(57, 148, 188, 0.15)",
    "--vscode-list-focusForeground": "#bfbfbf",
    "--vscode-tab-activeBackground": "#121314",
    "--vscode-tab-activeForeground": "#bfbfbf",
    "--vscode-tab-inactiveBackground": "#191a1b",
    "--vscode-tab-inactiveForeground": "#8c8c8c",
    "--vscode-tab-hoverBackground": "#121314",
    "--vscode-tab-border": "#2a2b2c",
    "--vscode-tab-activeBorderTop": "#3994bc",
    "--vscode-editorGroupHeader-tabsBackground": "#191a1b",
    "--vscode-editorGroupHeader-tabsBorder": "#2a2b2c",
    "--vscode-terminal-background": "#1e1e1e",
    "--vscode-terminal-foreground": "#cccccc",
    "--vscode-terminalCursor-foreground": "#aeafad",
    "--vscode-terminal-ansiBlack": "#000000",
    "--vscode-terminal-ansiRed": "#cd3131",
    "--vscode-terminal-ansiGreen": "#0dbc79",
    "--vscode-terminal-ansiYellow": "#e5e510",
    "--vscode-terminal-ansiBlue": "#2472c8",
    "--vscode-terminal-ansiMagenta": "#bc3fbc",
    "--vscode-terminal-ansiCyan": "#11a8cd",
    "--vscode-terminal-ansiWhite": "#e5e5e5",
    "--vscode-terminal-ansiBrightBlack": "#666666",
    "--vscode-terminal-ansiBrightRed": "#f14c4c",
    "--vscode-terminal-ansiBrightGreen": "#23d18b",
    "--vscode-terminal-ansiBrightYellow": "#f5f543",
    "--vscode-terminal-ansiBrightBlue": "#3b8eea",
    "--vscode-terminal-ansiBrightMagenta": "#d670d6",
    "--vscode-terminal-ansiBrightCyan": "#29b8db",
    "--vscode-terminal-ansiBrightWhite": "#e5e5e5",
    "--vscode-font-family":
      "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, sans-serif",
    "--vscode-font-size": "13px",
    "--vscode-font-weight": "normal",
    "--vscode-editor-font-family": "Menlo, Monaco, 'Courier New', monospace",
  },
  colorScheme: "dark",
  themeLabel: "AgentLink Default Dark",
  source: "baked-default",
};

export function getBrowserGatewayThemeCachePath(): string {
  return THEME_CACHE_PATH;
}

export function isBrowserGatewayThemeSnapshot(
  value: unknown,
): value is BrowserGatewayThemeSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BrowserGatewayThemeSnapshot>;
  if (!candidate.cssVariables || typeof candidate.cssVariables !== "object") {
    return false;
  }
  return Object.entries(candidate.cssVariables).every(
    ([key, val]) =>
      /^--vscode-[A-Za-z0-9_.-]+$/.test(key) && typeof val === "string",
  );
}

export async function readBrowserGatewayThemeCache(): Promise<BrowserGatewayThemeSnapshot | null> {
  try {
    const raw = await fs.readFile(THEME_CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return isBrowserGatewayThemeSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeBrowserGatewayThemeCache(
  theme: BrowserGatewayThemeSnapshot,
): Promise<void> {
  if (!isBrowserGatewayThemeSnapshot(theme)) return;
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const tmpPath = `${THEME_CACHE_PATH}.tmp.${process.pid}.${randomUUID()}`;
  await fs.writeFile(tmpPath, JSON.stringify(theme, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.rename(tmpPath, THEME_CACHE_PATH);
}
