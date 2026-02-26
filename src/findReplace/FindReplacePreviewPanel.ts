import * as vscode from "vscode";
import { randomUUID } from "crypto";

import type {
  FindReplacePreviewData,
  PreviewWebviewMessage,
} from "./webview/types.js";

export class FindReplacePreviewPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private acceptedMatches = new Map<string, boolean>();
  private disposables: vscode.Disposable[] = [];
  private pendingData: FindReplacePreviewData | undefined;
  private webviewReady = false;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Open the preview panel and populate it with match data */
  show(data: FindReplacePreviewData): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "nativeClaude.findReplacePreview",
        `Find & Replace: "${data.findText.length > 30 ? data.findText.slice(0, 30) + "…" : data.findText}"`,
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
        {
          enableScripts: true,
          localResourceRoots: [this.extensionUri],
        },
      );
      this.panel.iconPath = vscode.Uri.joinPath(
        this.extensionUri,
        "media",
        "claude-terminal.svg",
      );
      this.panel.webview.html = this.getHtml(this.panel.webview);
      this.panel.onDidDispose(
        () => {
          this.panel = undefined;
          this.webviewReady = false;
        },
        null,
        this.disposables,
      );
      this.panel.webview.onDidReceiveMessage(
        (msg: PreviewWebviewMessage) => this.handleMessage(msg),
        null,
        this.disposables,
      );
    }

    // Initialize all matches as accepted
    this.acceptedMatches.clear();
    for (const fg of data.fileGroups) {
      for (const m of fg.matches) {
        this.acceptedMatches.set(m.id, true);
      }
    }

    this.pendingData = data;
    if (this.webviewReady) {
      this.panel.webview.postMessage({ type: "showPreview", data });
    }
  }

  /** Get the set of accepted match IDs at decision time */
  getAcceptedMatchIds(): Set<string> {
    const accepted = new Set<string>();
    for (const [id, ok] of this.acceptedMatches) {
      if (ok) accepted.add(id);
    }
    return accepted;
  }

  /** Close the panel */
  close(): void {
    this.panel?.dispose();
  }

  private handleMessage(msg: PreviewWebviewMessage): void {
    switch (msg.type) {
      case "ready":
        this.webviewReady = true;
        if (this.pendingData && this.panel) {
          this.panel.webview.postMessage({
            type: "showPreview",
            data: this.pendingData,
          });
        }
        break;
      case "toggleMatch":
        this.acceptedMatches.set(msg.matchId, msg.accepted);
        break;
      case "toggleFile":
        // Toggle all matches whose ID starts with the file index prefix
        for (const [id] of this.acceptedMatches) {
          // Match IDs are "fileIdx:matchIdx", find all for this file path
          if (this.pendingData) {
            const fileIdx = this.pendingData.fileGroups.findIndex(
              (fg) => fg.path === msg.filePath,
            );
            if (fileIdx >= 0 && id.startsWith(`${fileIdx}:`)) {
              this.acceptedMatches.set(id, msg.accepted);
            }
          }
        }
        break;
      case "toggleAll":
        for (const id of this.acceptedMatches.keys()) {
          this.acceptedMatches.set(id, msg.accepted);
        }
        break;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomUUID().replace(/-/g, "");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "fr-preview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "fr-preview.css"),
    );
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "codicon.css"),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${codiconsUri}">
  <link rel="stylesheet" href="${styleUri}">
  <title>Find &amp; Replace Preview</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
