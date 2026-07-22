import * as vscode from "vscode";

import type {
  HostTerminalSurfaceConnection,
  HostTerminalSurfaceController,
} from "./HostTerminalSurfaceController.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentTerminalViewProvider } from "./AgentTerminalViewProvider.js";
import { TERMINAL_SURFACE_PROTOCOL_VERSION } from "./terminalSurfaceProtocol.js";

function harness(
  options: {
    withAssets?: boolean;
    log?: (message: string) => void;
    resolveCreateRequest?: ConstructorParameters<
      typeof AgentTerminalViewProvider
    >[0]["resolveCreateRequest"];
  } = {},
) {
  let messageListener: ((message: unknown) => void) | undefined;
  let viewDisposeListener: (() => void) | undefined;
  const connection: HostTerminalSurfaceConnection = {
    generation: 1,
    rendererEpoch: "renderer-1",
    postMessage: vi.fn(async () => true),
  };
  const controller: HostTerminalSurfaceController = {
    attach: vi.fn(() => connection),
    detach: vi.fn(),
    handleRequest: vi.fn(async () => undefined),
  };
  const messageSubscription = { dispose: vi.fn() };
  const webview = {
    options: {},
    html: "",
    cspSource: "vscode-webview:",
    asWebviewUri: vi.fn((uri: { path: string }) => ({
      toString: () => `webview:${uri.path}`,
    })),
    postMessage: vi.fn(async () => true),
    onDidReceiveMessage: vi.fn((listener: (message: unknown) => void) => {
      messageListener = listener;
      return messageSubscription;
    }),
  };
  const view = {
    webview,
    visible: true,
    show: vi.fn(),
    onDidDispose: vi.fn((listener: () => void) => {
      viewDisposeListener = listener;
      return { dispose: vi.fn() };
    }),
  };
  const provider = new AgentTerminalViewProvider({
    controller,
    ...(options.withAssets
      ? {
          extensionUri: {
            fsPath: "/extension",
            path: "/extension",
            scheme: "file",
          } as never,
        }
      : {}),
    resolveCreateRequest: options.resolveCreateRequest,
    log: options.log,
  });
  provider.resolveWebviewView(view as never);
  return {
    provider,
    controller,
    connection,
    view,
    webview,
    messageSubscription,
    send(message: unknown) {
      messageListener?.(message);
    },
    disposeView() {
      viewDisposeListener?.();
    },
    setVisible(visible: boolean) {
      view.visible = visible;
    },
  };
}

