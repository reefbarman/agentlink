import { describe, expect, it, vi } from "vitest";

import { BrowserGatewayServer } from "./BrowserGatewayServer.js";
import { BrowserGatewayService } from "./BrowserGatewayService.js";
import { InMemoryAgentUiEventHub } from "../agent/AgentUiPublisher.js";

vi.mock("vscode", () => {
  type Listener<T> = (event: T) => void;

  class MockEventEmitter<T> {
    private listeners = new Set<Listener<T>>();

    event = (listener: Listener<T>) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };

    fire(value: T): void {
      for (const listener of this.listeners) {
        listener(value);
      }
    }

    dispose(): void {
      this.listeners.clear();
    }
  }

  return {
    EventEmitter: MockEventEmitter,
    workspace: {
      getConfiguration: vi.fn(() => ({ get: vi.fn(() => undefined) })),
    },
  };
});

function makeSessionManagerStub() {
  return {
    listPersistedSessions: vi.fn(() => []),
    getForegroundSession: vi.fn(() => null),
    getPersistedSessionMessages: vi.fn(() => []),
    getBgSessionInfos: vi.fn(() => []),
  };
}

describe("BrowserGatewayServer API-only routes", () => {
  it("does not serve browser UI/static routes and still serves API routes", async () => {
    const service = new BrowserGatewayService(
      new InMemoryAgentUiEventHub(),
      makeSessionManagerStub() as never,
      () => ({
        cssVariables: {},
        colorScheme: "dark",
        themeLabel: "Dark",
        source: "vscode-theme-api",
      }),
      () => "prompt",
      () => true,
      () => "high",
      () => null,
      () => [],
    );

    const server = new BrowserGatewayServer(
      service,
      {
        submitBrowserApprovalDecision: vi.fn(() => true),
        submitBrowserQuestionResponse: vi.fn(() => true),
        submitBrowserQuestionProgress: vi.fn(() => true),
        submitBrowserSend: vi.fn(async () => ({ ok: true })),
      } as never,
      "test-token",
      "instance-headless",
      "Workspace",
      "/workspace",
      vi.fn(),
    );

    const port = await server.start(0);
    const base = `http://127.0.0.1:${port}`;

    const root = await fetch(`${base}/`);
    expect(root.status).toBe(404);

    const js = await fetch(`${base}/browser-gateway.js`);
    expect(js.status).toBe(404);

    const css = await fetch(`${base}/browser-gateway.css`);
    expect(css.status).toBe(404);

    const codicon = await fetch(`${base}/codicon.css`);
    expect(codicon.status).toBe(404);

    const health = await fetch(`${base}/health`);
    expect(health.ok).toBe(true);

    const state = await fetch(`${base}/api/ui-state`);
    expect(state.ok).toBe(true);

    await server.stop();
  });
});
