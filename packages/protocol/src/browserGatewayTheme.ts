export const BROWSER_GATEWAY_COLOR_SCHEMES = Object.freeze([
  "light",
  "dark",
  "hc",
  "hc-light",
] as const);

export type BrowserGatewayColorScheme =
  (typeof BROWSER_GATEWAY_COLOR_SCHEMES)[number];

export const BROWSER_GATEWAY_THEME_SOURCES = Object.freeze([
  "webview-dom",
  "vscode-theme-api",
  "baked-default",
] as const);

export type BrowserGatewayThemeSource =
  (typeof BROWSER_GATEWAY_THEME_SOURCES)[number];

export interface BrowserGatewayThemeSnapshot {
  cssVariables: Record<string, string>;
  colorScheme?: BrowserGatewayColorScheme;
  themeLabel?: string;
  source?: BrowserGatewayThemeSource;
}

export interface BrowserGatewayThemeVariable {
  name: string;
  value: string;
}

export interface BrowserGatewayThemeState {
  revision: string;
  colorScheme: BrowserGatewayColorScheme;
  variables: BrowserGatewayThemeVariable[];
}

export function isBrowserGatewayThemeSnapshot(
  value: unknown,
): value is BrowserGatewayThemeSnapshot {
  if (!isRecord(value) || !isRecord(value.cssVariables)) return false;
  if (
    value.colorScheme !== undefined &&
    !BROWSER_GATEWAY_COLOR_SCHEMES.includes(
      value.colorScheme as BrowserGatewayColorScheme,
    )
  ) {
    return false;
  }
  if (value.themeLabel !== undefined && typeof value.themeLabel !== "string") {
    return false;
  }
  if (
    value.source !== undefined &&
    !BROWSER_GATEWAY_THEME_SOURCES.includes(
      value.source as BrowserGatewayThemeSource,
    )
  ) {
    return false;
  }
  return Object.entries(value.cssVariables).every(
    ([key, val]) =>
      /^--vscode-[A-Za-z0-9_.-]+$/.test(key) && typeof val === "string",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
