import {
  parseChatPaneMessageAddress,
  sameChatPaneAddress,
  type ChatPaneAddress,
} from "./chatPaneProtocol.js";

export interface ChatPaneWebview {
  postMessage(message: unknown): Thenable<boolean>;
  onDidReceiveMessage(listener: (message: unknown) => void): {
    dispose(): void;
  };
}

export interface ChatPaneConnectionOptions {
  address: ChatPaneAddress;
  webview: ChatPaneWebview;
  onReady(connection: ChatPaneConnection): void | Promise<void>;
  onMessage(
    message: Record<string, unknown>,
    connection: ChatPaneConnection,
  ): void | Promise<void>;
  log?: (message: string) => void;
}

export class ChatPaneConnection {
  private readonly pendingMessages: unknown[] = [];
  private readonly receiveListener: { dispose(): void };
  private ready = false;
  private frozen = false;
  private disposed = false;
  private draining = false;

  constructor(private readonly options: ChatPaneConnectionOptions) {
    this.receiveListener = options.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    });
  }

  getAddress(): ChatPaneAddress {
    return { ...this.options.address };
  }

  isReady(): boolean {
    return this.ready && !this.disposed;
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  postMessage(message: unknown): void {
    if (this.disposed) return;
    this.pendingMessages.push(message);
    void this.drainMessages();
  }

  freeze(): void {
    this.frozen = true;
  }

  resume(): void {
    if (this.disposed) return;
    this.frozen = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.pendingMessages.length = 0;
    this.receiveListener.dispose();
  }

  private async handleMessage(value: unknown): Promise<void> {
    if (this.disposed || !value || typeof value !== "object") return;
    const message = value as Record<string, unknown>;
    const address = parseChatPaneMessageAddress(message);
    if (!address || !sameChatPaneAddress(address, this.options.address)) {
      this.options.log?.(
        `[chat-pane] Rejected stale or unaddressed message for ${this.options.address.tabId}:${this.options.address.paneEpoch}`,
      );
      return;
    }

    if (message.command === "webviewReady") {
      this.ready = true;
      await this.options.onReady(this);
      void this.drainMessages();
      return;
    }
    if (!this.ready || this.frozen) return;
    await this.options.onMessage(message, this);
  }

  private async drainMessages(): Promise<void> {
    if (
      this.draining ||
      this.disposed ||
      !this.ready ||
      this.pendingMessages.length === 0
    ) {
      return;
    }
    this.draining = true;
    try {
      while (!this.disposed && this.ready && this.pendingMessages.length > 0) {
        const message = this.pendingMessages[0];
        try {
          const delivered = await this.options.webview.postMessage(message);
          if (delivered === false) {
            this.ready = false;
            this.options.log?.(
              `[chat-pane] postMessage returned false for ${this.options.address.tabId}:${this.options.address.paneEpoch}`,
            );
            break;
          }
          this.pendingMessages.shift();
        } catch (error) {
          this.ready = false;
          this.options.log?.(
            `[chat-pane] postMessage failed for ${this.options.address.tabId}:${this.options.address.paneEpoch}: ${String(error)}`,
          );
          break;
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
