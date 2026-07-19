import * as vscode from "vscode";

import type { ApprovalRequest, DecisionMessage } from "./webview/types.js";
import { describe, expect, it, vi } from "vitest";

import { ApprovalPanelProvider } from "./ApprovalPanelProvider.js";

const { configuration } = vi.hoisted(() => ({
  configuration: {
    get: vi.fn((_key: string, fallback?: unknown) => fallback),
  },
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => configuration),
  },
  commands: {
    executeCommand: vi.fn(),
  },
  window: {
    createWebviewPanel: vi.fn(),
    showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
  },
  ViewColumn: {
    Beside: 2,
  },
  Uri: {
    joinPath: vi.fn((base: { toString: () => string }, ...parts: string[]) => ({
      toString: () => `${base.toString()}/${parts.join("/")}`,
    })),
    file: (fsPath: string) => ({ fsPath, toString: () => fsPath }),
  },
}));

function createProvider() {
  const statusBarManager = {
    setPendingCount: vi.fn(),
    showAlert: vi.fn(() => ({ dispose: vi.fn() })),
  };
  return {
    statusBarManager,
    provider: new ApprovalPanelProvider(
      { toString: () => "file:///extension" } as never,
      statusBarManager as never,
    ),
  };
}

describe("ApprovalPanelProvider webview shell", () => {
  it("renders the shared shell with approval resources", async () => {
    const { provider } = createProvider();
    const webview = {
      options: {},
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (uri: { toString: () => string }) => ({
        toString: () => `webview:${uri.toString()}`,
      }),
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
      postMessage: vi.fn(async () => true),
    };
    const panel = {
      webview,
      reveal: vi.fn(),
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      dispose: vi.fn(),
      iconPath: undefined,
    };
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(panel as never);

    provider.enqueuePathApproval("/outside/file.txt");
    await vi.waitFor(() => expect(panel.reveal).toHaveBeenCalled());

    expect(webview.html).toContain("<title>Approval</title>");
    expect(webview.html).toContain(
      'href="webview:file:///extension/dist/codicon.css"',
    );
    expect(webview.html).toContain(
      'href="webview:file:///extension/dist/approval.css"',
    );
    expect(webview.html).toContain(
      'src="webview:file:///extension/dist/approval.js"',
    );
    expect(webview.html.indexOf("codicon.css")).toBeLessThan(
      webview.html.indexOf("approval.css"),
    );
    expect(panel.reveal).toHaveBeenCalledWith(2, false);
    provider.dispose();
  });
});

describe("ApprovalPanelProvider command security projection", () => {
  it("forwards the exact token-free security summary to shared approval surfaces", async () => {
    const { provider } = createProvider();
    let shown: ApprovalRequest | undefined;
    provider.onForwardApproval = (request, respond) => {
      shown = request;
      respond({ type: "decision", id: request.id, decision: "run-once" });
    };
    const security = {
      auditId: "audit-1",
      route: "sandbox" as const,
      confinement: "verified-baseline" as const,
      routeReason: "verified-local-macos" as const,
      approvalPolicy: "sandbox-baseline-v1" as const,
      preparedAt: 100,
      sandbox: {
        attestationId: "attestation-1",
        attestationVersion: "sandbox-behavior-v1",
        policyVersion: "policy-v1",
        profileId: "workspace-write",
        backend: "seatbelt" as const,
        architecture: "arm64" as const,
        capabilities: {
          backend: "seatbelt",
          processTree: true,
          filesystemRead: "isolated" as const,
          filesystemWrite: "strict" as const,
          network: "blocked" as const,
          privateHome: true,
          privateTmp: true,
          hostIpcBlocked: true,
          resourceLimits: "partial" as const,
          warnings: [],
        },
      },
    };

    await expect(
      provider.enqueueCommandApproval("npm test", "npm test", {
        cwd: "/workspace",
        security,
      }).promise,
    ).resolves.toMatchObject({ decision: "run-once" });

    expect(shown?.security).toBe(security);
    expect(shown).not.toHaveProperty("sandboxCapabilityRequest");
    expect(shown).not.toHaveProperty("bindingDigest");
  });
});

