import type { BrowserGatewayDataPlaneMode } from "@agentlink/protocol/browser-gateway-data-plane-mode";
import type { BrowserGatewayThemeSnapshot } from "@agentlink/protocol/browser-gateway-theme";

/**
 * Server-rendered pages for the browser gateway UI, shared by the VS Code
 * browser gateway helper and the standalone assistant server so both serve
 * the same app shell and pairing page.
 */

export const AGENTLINK_ICON_PATH = "/agentlink-icon.png";
export const AGENTLINK_ICON_SVG_PATH = "/agentlink-icon.svg";
export const AGENTLINK_ICON_SIZES = "256x256";

export function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cssValueEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "")
    .replace(/}/g, "")
    .replace(/<\//g, "<\\/");
}

export function renderThemeStyleTag(
  theme: BrowserGatewayThemeSnapshot,
): string {
  const declarations = Object.entries(theme.cssVariables)
    .filter(
      ([key, value]) =>
        /^--vscode-[A-Za-z0-9_.-]+$/.test(key) &&
        value.trim() &&
        !/url\s*\(/i.test(value),
    )
    .map(([key, value]) => `    ${key}: ${cssValueEscape(value.trim())};`);
  const colorScheme =
    theme.colorScheme === "light" || theme.colorScheme === "hc-light"
      ? "light"
      : "dark";
  declarations.unshift(`    color-scheme: ${colorScheme};`);
  return `<style id="agentlink-initial-theme">\n  :root {\n${declarations.join("\n")}\n  }\n</style>`;
}

/** The `window.__AGENTLINK_BROWSER_GATEWAY__` boot configuration. */
export interface BrowserGatewayBootConfig {
  readonly currentInstanceId: string;
  readonly workspaceName: string;
  readonly routeByInstance: boolean;
  readonly askAgentOnly: boolean;
  /** Present the Ask Agent shell as another product (its name, copy, accent). */
  readonly product?: "assistant";
  readonly initialTheme: BrowserGatewayThemeSnapshot;
  readonly dataPlaneMode: BrowserGatewayDataPlaneMode;
}

/** JSON for an inline script: `<` is escaped so no value can close the tag. */
function inlineScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function renderBrowserGatewayIndexHtml(options: {
  /** Cache-busting version appended to asset URLs. */
  readonly assetVersion: string;
  readonly applicationName?: string;
  readonly title?: string;
  /** Home-screen name; defaults to AgentLink. */
  readonly shortName?: string;
  /** Browser chrome color; defaults to the AgentLink teal. */
  readonly themeColor?: string;
  readonly config: BrowserGatewayBootConfig;
  /** CSP nonce for the inline boot script, when the page sets a CSP. */
  readonly nonce?: string;
}): string {
  const assetVersion = encodeURIComponent(options.assetVersion);
  const config = options.config;
  const nonce = options.nonce ? ` nonce="${htmlEscape(options.nonce)}"` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="application-name" content="${htmlEscape(options.applicationName ?? "AgentLink Remote")}">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="${htmlEscape(options.shortName ?? "AgentLink")}">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="theme-color" content="${htmlEscape(options.themeColor ?? "#4EC9B0")}">
  <title>${htmlEscape(options.title ?? "AgentLink Browser Gateway")}</title>
  ${renderThemeStyleTag(config.initialTheme)}
  <link rel="icon" type="image/svg+xml" href="${AGENTLINK_ICON_SVG_PATH}?v=${assetVersion}">
  <link rel="icon" type="image/png" sizes="${AGENTLINK_ICON_SIZES}" href="${AGENTLINK_ICON_PATH}?v=${assetVersion}">
  <link rel="apple-touch-icon" sizes="${AGENTLINK_ICON_SIZES}" href="/apple-touch-icon.png?v=${assetVersion}">
  <link rel="manifest" href="/site.webmanifest?v=${assetVersion}">
  <link rel="stylesheet" href="/codicon.css?v=${assetVersion}">
  <link rel="stylesheet" href="/browser-gateway.css?v=${assetVersion}">
</head>
<body>
  <div id="root"></div>
  <script${nonce}>
    window.__AGENTLINK_BROWSER_GATEWAY__ = {
      authToken: "",
      currentInstanceId: ${inlineScriptJson(config.currentInstanceId)},
      workspaceName: ${inlineScriptJson(config.workspaceName)},
      routeByInstance: ${inlineScriptJson(config.routeByInstance)},
      askAgentOnly: ${inlineScriptJson(config.askAgentOnly)},${config.product ? `\n      product: ${inlineScriptJson(config.product)},` : ""}
      initialTheme: ${inlineScriptJson(config.initialTheme)},
      dataPlaneMode: ${inlineScriptJson(config.dataPlaneMode)}
    };
  </script>
  <script type="module" src="/browser-gateway.js?v=${assetVersion}"></script>
</body>
</html>`;
}

/** Name and accent colours for a server-rendered pairing page. */
export interface PairingPageBrand {
  readonly name: string;
  readonly accent: string;
  readonly accentHover: string;
  /** Focus ring around the code input, usually the accent at low alpha. */
  readonly accentRing: string;
}

const AGENTLINK_PAIRING_BRAND: PairingPageBrand = {
  name: "AgentLink",
  accent: "#4EC9B0",
  accentHover: "#5ed7bf",
  accentRing: "rgba(78,201,176,0.2)",
};

export function renderBrowserGatewayPairingHtml(options: {
  readonly errorMessage: string | null;
  /** Where the user finds the code. */
  readonly instructions?: string;
  readonly footnote?: string;
  /** Prefills the code, for a sign-in link that carries it. */
  readonly code?: string;
  /** Product name and accent; defaults to AgentLink teal. */
  readonly brand?: PairingPageBrand;
}): string {
  const brand = options.brand ?? AGENTLINK_PAIRING_BRAND;
  const errorBlock = options.errorMessage
    ? `<p class="pair-error" role="alert">${htmlEscape(options.errorMessage)}</p>`
    : "";
  const instructions =
    options.instructions ??
    "Enter the 6-digit code shown in AgentLink on your computer. Codes expire after a few minutes.";
  const footnote =
    options.footnote ??
    "After pairing, this browser stays signed in until you revoke it from the AgentLink chat.";
  const value =
    options.code && /^[0-9]{6}$/.test(options.code)
      ? `\n        value="${options.code}"`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pair with ${htmlEscape(brand.name)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --accent: ${cssValueEscape(brand.accent)};
      --accent-hover: ${cssValueEscape(brand.accentHover)};
      --accent-ring: ${cssValueEscape(brand.accentRing)};
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: #1e1e1e;
      color: #d4d4d4;
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .pair-card {
      background: #252526;
      border: 1px solid #3c3c3c;
      border-radius: 12px;
      padding: 32px 28px;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 12px 32px rgba(0,0,0,0.35);
    }
    .pair-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--accent);
      margin-bottom: 18px;
    }
    .pair-brand .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }
    h1 { margin: 0 0 6px; font-size: 20px; }
    p { margin: 8px 0 16px; line-height: 1.5; font-size: 14px; color: #bbb; }
    .pair-error {
      background: rgba(244, 71, 71, 0.12);
      border: 1px solid rgba(244, 71, 71, 0.4);
      color: #f48771;
      padding: 10px 12px;
      border-radius: 8px;
      font-size: 13px;
    }
    form { display: flex; flex-direction: column; gap: 14px; margin-top: 8px; }
    input[name="code"] {
      font-size: 32px;
      letter-spacing: 8px;
      text-align: center;
      padding: 14px;
      border-radius: 10px;
      border: 1px solid #3c3c3c;
      background: #1e1e1e;
      color: #d4d4d4;
      font-family: "SF Mono", Menlo, Consolas, monospace;
    }
    input[name="code"]:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-ring);
    }
    button {
      font-size: 15px;
      padding: 12px;
      border-radius: 10px;
      border: 0;
      background: var(--accent);
      color: #111;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: var(--accent-hover); }
    .pair-footnote { margin-top: 12px; font-size: 12px; color: #888; }
  </style>
</head>
<body>
  <main class="pair-card">
    <div class="pair-brand"><span class="dot"></span>${htmlEscape(brand.name)}</div>
    <h1>Pair this device</h1>
    <p>${htmlEscape(instructions)}</p>
    ${errorBlock}
    <form method="post" action="/pair" autocomplete="off" novalidate>
      <input
        name="code"
        inputmode="numeric"
        pattern="[0-9]{3} ?[0-9]{3}"
        maxlength="7"
        placeholder="000000"${value}
        autofocus
        required
      />
      <button type="submit">Pair device</button>
    </form>
    <div class="pair-footnote">${htmlEscape(footnote)}</div>
  </main>
</body>
</html>`;
}
