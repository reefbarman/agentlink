import { describe, expect, it, vi } from "vitest";

import {
  ChatPaneConnection,
  type ChatPaneWebview,
} from "./ChatPaneConnection.js";
import {
  addressChatPaneMessage,
  type ChatPaneAddress,
} from "./chatPaneProtocol.js";

const address: ChatPaneAddress = {
  controllerEpoch: "controller-1",
  tabId: "tab-1",
  sessionId: "session-1",
  surface: "editor",
  paneEpoch: 2,
};

class FakeWebview implements ChatPaneWebview {
  readonly postMessage = vi.fn<(_: unknown) => Promise<boolean>>(() =>
    Promise.resolve(true),
  );
  private readonly listeners = new Set<(message: unknown) => void>();

  onDidReceiveMessage(listener: (message: unknown) => void): {
    dispose(): void;
  } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  receive(message: unknown): void {
    for (const listener of this.listeners) listener(message);
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

function createConnection() {
  const webview = new FakeWebview();
  const onReady = vi.fn();
  const onMessage = vi.fn();
  const log = vi.fn();
  const connection = new ChatPaneConnection({
    address,
    webview,
    onReady,
    onMessage,
    log,
  });
  return { connection, webview, onReady, onMessage, log };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ChatPaneConnection", () => {
  it("accepts only the addressed ready signal", async () => {
    const { connection, webview, onReady, log } = createConnection();

    webview.receive({ command: "webviewReady" });
    webview.receive(
      addressChatPaneMessage(
        { command: "webviewReady" },
        { ...address, paneEpoch: 3 },
      ),
    );
    await settle();

    expect(connection.isReady()).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(2);

    webview.receive(
      addressChatPaneMessage({ command: "webviewReady" }, address),
    );
    await settle();

    expect(connection.isReady()).toBe(true);
    expect(onReady).toHaveBeenCalledWith(connection);
  });

  it("rejects actions until ready and while the connection is frozen", async () => {
    const { connection, webview, onMessage } = createConnection();
    const action = addressChatPaneMessage({ command: "agentStop" }, address);

    webview.receive(action);
    webview.receive(
      addressChatPaneMessage({ command: "webviewReady" }, address),
    );
    await settle();
    connection.freeze();
    webview.receive(action);
    await settle();

    expect(onMessage).not.toHaveBeenCalled();

    connection.resume();
    webview.receive(action);
    await settle();

    expect(onMessage).toHaveBeenCalledOnce();
  });

  it("queues before ready and delivers messages in order", async () => {
    const { connection, webview } = createConnection();
    connection.postMessage({ sequence: 1 });
    connection.postMessage({ sequence: 2 });

    expect(webview.postMessage).not.toHaveBeenCalled();

    webview.receive(
      addressChatPaneMessage({ command: "webviewReady" }, address),
    );
    await settle();

    expect(webview.postMessage.mock.calls.map(([message]) => message)).toEqual([
      { sequence: 1 },
      { sequence: 2 },
    ]);
  });

  it("retains a failed message and resumes from it after reconnect", async () => {
    const { connection, webview, log } = createConnection();
    webview.postMessage
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    connection.postMessage({ sequence: 1 });
    connection.postMessage({ sequence: 2 });

    webview.receive(
      addressChatPaneMessage({ command: "webviewReady" }, address),
    );
    await settle();

    expect(connection.isReady()).toBe(false);
    expect(webview.postMessage).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("returned false"));

    webview.receive(
      addressChatPaneMessage({ command: "webviewReady" }, address),
    );
    await settle();

    expect(webview.postMessage.mock.calls.map(([message]) => message)).toEqual([
      { sequence: 1 },
      { sequence: 1 },
      { sequence: 2 },
    ]);
  });

  it("removes listeners and drops queued work when disposed", async () => {
    const { connection, webview, onReady, onMessage } = createConnection();
    connection.postMessage({ sequence: 1 });

    connection.dispose();
    webview.receive(
      addressChatPaneMessage({ command: "webviewReady" }, address),
    );
    webview.receive(addressChatPaneMessage({ command: "agentStop" }, address));
    await settle();

    expect(webview.listenerCount()).toBe(0);
    expect(connection.isReady()).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(webview.postMessage).not.toHaveBeenCalled();
  });
});