describe("ApprovalPanelProvider path approval queue", () => {
  it("auto-approves queued allow-once path requests in the same directory", async () => {
    const { provider } = createProvider();
    const shownPaths: string[] = [];
    let pendingApproval:
      | {
          request: ApprovalRequest;
          respond: (msg: DecisionMessage) => void;
        }
      | undefined;

    provider.onForwardApproval = (request, respond) => {
      shownPaths.push(request.filePath ?? "");
      pendingApproval = { request, respond };
    };

    const first = provider.enqueuePathApproval(
      "/outside/sibling/a.txt",
    ).promise;
    const second = provider.enqueuePathApproval(
      "/outside/sibling/b.txt",
    ).promise;

    expect(pendingApproval).toBeDefined();
    pendingApproval!.respond({
      type: "decision",
      id: pendingApproval!.request.id,
      decision: "allow-once",
    });

    await expect(first).resolves.toEqual({ decision: "allow-once" });
    await expect(second).resolves.toEqual({ decision: "allow-once" });
    expect(shownPaths).toEqual(["/outside/sibling/a.txt"]);
  });

  it("does not auto-approve queued allow-once path requests outside the approved directory", async () => {
    const { provider } = createProvider();
    const shownPaths: string[] = [];

    provider.onForwardApproval = (request, respond) => {
      shownPaths.push(request.filePath ?? "");
      respond({ type: "decision", id: request.id, decision: "allow-once" });
    };

    const first = provider.enqueuePathApproval("/outside/one/a.txt").promise;
    const second = provider.enqueuePathApproval("/outside/two/b.txt").promise;

    await expect(first).resolves.toEqual({ decision: "allow-once" });
    await expect(second).resolves.toEqual({ decision: "allow-once" });
    expect(shownPaths).toEqual(["/outside/one/a.txt", "/outside/two/b.txt"]);
  });

  it("does not auto-approve later path requests after the queue drains", async () => {
    const { provider } = createProvider();
    const shownPaths: string[] = [];

    provider.onForwardApproval = (request, respond) => {
      shownPaths.push(request.filePath ?? "");
      respond({ type: "decision", id: request.id, decision: "allow-once" });
    };

    await expect(
      provider.enqueuePathApproval("/outside/sibling/a.txt").promise,
    ).resolves.toEqual({ decision: "allow-once" });
    await expect(
      provider.enqueuePathApproval("/outside/sibling/b.txt").promise,
    ).resolves.toEqual({ decision: "allow-once" });

    expect(shownPaths).toEqual([
      "/outside/sibling/a.txt",
      "/outside/sibling/b.txt",
    ]);
  });

  it("auto-approves queued path requests that match a saved approval rule", async () => {
    const { provider } = createProvider();
    const shownPaths: string[] = [];

    let pendingApproval:
      | {
          request: ApprovalRequest;
          respond: (msg: DecisionMessage) => void;
        }
      | undefined;
    provider.onForwardApproval = (request, respond) => {
      shownPaths.push(request.filePath ?? "");
      pendingApproval = { request, respond };
    };

    const first = provider.enqueuePathApproval(
      "/outside/project/a.txt",
    ).promise;
    const second = provider.enqueuePathApproval(
      "/outside/project/nested/b.txt",
    ).promise;

    expect(pendingApproval).toBeDefined();
    pendingApproval!.respond({
      type: "decision",
      id: pendingApproval!.request.id,
      decision: "allow-session",
      rulePattern: "/outside/project/",
      ruleMode: "prefix",
    });

    await expect(first).resolves.toMatchObject({
      decision: "allow-session",
      rulePattern: "/outside/project/",
      ruleMode: "prefix",
    });
    await expect(second).resolves.toEqual({ decision: "allow-once" });
    expect(shownPaths).toEqual(["/outside/project/a.txt"]);
  });
});
