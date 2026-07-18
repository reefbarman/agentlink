import type { ApprovalRequest, DecisionMessage } from "./webview/types.js";
import { describe, expect, it, vi } from "vitest";

import { ApprovalPanelProvider } from "./ApprovalPanelProvider.js";

const { configuration, getConfiguration } = vi.hoisted(() => {
  const configuration = {
    get: vi.fn((_key: string, fallback?: unknown) => fallback),
  };
  return {
    configuration,
    getConfiguration: vi.fn((..._args: unknown[]) => configuration),
  };
});

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration,
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
    parse: (value: string) => ({
      fsPath: value.replace(/^file:\/\//, ""),
      toString: () => value,
    }),
  },
}));

function createProvider(
  resolveProjectContext?: ConstructorParameters<
    typeof ApprovalPanelProvider
  >[2],
) {
  const statusBarManager = { setPendingCount: vi.fn() };
  return {
    statusBarManager,
    provider: new ApprovalPanelProvider(
      { toString: () => "file:///extension" } as never,
      statusBarManager as never,
      resolveProjectContext,
    ),
  };
}

function projectContext(input: { sessionId?: string; targetPath?: string }) {
  const suffix = input.sessionId === "session-b" ? "b" : "a";
  return {
    sourceProject: {
      projectId: `project-${suffix}`,
      displayName: `Project ${suffix.toUpperCase()}`,
      availability: "available" as const,
    },
    targetPath: input.targetPath,
    projectResourceUri: `file:///workspace/${suffix}`,
  };
}

describe("ApprovalPanelProvider webview shell", () => {
  it("renders the shared shell with approval resources", () => {
    const { provider } = createProvider();
    const webview = {
      options: {},
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (uri: { toString: () => string }) => ({
        toString: () => `webview:${uri.toString()}`,
      }),
    };

    provider.resolveWebviewView({ webview } as never);

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
  });
});

describe("ApprovalPanelProvider project attribution", () => {
  it("snapshots resolved project context once when the request is enqueued", async () => {
    const resolveProjectContext = vi.fn(projectContext);
    const { provider } = createProvider(resolveProjectContext);
    let shownRequest: ApprovalRequest | undefined;

    provider.onForwardApproval = (request, respond) => {
      shownRequest = request;
      respond({ type: "decision", id: request.id, decision: "accept" });
    };

    await expect(
      provider.enqueueWriteApproval("src/output.txt", {
        operation: "modify",
        outsideWorkspace: false,
        sessionId: "session-b",
        targetPath: "/workspace/b/src/output.txt",
      }).promise,
    ).resolves.toMatchObject({ decision: "accept" });

    expect(resolveProjectContext).toHaveBeenCalledTimes(1);
    expect(resolveProjectContext).toHaveBeenCalledWith({
      sessionId: "session-b",
      targetPath: "/workspace/b/src/output.txt",
    });
    expect(shownRequest).toMatchObject({
      sourceProject: {
        projectId: "project-b",
        displayName: "Project B",
        availability: "available",
      },
      targetPath: "/workspace/b/src/output.txt",
    });
  });

  it("does not reuse a recent command approval across source projects", async () => {
    const { provider } = createProvider(projectContext);
    const shownProjects: string[] = [];

    provider.onForwardApproval = (request, respond) => {
      shownProjects.push(request.sourceProject?.projectId ?? "unscoped");
      respond({ type: "decision", id: request.id, decision: "run-once" });
    };

    await expect(
      provider.enqueueCommandApproval("npm test", "npm test", {
        sessionId: "session-a",
      }).promise,
    ).resolves.toEqual({ decision: "run-once" });
    await expect(
      provider.enqueueCommandApproval("npm test", "npm test", {
        sessionId: "session-b",
      }).promise,
    ).resolves.toEqual({ decision: "run-once" });

    expect(shownProjects).toEqual(["project-a", "project-b"]);
  });

  it("does not reuse a queued path approval across source projects", async () => {
    const { provider } = createProvider(projectContext);
    const shownProjects: string[] = [];
    let firstPending:
      | { id: string; respond: (msg: DecisionMessage) => void }
      | undefined;

    provider.onForwardApproval = (request, respond) => {
      shownProjects.push(request.sourceProject?.projectId ?? "unscoped");
      if (!firstPending) {
        firstPending = { id: request.id, respond };
        return;
      }
      respond({ type: "decision", id: request.id, decision: "allow-once" });
    };

    const first = provider.enqueuePathApproval(
      "/outside/shared/a.txt",
      "session-a",
    ).promise;
    const second = provider.enqueuePathApproval(
      "/outside/shared/b.txt",
      "session-b",
    ).promise;

    firstPending!.respond({
      type: "decision",
      id: firstPending!.id,
      decision: "allow-once",
    });

    await expect(first).resolves.toEqual({ decision: "allow-once" });
    await expect(second).resolves.toEqual({ decision: "allow-once" });
    expect(shownProjects).toEqual(["project-a", "project-b"]);
  });

  it("reads recent approval TTL from the source project resource", async () => {
    getConfiguration.mockImplementation((...args: unknown[]) => {
      const resource = args[1] as { toString: () => string } | undefined;
      return {
        get: vi.fn((_key: string, fallback?: unknown) =>
          resource?.toString() === "file:///workspace/a" ? 0 : fallback,
        ),
      };
    });
    const { provider } = createProvider(projectContext);
    const shownProjects: string[] = [];

    provider.onForwardApproval = (request, respond) => {
      shownProjects.push(request.sourceProject?.projectId ?? "unscoped");
      respond({ type: "decision", id: request.id, decision: "run-once" });
    };

    await provider.enqueueCommandApproval("npm test", "npm test", {
      sessionId: "session-a",
    }).promise;
    await provider.enqueueCommandApproval("npm test", "npm test", {
      sessionId: "session-a",
    }).promise;

    expect(shownProjects).toEqual(["project-a", "project-a"]);
    expect(getConfiguration).toHaveBeenCalledWith(
      "agentlink",
      expect.objectContaining({
        toString: expect.any(Function),
      }),
    );
    getConfiguration.mockImplementation(() => configuration);
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
