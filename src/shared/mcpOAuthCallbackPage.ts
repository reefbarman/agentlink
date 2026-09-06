function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderMcpOAuthCallbackPage(input: {
  serverName: string;
  oauthError?: string;
  /** Accepted for compatibility, but provider descriptions are never displayed. */
  oauthErrorDescription?: string;
  returnTarget?: "vscode" | "desktop";
  pendingSetup?: boolean;
}): string {
  const isError = Boolean(input.oauthError);
  const pendingSetup = Boolean(input.pendingSetup);
  const returnTarget =
    input.returnTarget === "desktop" ? "AgentLink Desktop" : "VS Code";
  const title = isError
    ? "Authorization failed"
    : pendingSetup
      ? "Authorization received"
      : "You're connected";
  const eyebrow = isError
    ? "Authentication issue"
    : pendingSetup
      ? "Finishing setup"
      : "Authentication successful";
  const message = isError
    ? `AgentLink couldn't finish connecting to ${escapeHtml(input.serverName)}.`
    : pendingSetup
      ? `Authorization was received for ${escapeHtml(input.serverName)}. AgentLink is finishing setup; check the connection status in ${returnTarget}.`
      : `${escapeHtml(input.serverName)} is now ready to use in AgentLink.`;
  const errorDetail = isError
    ? `<div class="error-detail" role="alert">Authorization was declined or could not be completed. Return to ${returnTarget} to try again.</div>`
    : "";
  const icon = isError
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5m0 3.5v.01M10.3 3.9 2.7 17a2 2 0 0 0 1.73 3h15.14a2 2 0 0 0 1.73-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>`
    : pendingSetup
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 12.5 3.2 3.2L17.5 8.5"/></svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark light">
  <title>AgentLink · ${title}</title>
  <style>
    :root { color-scheme: dark; --brand: #4EC9B0; --brand-soft: rgba(78, 201, 176, .14); --surface: rgba(24, 26, 31, .88); --border: rgba(255, 255, 255, .1); --text: #f4f5f7; --muted: #a9adb7; --danger: #f48771; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; overflow: hidden; font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--text); background: #0d0f12; }
    body::before { content: ""; position: fixed; inset: -30%; background: radial-gradient(circle at 32% 30%, rgba(78, 201, 176, .18), transparent 30%), radial-gradient(circle at 72% 72%, rgba(86, 106, 230, .13), transparent 28%); filter: blur(18px); pointer-events: none; }
    .card { position: relative; width: min(100%, 470px); padding: 34px; overflow: hidden; border: 1px solid var(--border); border-radius: 22px; background: var(--surface); box-shadow: 0 24px 80px rgba(0, 0, 0, .42); backdrop-filter: blur(18px); }
    .card::after { content: ""; position: absolute; inset: 0 0 auto; height: 3px; background: ${isError ? "var(--danger)" : "var(--brand)"}; }
    .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 30px; color: var(--muted); font-size: 13px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; }
    .mark { width: 28px; height: 28px; color: var(--brand); }
    .mark path { fill: currentColor; stroke: none; }
    .status { display: grid; place-items: center; width: 58px; height: 58px; margin-bottom: 22px; border-radius: 18px; color: ${isError ? "var(--danger)" : "var(--brand)"}; background: ${isError ? "rgba(244, 135, 113, .12)" : "var(--brand-soft)"}; }
    .status svg { width: 31px; height: 31px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .eyebrow { margin: 0 0 8px; color: ${isError ? "var(--danger)" : "var(--brand)"}; font-size: 13px; font-weight: 700; letter-spacing: .025em; }
    h1 { margin: 0; font-size: clamp(29px, 6vw, 38px); line-height: 1.08; letter-spacing: -.035em; }
    .message { margin: 15px 0 0; color: var(--muted); font-size: 16px; line-height: 1.6; }
    .error-detail { display: grid; gap: 5px; margin-top: 20px; padding: 14px 16px; border: 1px solid rgba(244, 135, 113, .24); border-radius: 12px; color: var(--danger); background: rgba(244, 135, 113, .08); font-size: 13px; line-height: 1.45; }
    .error-detail span { color: var(--muted); }
    .footer { display: flex; align-items: center; gap: 9px; margin-top: 28px; padding-top: 21px; border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; }
    .pulse { width: 7px; height: 7px; border-radius: 50%; background: ${isError ? "var(--danger)" : "var(--brand)"}; box-shadow: 0 0 0 5px ${isError ? "rgba(244, 135, 113, .1)" : "var(--brand-soft)"}; }
    @media (prefers-color-scheme: light) { :root { color-scheme: light; --surface: rgba(255, 255, 255, .9); --border: rgba(24, 31, 38, .09); --text: #172027; --muted: #5e6872; } body { background: #edf3f2; } .card { box-shadow: 0 24px 70px rgba(32, 58, 53, .14); } }
    @media (max-width: 480px) { .card { padding: 28px 24px; border-radius: 18px; } }
  </style>
</head>
<body>
  <main class="card">
    <div class="brand">
      <svg class="mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3C2.567 3 1 4.567 1 6.5S2.567 10 4.5 10H6V8.5H4.5C3.395 8.5 2.5 7.605 2.5 6.5S3.395 4.5 4.5 4.5H7C8.105 4.5 9 5.395 9 6.5c0 .538-.213 1.026-.559 1.384l1.072 1.057C10.146 8.29 10.5 7.44 10.5 6.5 10.5 4.567 8.933 3 7 3H4.5z"/><path d="M11.5 13c1.933 0 3.5-1.567 3.5-3.5S13.433 6 11.5 6H10v1.5h1.5c1.105 0 2 .895 2 2s-.895 2-2 2H9c-1.105 0-2-.895-2-2 0-.538.213-1.026.559-1.384L6.487 7.059C5.854 7.71 5.5 8.56 5.5 9.5 5.5 11.433 7.067 13 9 13h2.5z"/></svg>
      <span>AgentLink</span>
    </div>
    <div class="status">${icon}</div>
    <p class="eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    <p class="message">${message}</p>
    ${errorDetail}
    <div class="footer"><span class="pulse"></span><span>${isError ? `Return to ${returnTarget} to try again.` : `You can return to ${returnTarget}. This window will close automatically.`}</span></div>
  </main>
  <script>window.setTimeout(() => window.close(), ${isError ? "8000" : "1800"});</script>
</body>
</html>`;
}
