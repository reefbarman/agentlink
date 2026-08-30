import * as vscode from "vscode";

import type {
  HostTerminalSurfaceConnection,
  HostTerminalSurfaceController,
} from "./HostTerminalSurfaceController.js";

import type { HostTerminalDisposable } from "./Phase1HostTerminalCoordinator.js";
import {
  isTerminalSurfaceRequest,
  type TerminalSurfaceRequest,
} from "@agentlink/protocol/terminal-surface";
import { randomUUID } from "node:crypto";

export interface AgentTerminalViewProviderOptions {
  controller: HostTerminalSurfaceController;
  extensionUri?: vscode.Uri;
  log?(message: string): void;
  resolveCreateRequest?(
    request: Extract<TerminalSurfaceRequest, { type: "host-terminal/create" }>,
  ): PromiseLike<
    | Extract<TerminalSurfaceRequest, { type: "host-terminal/create" }>
    | undefined
  >;
}

export class AgentTerminalViewProvider
  implements vscode.WebviewViewProvider, HostTerminalDisposable
{
  static readonly viewType = "agentLink.terminalView";

  private connection: HostTerminalSurfaceConnection | undefined;
  private messageSubscription: vscode.Disposable | undefined;
  private viewDisposeSubscription: vscode.Disposable | undefined;
  private view: vscode.WebviewView | undefined;

  constructor(private readonly options: AgentTerminalViewProviderOptions) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.detach();
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: this.options.extensionUri
        ? [
            vscode.Uri.joinPath(this.options.extensionUri, "dist"),
            vscode.Uri.joinPath(this.options.extensionUri, "media"),
          ]
        : [],
    };
    webviewView.webview.html = this.options.extensionUri
      ? renderTerminalHtml(webviewView.webview, this.options.extensionUri)
      : renderPlaceholderHtml(webviewView.webview.cspSource);

    const connection = this.options.controller.attach((event) =>
      webviewView.webview.postMessage(event),
    );
    this.connection = connection;
    this.messageSubscription = webviewView.webview.onDidReceiveMessage(
      (message: unknown) => {
        if (!isTerminalSurfaceRequest(message)) return;
        if (message.type === "host-terminal/create") {
          void this.handleCreateRequest(connection, message);
          return;
        }
        void this.options.controller.handleRequest(connection, message);
      },
    );
    this.viewDisposeSubscription = webviewView.onDidDispose(() => {
      if (this.view !== webviewView) return;
      this.detach();
      this.view = undefined;
    });
  }

  isVisible(): boolean {
    return this.view?.visible === true;
  }

  revealPreservingFocus(): boolean {
    void vscode.commands
      .executeCommand(`${AgentTerminalViewProvider.viewType}.open`, {
        preserveFocus: true,
      })
      .then(undefined, (error) =>
        this.options.log?.(
          `Unable to reveal AgentLink Terminal: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    return true;
  }

  dispose(): void {
    this.detach();
    this.view = undefined;
  }

  private async handleCreateRequest(
    connection: HostTerminalSurfaceConnection,
    request: Extract<TerminalSurfaceRequest, { type: "host-terminal/create" }>,
  ): Promise<void> {
    try {
      const resolved = this.options.resolveCreateRequest
        ? await this.options.resolveCreateRequest(request)
        : request;
      if (this.connection !== connection) return;
      if (!resolved) {
        await connection.postMessage({
          type: "host-terminal/error",
          requestId: request.requestId,
          message: "Terminal creation was cancelled.",
        });
        return;
      }
      await this.options.controller.handleRequest(connection, resolved);
    } catch (error) {
      if (this.connection !== connection) return;
      await connection.postMessage({
        type: "host-terminal/error",
        requestId: request.requestId,
        message: `Unable to select a terminal workspace: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private detach(): void {
    this.messageSubscription?.dispose();
    this.messageSubscription = undefined;
    this.viewDisposeSubscription?.dispose();
    this.viewDisposeSubscription = undefined;
    if (this.connection) {
      this.options.controller.detach(this.connection);
      this.connection = undefined;
    }
  }
}

function renderTerminalHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const nonce = randomUUID().replaceAll("-", "");
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "terminal.js"),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "terminal.css"),
  );
  const codiconStyleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "codicon.css"),
  );
  const agentLinkTerminalIconUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "agentlink-terminal.svg"),
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource};">
  <style>:root { --agentlink-terminal-icon: url("${agentLinkTerminalIconUri}"); }</style>
  <link rel="stylesheet" href="${codiconStyleUri}">
  <link rel="stylesheet" href="${styleUri}">
  <title>AgentLink Terminal</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

function renderPlaceholderHtml(cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline';">
  <title>AgentLink Terminal</title>
  <style>
    body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); padding: 12px; }
    p { margin: 0; }
  </style>
</head>
<body>
  <p>The AgentLink terminal renderer is not installed in this checkpoint.</p>
</body>
</html>`;
}
