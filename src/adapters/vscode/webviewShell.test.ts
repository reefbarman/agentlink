import { describe, expect, it } from "vitest";

import { renderWebviewShell } from "./webviewShell.js";

describe("renderWebviewShell", () => {
  it("renders the shared CSP and ordered resources", () => {
    expect(
      renderWebviewShell({
        title: "Approval",
        cspSource: "vscode-resource:",
        scriptUri: "webview:///dist/approval.js",
        styleUris: [
          "webview:///dist/codicon.css",
          "webview:///dist/approval.css",
        ],
        nonce: "fixednonce",
      }),
    ).toBe(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src vscode-resource: 'unsafe-inline'; script-src 'nonce-fixednonce'; font-src vscode-resource:;">
  <link rel="stylesheet" href="webview:///dist/codicon.css">
  <link rel="stylesheet" href="webview:///dist/approval.css">
  <title>Approval</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="fixednonce" type="module" src="webview:///dist/approval.js"></script>
</body>
</html>`);
  });

  it("generates one nonce for both the CSP and script", () => {
    const html = renderWebviewShell({
      title: "AgentLink",
      cspSource: "vscode-resource:",
      scriptUri: "webview:///dist/sidebar.js",
      styleUris: ["webview:///dist/sidebar.css"],
    });
    const cspNonce = html.match(/script-src 'nonce-([^']+)'/)?.[1];
    const scriptNonce = html.match(/<script nonce="([^"]+)"/)?.[1];

    expect(cspNonce).toBeTruthy();
    expect(scriptNonce).toBe(cspNonce);
    expect(cspNonce).not.toContain("-");
  });
});