describe("AgentTerminalViewProvider", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the stable terminal view ID", () => {
    expect(AgentTerminalViewProvider.viewType).toBe("agentLink.terminalView");
  });

  it("renders a CSP-only placeholder with no local assets", () => {
    const test = harness();

    expect(test.webview.options).toEqual({
      enableScripts: true,
      localResourceRoots: [],
    });
    expect(test.webview.html).toContain("default-src 'none'");
    expect(test.webview.html).not.toContain("<script");
    expect(test.webview.html).not.toContain("dist/terminal");
    expect(test.controller.attach).toHaveBeenCalledTimes(1);
  });

  it("loads nonce-protected terminal assets and the AgentLink media icon", () => {
    const test = harness({ withAssets: true });

    expect(test.webview.options).toEqual({
      enableScripts: true,
      localResourceRoots: [
        expect.objectContaining({ path: "/extension/dist" }),
        expect.objectContaining({ path: "/extension/media" }),
      ],
    });
    expect(test.webview.html).toContain("default-src 'none'");
    expect(test.webview.html).toMatch(/script-src 'nonce-[a-f0-9]+'/);
    expect(test.webview.html).toContain(
      'href="webview:/extension/dist/codicon.css"',
    );
    expect(test.webview.html).toContain(
      'href="webview:/extension/dist/terminal.css"',
    );
    expect(test.webview.html).toContain(
      'src="webview:/extension/dist/terminal.js"',
    );
    expect(test.webview.html).toContain(
      '--agentlink-terminal-icon: url("webview:/extension/media/agentlink-terminal.svg")',
    );
    expect(test.webview.html).toContain("img-src vscode-webview:");
    expect(test.webview.html).toMatch(
      /style-src vscode-webview: 'unsafe-inline'/,
    );
    expect(test.webview.html).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it("reports VS Code's authoritative view visibility", () => {
    const test = harness();

    expect(test.provider.isVisible()).toBe(true);
    test.setVisible(false);
    expect(test.provider.isVisible()).toBe(false);
    test.disposeView();
    expect(test.provider.isVisible()).toBe(false);
  });

  it("opens the terminal view container without taking keyboard focus", () => {
    const executeCommand = vi
      .spyOn(vscode.commands, "executeCommand")
      .mockResolvedValue(undefined);
    const test = harness();
    test.setVisible(false);

    expect(test.provider.revealPreservingFocus()).toBe(true);
    expect(executeCommand).toHaveBeenCalledWith("agentLink.terminalView.open", {
      preserveFocus: true,
    });
    expect(test.view.show).not.toHaveBeenCalled();
  });

  it("opens an unresolved terminal view through its generated view command", () => {
    const executeCommand = vi
      .spyOn(vscode.commands, "executeCommand")
      .mockResolvedValue(undefined);
    const test = harness();
    test.disposeView();

    expect(test.provider.revealPreservingFocus()).toBe(true);
    expect(executeCommand).toHaveBeenCalledWith("agentLink.terminalView.open", {
      preserveFocus: true,
    });
    expect(test.view.show).not.toHaveBeenCalled();
  });

  it("logs terminal view reveal failures without rejecting", async () => {
    const log = vi.fn();
    vi.spyOn(vscode.commands, "executeCommand").mockRejectedValue(
      new Error("view unavailable"),
    );
    const test = harness({ log });

    expect(test.provider.revealPreservingFocus()).toBe(true);
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith(
        "Unable to reveal AgentLink Terminal: view unavailable",
      );
    });
  });

  it("dispatches exact valid messages with the provider-owned connection", async () => {
    const test = harness();
    const ready = {
      type: "terminal-view/ready" as const,
      protocolVersion: TERMINAL_SURFACE_PROTOCOL_VERSION,
    };

    test.send(ready);
    await Promise.resolve();

    expect(test.controller.handleRequest).toHaveBeenCalledWith(
      test.connection,
      ready,
    );
  });

  it("resolves create requests before dispatching them to the controller", async () => {
    const resolveCreateRequest = vi.fn(async (request) => ({
      ...request,
      cwd: "/workspace/project-b",
    }));
    const test = harness({ resolveCreateRequest });

    test.send({ type: "host-terminal/create", requestId: "request-1" });
    await vi.waitFor(() => {
      expect(test.controller.handleRequest).toHaveBeenCalledWith(
        test.connection,
        {
          type: "host-terminal/create",
          requestId: "request-1",
          cwd: "/workspace/project-b",
        },
      );
    });
  });

  it("reports cancelled create resolution without dispatching to the controller", async () => {
    const test = harness({
      resolveCreateRequest: vi.fn(async () => undefined),
    });

    test.send({ type: "host-terminal/create", requestId: "request-1" });
    await vi.waitFor(() => {
      expect(test.connection.postMessage).toHaveBeenCalledWith({
        type: "host-terminal/error",
        requestId: "request-1",
        message: "Terminal creation was cancelled.",
      });
    });
    expect(test.controller.handleRequest).not.toHaveBeenCalled();
  });

  it("reports create-resolution failures without dispatching to the controller", async () => {
    const test = harness({
      resolveCreateRequest: vi.fn(async () => {
        throw new Error("picker failed");
      }),
    });

    test.send({ type: "host-terminal/create", requestId: "request-1" });
    await vi.waitFor(() => {
      expect(test.connection.postMessage).toHaveBeenCalledWith({
        type: "host-terminal/error",
        requestId: "request-1",
        message: "Unable to select a terminal workspace: picker failed",
      });
    });
    expect(test.controller.handleRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong protocol", { type: "terminal-view/ready", protocolVersion: 2 }],
    [
      "extra key",
      {
        type: "host-terminal/create",
        requestId: "request-1",
        unexpected: true,
      },
    ],
    ["unknown message", { type: "host-terminal/unknown" }],
    ["non-object", "ready"],
  ])("rejects malformed messages: %s", async (_name, message) => {
    const test = harness();

    test.send(message);
    await Promise.resolve();

    expect(test.controller.handleRequest).not.toHaveBeenCalled();
  });

  it("detaches the stale connection when re-resolved and disposed", () => {
    const test = harness();
    const secondSubscription = { dispose: vi.fn() };
    const secondWebview = {
      ...test.webview,
      options: {},
      html: "",
      onDidReceiveMessage: vi.fn(() => secondSubscription),
    };

    test.provider.resolveWebviewView({
      webview: secondWebview,
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    } as never);
    expect(test.messageSubscription.dispose).toHaveBeenCalledTimes(1);
    expect(test.controller.detach).toHaveBeenCalledWith(test.connection);

    test.provider.dispose();
    expect(secondSubscription.dispose).toHaveBeenCalledTimes(1);
    expect(test.controller.detach).toHaveBeenCalledTimes(2);
  });

  it("detaches when VS Code disposes the webview", () => {
    const test = harness();

    test.disposeView();

    expect(test.messageSubscription.dispose).toHaveBeenCalledTimes(1);
    expect(test.controller.detach).toHaveBeenCalledWith(test.connection);
  });
});
