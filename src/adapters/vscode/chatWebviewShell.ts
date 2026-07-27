import * as vscode from "vscode";

import type { ChatWebviewBootstrap } from "../../agent/chatPaneProtocol.js";
import { renderWebviewShell } from "./webviewShell.js";

export function renderChatWebviewShell(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  bootstrap: ChatWebviewBootstrap,
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "chat.js"),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "chat.css"),
  );
  const codiconsUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "codicon.css"),
  );
  const bootstrapJson = JSON.stringify(bootstrap).replace(/</g, "\\u003c");

  return renderWebviewShell({
    title: "AgentLink Chat",
    cspSource: webview.cspSource,
    scriptUri: String(scriptUri),
    styleUris: [String(codiconsUri), String(styleUri)],
    scriptSourceAdditions: ["'unsafe-eval'"],
    imageSources: [webview.cspSource, "data:"],
    bodyPrefix: `<script id="agentlink-chat-bootstrap" type="application/json">${bootstrapJson}</script>`,
  });
}
