export interface BrowserGatewayThemeSnapshot {
  cssVariables: Record<string, string>;
  colorScheme?: "light" | "dark" | "hc" | "hc-light";
  themeLabel?: string;
  source?: "webview-dom" | "vscode-theme-api" | "baked-default";
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
