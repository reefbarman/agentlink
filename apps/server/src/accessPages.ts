import {
  htmlEscape,
  type PairingPageBrand,
  renderBrowserGatewayPairingHtml,
} from "../../../src/browser-gateway/browserGatewayPages.js";

import type { ServerAccessDevice } from "./ServerAccessStore.js";
import { renderSVG } from "uqr";

/**
 * Server-rendered sign-in and device pages. They use plain forms and no
 * script, so they work under the server's strict content security policy.
 */

/** The Assistant's name and violet accent, shared with the web app. */
const ASSISTANT_BRAND: PairingPageBrand = {
  name: "AgentLink Assistant",
  accent: "#B59AFF",
  accentHover: "#c4adff",
  accentRing: "rgba(181,154,255,0.22)",
};

const PAIR_INSTRUCTIONS =
  "Enter the 6-digit pairing code. Get one from a device that is already signed in (open /devices there), or on the server run: agentlink-server pair";
const PAIR_FOOTNOTE =
  "After pairing, this browser stays signed in until you revoke it from /devices.";

export function renderPairPage(options: {
  readonly errorMessage?: string;
  readonly code?: string;
}): string {
  return renderBrowserGatewayPairingHtml({
    errorMessage: options.errorMessage ?? null,
    instructions: PAIR_INSTRUCTIONS,
    footnote: PAIR_FOOTNOTE,
    brand: ASSISTANT_BRAND,
    ...(options.code ? { code: options.code } : {}),
  });
}

/** The sign-in link for a code: opening it prefills the pair page. */
export function pairingLink(origin: string, code: string): string {
  return `${origin}/pair?code=${encodeURIComponent(code)}`;
}

export function renderNewPairingPage(options: {
  readonly code: string;
  readonly expiresAt: number;
  readonly link: string;
  readonly now?: number;
}): string {
  const minutes = Math.max(
    1,
    Math.round((options.expiresAt - (options.now ?? Date.now())) / 60_000),
  );
  return page(
    "Pair another device",
    `<h1>Pair another device</h1>
    <p>On the new device, scan this code or open the link, then confirm. Or go to <strong>/pair</strong> there and type the code.</p>
    <div class="code" aria-label="Pairing code">${htmlEscape(spacedCode(options.code))}</div>
    <div class="qr">${renderSVG(options.link, { border: 2 })}</div>
    <p class="link"><a href="${htmlEscape(options.link)}">${htmlEscape(options.link)}</a></p>
    <p class="muted">Single use. Expires in about ${minutes} minute${minutes === 1 ? "" : "s"}.</p>
    <p><a href="/devices">Back to devices</a></p>`,
  );
}

export function renderDevicesPage(options: {
  readonly devices: readonly ServerAccessDevice[];
  readonly currentDeviceId: string;
  readonly errorMessage?: string;
}): string {
  const active = options.devices
    .filter((device) => device.revokedAt === undefined)
    .sort((left, right) => right.createdAt - left.createdAt);
  const rows = active
    .map((device) => {
      const current = device.deviceId === options.currentDeviceId;
      return `<li>
        <div>
          <div class="label">${htmlEscape(device.label)}${current ? ' <span class="badge">This device</span>' : ""}</div>
          <div class="muted">Paired ${htmlEscape(new Date(device.createdAt).toUTCString())}</div>
        </div>
        <form method="post" action="/devices/${encodeURIComponent(device.deviceId)}/revoke">
          <button class="danger" type="submit">${current ? "Sign out" : "Revoke"}</button>
        </form>
      </li>`;
    })
    .join("\n");
  return page(
    "Devices",
    `<h1>Devices</h1>
    <p>Browsers and phones signed in to this assistant.</p>
    ${options.errorMessage ? `<p class="error" role="alert">${htmlEscape(options.errorMessage)}</p>` : ""}
    <ul class="devices">${rows}</ul>
    <form method="post" action="/devices/pair">
      <button type="submit">Pair another device</button>
    </form>
    <p><a href="/">Back to chat</a></p>`,
  );
}

function spacedCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(title)} · ${ASSISTANT_BRAND.name}</title>
  <style>
    :root { color-scheme: dark; --accent: ${ASSISTANT_BRAND.accent}; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: #1e1e1e; color: #d4d4d4; margin: 0; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; padding: 16px;
    }
    main {
      background: #252526; border: 1px solid #3c3c3c; border-radius: 12px;
      padding: 28px; max-width: 480px; width: 100%;
      box-shadow: 0 12px 32px rgba(0,0,0,0.35);
    }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; color: var(--accent); margin-bottom: 18px; }
    .brand .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }
    h1 { margin: 0 0 6px; font-size: 20px; }
    p { line-height: 1.5; font-size: 14px; color: #bbb; }
    a { color: var(--accent); }
    .muted { color: #888; font-size: 12px; }
    .error { color: #f48771; }
    .code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 40px; letter-spacing: 6px; text-align: center; margin: 16px 0; color: #fff; }
    .qr { background: #fff; border-radius: 8px; padding: 8px; width: 220px; margin: 0 auto; }
    .qr svg { display: block; width: 100%; height: auto; }
    .link { word-break: break-all; text-align: center; font-size: 13px; }
    ul.devices { list-style: none; padding: 0; margin: 16px 0; }
    ul.devices li { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #3c3c3c; }
    .label { font-weight: 600; }
    .badge { font-size: 11px; color: #111; background: var(--accent); border-radius: 6px; padding: 1px 6px; margin-left: 6px; }
    button { font-size: 14px; padding: 10px 14px; border-radius: 8px; border: 0; background: var(--accent); color: #111; font-weight: 600; cursor: pointer; }
    button.danger { background: transparent; color: #f48771; border: 1px solid rgba(244,71,71,0.5); padding: 6px 10px; }
  </style>
</head>
<body>
  <main>
    <div class="brand"><span class="dot"></span>${ASSISTANT_BRAND.name}</div>
    ${body}
  </main>
</body>
</html>`;
}

/** A short, readable label for a newly paired device from its user agent. */
export function deviceLabelFromUserAgent(
  userAgent: string | undefined,
): string {
  const agent = userAgent ?? "";
  const device = /iPhone/u.test(agent)
    ? "iPhone"
    : /iPad/u.test(agent)
      ? "iPad"
      : /Android/u.test(agent)
        ? "Android"
        : /Macintosh|Mac OS X/u.test(agent)
          ? "Mac"
          : /Windows/u.test(agent)
            ? "Windows"
            : /Linux/u.test(agent)
              ? "Linux"
              : undefined;
  const browser = /Edg\//u.test(agent)
    ? "Edge"
    : /Firefox\//u.test(agent)
      ? "Firefox"
      : /Chrome\//u.test(agent)
        ? "Chrome"
        : /Safari\//u.test(agent)
          ? "Safari"
          : undefined;
  if (device && browser) return `${browser} on ${device}`;
  return device ?? browser ?? "Browser";
}
