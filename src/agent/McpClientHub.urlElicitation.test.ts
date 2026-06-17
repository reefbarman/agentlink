import type * as vscode from "vscode";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { McpClientHub } from "./McpClientHub.js";
import type { McpServerConfig } from "./mcpConfig.js";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  listTools: vi.fn(async () => ({ tools: [] })),
  listResources: vi.fn(async () => ({ resources: [] })),
  listPrompts: vi.fn(async () => ({ prompts: [] })),
  requestHandlers: [] as Array<
    (req: { params: unknown }) => unknown | Promise<unknown>
  >,
  notificationHandler: undefined as
    | ((notification: { params?: unknown }) => unknown | Promise<unknown>)
    | undefined,
}));

vi.mock("vscode", async () => {
  const actual = await vi.importActual<typeof import("../__mocks__/vscode.js")>(
    "../__mocks__/vscode.js",
  );
  return actual;
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect(): Promise<void> {
      return mocks.connect();
    }

    async close(): Promise<void> {
      return mocks.close();
    }

    async listTools(): Promise<{ tools: unknown[] }> {
      return mocks.listTools();
    }

    async listResources(): Promise<{ resources: unknown[] }> {
      return mocks.listResources();
    }

    async listPrompts(): Promise<{ prompts: unknown[] }> {
      return mocks.listPrompts();
    }

    setRequestHandler(
      _schema: unknown,
      handler: (req: { params: unknown }) => unknown | Promise<unknown>,
    ): void {
      mocks.requestHandlers.push(handler);
    }

    setNotificationHandler(
      _schema: unknown,
      handler: typeof mocks.notificationHandler,
    ): void {
      mocks.notificationHandler = handler;
    }

    async callTool(): Promise<{ content: unknown[] }> {
      return { content: [] };
    }

    async readResource(): Promise<{ contents: unknown[] }> {
      return { contents: [] };
    }

    async getPrompt(): Promise<{ messages: unknown[] }> {
      return { messages: [] };
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdioClientTransport {
    onclose?: () => void;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSEClientTransport {
    onclose?: () => void;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHttpClientTransport {
    onclose?: () => void;
  },
}));

class FakeMemento implements vscode.Memento {
  private store = new Map<string, unknown>();

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.store.has(key)) {
      return this.store.get(key) as T;
    }
    return defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }
}

const stdioConfig: McpServerConfig = {
  name: "browser-flow",
  type: "stdio",
  command: "node",
  args: ["server.js"],
};

describe("McpClientHub URL elicitation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestHandlers = [];
    mocks.notificationHandler = undefined;
  });

  it("projects URL-mode elicitation requests and resolves with the selected action", async () => {
    const hub = new McpClientHub(new FakeMemento());
    await hub.connect([stdioConfig]);

    const elicitationHandler = mocks.requestHandlers[0];
    expect(elicitationHandler).toBeDefined();

    const projected = new Promise<unknown>((resolve) => {
      hub.onUrlElicitation = (request, respond) => {
        resolve(request);
        respond("accept");
      };
    });

    const result = await elicitationHandler!({
      params: {
        mode: "url",
        message: "Complete the browser login.",
        elicitationId: "elicit-1",
        url: "https://example.com/login?state=abc",
        task: { ttl: 10 },
      },
    });

    await expect(projected).resolves.toMatchObject({
      serverName: "browser-flow",
      message: "Complete the browser login.",
      elicitationId: "elicit-1",
      url: "https://example.com/login?state=abc",
      origin: "https://example.com",
      host: "example.com",
      isLocalAddress: false,
    });
    expect(result).toEqual({ action: "accept" });
  });

  it("declines malformed or unsafe URL-mode elicitation requests", async () => {
    const hub = new McpClientHub(new FakeMemento());
    const onUrlElicitation = vi.fn();
    hub.onUrlElicitation = onUrlElicitation;
    await hub.connect([stdioConfig]);

    const elicitationHandler = mocks.requestHandlers[0];
    expect(elicitationHandler).toBeDefined();

    await expect(
      elicitationHandler!({
        params: {
          mode: "url",
          message: "Open this file.",
          elicitationId: "bad-scheme",
          url: "file:///etc/passwd",
        },
      }),
    ).resolves.toEqual({ action: "decline" });

    await expect(
      elicitationHandler!({
        params: {
          mode: "url",
          url: "https://example.com/missing-message",
          elicitationId: "missing-message",
        },
      }),
    ).resolves.toEqual({ action: "decline" });

    expect(onUrlElicitation).not.toHaveBeenCalled();
  });

  it("notifies listeners when a URL elicitation completes out of band", async () => {
    const hub = new McpClientHub(new FakeMemento());
    const onComplete = vi.fn();
    hub.onUrlElicitationComplete = onComplete;
    await hub.connect([stdioConfig]);

    expect(mocks.notificationHandler).toBeDefined();
    await mocks.notificationHandler!({
      params: {
        elicitationId: "elicit-1",
      },
    });

    expect(onComplete).toHaveBeenCalledWith("browser-flow", "elicit-1");
  });
});
