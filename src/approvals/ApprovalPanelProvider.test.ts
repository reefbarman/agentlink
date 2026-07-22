import * as vscode from "vscode";

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
  const alertDisposable = { dispose: vi.fn() };
  const statusBarManager = {
    setPendingCount: vi.fn(),
    showAlert: vi.fn(() => alertDisposable),
  };
  return {
    alertDisposable,
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

describe("ApprovalPanelProvider forwarded approval attention", () => {
  it("shows a status-bar alert until an inline chat approval is resolved", async () => {
    const { provider, statusBarManager, alertDisposable } = createProvider();
    let pending:
      | { request: ApprovalRequest; respond: (msg: DecisionMessage) => void }
      | undefined;
    provider.onForwardApproval = (request, respond) => {
      pending = { request, respond };
    };

    const approval = provider.enqueueCommandApproval("npm test", "npm test");

    expect(statusBarManager.showAlert).toHaveBeenCalledWith(
      "Command approval required",
    );
    expect(alertDisposable.dispose).not.toHaveBeenCalled();

    pending!.respond({
      type: "decision",
      id: pending!.request.id,
      approvalKind: pending!.request.kind,
      decision: "run-once",
    });

    await expect(approval.promise).resolves.toEqual({ decision: "run-once" });
    expect(alertDisposable.dispose).toHaveBeenCalledOnce();
    expect(statusBarManager.setPendingCount).toHaveBeenLastCalledWith(0);
  });
});

describe("ApprovalPanelProvider command rule decisions", () => {
  it("rejects malformed rule decisions and preserves valid tri-state rules", async () => {
    const { provider } = createProvider();
    let pending:
      | { request: ApprovalRequest; respond: (msg: DecisionMessage) => boolean }
      | undefined;
    provider.onForwardApproval = (request, respond) => {
      pending = { request, respond };
    };

    const approval = provider.enqueueCommandApproval(
      "npm publish",
      "npm publish",
    );
    expect(
      pending!.respond({
        type: "decision",
        id: approval.id,
        approvalKind: "command",
        decision: "run-once",
        rules: [
          {
            pattern: "npm publish",
            mode: "exact",
            decision: "grant-all",
            scope: "project",
          } as never,
        ],
      }),
    ).toBe(false);

    const rules = [
      {
        pattern: "npm publish",
        mode: "exact" as const,
        scope: "project" as const,
      },
    ];
    expect(
      pending!.respond({
        type: "decision",
        id: approval.id,
        approvalKind: "command",
        decision: "run-once",
        rules,
      }),
    ).toBe(true);
    await expect(approval.promise).resolves.toEqual({
      decision: "run-once",
      rules,
    });
  });
});

describe("ApprovalPanelProvider command security projection", () => {
  it("forwards token-free security and project attribution together", async () => {
    const { provider } = createProvider(projectContext);
    let shown: ApprovalRequest | undefined;
    provider.onForwardApproval = (request, respond) => {
      shown = request;
      respond({
        type: "decision",
        id: request.id,
        approvalKind: request.kind,
        decision: "run-once",
      });
    };
    const security = {
      auditId: "audit-1",
      route: "sandbox" as const,
      confinement: "verified-baseline" as const,
      routeReason: "verified-local-macos" as const,
      executionSurface: "verified-sandbox" as const,
      requiredAuthority: "sandbox" as const,
      permissionIntent: "default" as const,
      approvalRequirement: "policy" as const,
      authorityReason: "approval-policy" as const,
      approvalPolicySnapshot: "on-request" as const,
      approvalReviewerSnapshot: "auto-review" as const,
      executionPresetSnapshot: "workspace-write" as const,
      commandApprovalPolicySnapshot: "approve-for-me" as const,
      executionPolicy: "sandbox-baseline-v2" as const,
      preparedAt: 100,
      sandbox: {
        attestationId: "attestation-1",
        attestationVersion: "sandbox-behavior-v2",
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
          privateTmp: false,
          hostIpcBlocked: false,
          resourceLimits: "partial" as const,
          warnings: [],
        },
      },
    };

    await expect(
      provider.enqueueCommandApproval("npm test", "npm test", {
        cwd: "/workspace",
        security,
        sessionId: "session-b",
      }).promise,
    ).resolves.toMatchObject({ decision: "run-once" });

    expect(shown?.security).toBe(security);
    expect(shown?.sourceProject?.projectId).toBe("project-b");
    expect(shown).not.toHaveProperty("sandboxCapabilityRequest");
    expect(shown).not.toHaveProperty("bindingDigest");
  });
});

describe("ApprovalPanelProvider project attribution", () => {
  it("snapshots resolved project context once when the request is enqueued", async () => {
    const resolveProjectContext = vi.fn(projectContext);
    const { provider } = createProvider(resolveProjectContext);
    let shownRequest: ApprovalRequest | undefined;

    provider.onForwardApproval = (request, respond) => {
      shownRequest = request;
      respond({
        type: "decision",
        id: request.id,
        approvalKind: request.kind,
        decision: "accept",
      });
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

  it("does not reuse a deferred command approval until it is committed", async () => {
    const { provider } = createProvider(projectContext);
    const shown: string[] = [];

    provider.onForwardApproval = (request, respond) => {
      shown.push(request.command ?? "");
      respond({
        type: "decision",
        id: request.id,
        approvalKind: request.kind,
        decision: "run-once",
      });
    };

    const first = provider.enqueueCommandApproval("npm test", "npm test", {
      sessionId: "session-a",
      deferApprovalRecording: true,
    });
    await expect(first.promise).resolves.toEqual({ decision: "run-once" });
    expect(
      provider.isRecentlyApproved("command", "npm test", "project-a"),
    ).toBe(false);

    first.commitApprovalRecording();
    first.commitApprovalRecording();
    expect(
      provider.isRecentlyApproved("command", "npm test", "project-a"),
    ).toBe(true);

    await expect(
      provider.enqueueCommandApproval("npm test", "npm test", {
        sessionId: "session-a",
      }).promise,
    ).resolves.toEqual({ decision: "run-once", recentApproval: true });
    expect(shown).toEqual(["npm test"]);
  });

  it("bypasses a matching recent approval when a fresh decision is required", async () => {
    const { provider } = createProvider(projectContext);
    const shown: string[] = [];

    provider.onForwardApproval = (request, respond) => {
      shown.push(request.command ?? "");
      respond({
        type: "decision",
        id: request.id,
        approvalKind: request.kind,
        decision: "run-once",
      });
    };

    const first = provider.enqueueCommandApproval(
      "dotnet build",
      "dotnet build",
      {
        sessionId: "session-a",
        deferApprovalRecording: true,
      },
    );
    await expect(first.promise).resolves.toEqual({ decision: "run-once" });
    first.commitApprovalRecording();

    await expect(
      provider.enqueueCommandApproval("dotnet build", "dotnet build", {
        sessionId: "session-a",
        bypassRecentApproval: true,
      }).promise,
    ).resolves.toEqual({ decision: "run-once" });

    expect(shown).toEqual(["dotnet build", "dotnet build"]);
  });

  it("does not reuse a recent command approval across authority or permission intent", async () => {
    const { provider } = createProvider(projectContext);
    const shownAuthorities: string[] = [];
    const securityFor = (
      requiredAuthority: "sandbox" | "native-agent",
      permissionIntent:
        | "default"
        | "additional-permissions"
        | "native-escalation" = requiredAuthority === "sandbox"
        ? "default"
        : "native-escalation",
    ) => ({
      auditId: `audit-${requiredAuthority}-${permissionIntent}`,
      route:
        requiredAuthority === "sandbox"
          ? ("sandbox" as const)
          : ("native" as const),
      confinement:
        requiredAuthority === "sandbox"
          ? ("verified-baseline" as const)
          : ("native-unsandboxed" as const),
      routeReason: "verified-local-macos" as const,
      executionSurface:
        requiredAuthority === "sandbox"
          ? ("verified-sandbox" as const)
          : ("agentlink-native" as const),
      requiredAuthority,
      permissionIntent,
      approvalRequirement:
        requiredAuthority === "sandbox"
          ? ("policy" as const)
          : ("explicit-escalation" as const),
      authorityReason:
        requiredAuthority === "sandbox"
          ? ("approval-policy" as const)
          : ("explicit-escalation" as const),
      approvalPolicySnapshot: "on-request" as const,
      approvalReviewerSnapshot: "auto-review" as const,
      executionPresetSnapshot: "workspace-write" as const,
      commandApprovalPolicySnapshot: "approve-for-me" as const,
      executionPolicy:
        requiredAuthority === "sandbox"
          ? ("sandbox-baseline-v2" as const)
          : ("native-legacy-v1" as const),
      preparedAt: 100,
    });

    provider.onForwardApproval = (request, respond) => {
      shownAuthorities.push(
        `${request.security?.requiredAuthority ?? "unspecified"}:${request.security?.permissionIntent ?? "unspecified"}`,
      );
      respond({
        type: "decision",
        id: request.id,
        approvalKind: request.kind,
        decision: "run-once",
      });
    };

    await provider.enqueueCommandApproval("npm test", "npm test", {
      sessionId: "session-a",
      security: securityFor("sandbox"),
    }).promise;
    await provider.enqueueCommandApproval("npm test", "npm test", {
      sessionId: "session-a",
      security: securityFor("sandbox", "additional-permissions"),
    }).promise;
    await provider.enqueueCommandApproval("npm test", "npm test", {
      sessionId: "session-a",
      security: securityFor("native-agent"),
    }).promise;
    await expect(
      provider.enqueueCommandApproval("npm test", "npm test", {
        sessionId: "session-a",
        security: securityFor("native-agent"),
      }).promise,
    ).resolves.toEqual({ decision: "run-once", recentApproval: true });

    expect(shownAuthorities).toEqual([
      "sandbox:default",
      "sandbox:additional-permissions",
      "native-agent:native-escalation",
    ]);
  });

  it("does not reuse a recent command approval across source projects", async () => {
    const { provider } = createProvider(projectContext);
    const shownProjects: string[] = [];

    provider.onForwardApproval = (request, respond) => {
      shownProjects.push(request.sourceProject?.projectId ?? "unscoped");
      respond({
        type: "decision",
        id: request.id,
        approvalKind: request.kind,
        decision: "run-once",
      });
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
      | {
          id: string;
          kind: ApprovalRequest["kind"];
          respond: (msg: DecisionMessage) => boolean;
        }
      | undefined;

    provider.onForwardApproval = (request, respond) => {
      shownProjects.push(request.sourceProject?.projectId ?? "unscoped");
      if (!firstPending) {
        firstPending = { id: request.id, kind: request.kind, respond };
        return;
      }
      respond({
        type: "decision",
        id: request.id,
        approvalKind: request.kind,
        decision: "allow-once",
      });
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
      approvalKind: firstPending!.kind,
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
      respond({
        type: "decision",
        id: request.id,
        approvalKind: request.kind,
        decision: "run-once",
      });
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

describe("ApprovalPanelProvider network approvals", () => {
  const request = {
    requestId: "network-1",
    sessionId: "session-a",
    auditId: "audit-1",
    terminalId: "sandbox-1",
    commandId: "command-1",
    generation: 1,
    command: "npm view example version",
    cwd: "/workspace",
    reason: "Managed public network requested",
    host: "registry.npmjs.org",
    protocol: "https" as const,
    port: 443,
    address: "104.16.24.34",
    family: 4 as const,
    dnsAnswers: [{ address: "104.16.24.34", family: 4 as const }],
    destinationClass: "public" as const,
  };

  it("forwards structured destination evidence and never reuses allow-once", async () => {
    const { provider, statusBarManager } = createProvider(projectContext);
    const shown: ApprovalRequest[] = [];
    provider.onForwardApproval = (approval, respond) => {
      shown.push(approval);
      respond({
        type: "decision",
        id: approval.id,
        approvalKind: approval.kind,
        decision: "allow-once",
      });
    };

    await expect(
      provider.enqueueNetworkApproval({ request }).promise,
    ).resolves.toEqual({ decision: "allow-once" });
    await expect(
      provider.enqueueNetworkApproval({ request }).promise,
    ).resolves.toEqual({ decision: "allow-once" });

    expect(shown).toHaveLength(2);
    expect(shown[0]).toMatchObject({
      kind: "network",
      sourceProject: { projectId: "project-a" },
      managedNetwork: request,
      command: request.command,
      cwd: request.cwd,
    });
    expect(shown[0].managedNetwork?.dnsAnswers).not.toBe(request.dnsAnswers);
    expect(statusBarManager.showAlert).toHaveBeenCalledWith(
      "Network approval required",
    );
  });

  it("rejects mismatched kinds and accepts only network decisions", async () => {
    const { provider } = createProvider();
    let pending:
      | {
          request: ApprovalRequest;
          respond: (message: DecisionMessage) => boolean;
        }
      | undefined;
    provider.onForwardApproval = (approval, respond) => {
      pending = { request: approval, respond };
    };
    const approval = provider.enqueueNetworkApproval({ request });

    expect(
      pending!.respond({
        type: "decision",
        id: pending!.request.id,
        approvalKind: "command",
        decision: "allow-once",
      }),
    ).toBe(false);
    expect(
      pending!.respond({
        type: "decision",
        id: pending!.request.id,
        approvalKind: "network",
        decision: "run-once",
      }),
    ).toBe(false);
    expect(
      pending!.respond({
        type: "decision",
        id: pending!.request.id,
        approvalKind: "network",
        decision: "allow-project",
      }),
    ).toBe(true);
    await expect(approval.promise).resolves.toEqual({
      decision: "allow-project",
    });
  });

  it("rejects a pending live destination when its signal is aborted", async () => {
    const { provider } = createProvider();
    const controller = new AbortController();
    provider.onForwardApproval = vi.fn();
    const approval = provider.enqueueNetworkApproval({
      request,
      signal: controller.signal,
    });

    controller.abort();
    await expect(approval.promise).resolves.toEqual({ decision: "reject" });
  });
});

describe("ApprovalPanelProvider cancellation", () => {
  it("removes an aborted current approval and clears the pending badge", async () => {
    const { provider, statusBarManager } = createProvider();
    const controller = new AbortController();
    const cancelled = vi.fn();
    const idle = vi.fn();
    provider.onForwardApproval = vi.fn();
    provider.onForwardApprovalCancelled = cancelled;
    provider.onForwardApprovalIdle = idle;

    const { promise, id } = provider.enqueuePathApproval(
      "/outside/current.txt",
      "session-1",
      controller.signal,
    );
    controller.abort();

    await expect(promise).resolves.toEqual({ decision: "reject" });
    expect(cancelled).toHaveBeenCalledWith(id);
    expect(statusBarManager.setPendingCount).toHaveBeenLastCalledWith(0);
    expect(idle).toHaveBeenCalledOnce();
  });

  it("removes only the aborted queued approval", async () => {
    const { provider, statusBarManager } = createProvider();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const cancelled = vi.fn();
    let firstApproval:
      | { request: ApprovalRequest; respond: (msg: DecisionMessage) => void }
      | undefined;
    provider.onForwardApproval = (request, respond) => {
      firstApproval = { request, respond };
    };
    provider.onForwardApprovalCancelled = cancelled;

    const first = provider.enqueuePathApproval(
      "/outside/first/a.txt",
      "session-1",
      firstController.signal,
    );
    const second = provider.enqueuePathApproval(
      "/outside/second/b.txt",
      "session-1",
      secondController.signal,
    );

    secondController.abort();
    await expect(second.promise).resolves.toEqual({ decision: "reject" });
    expect(cancelled).toHaveBeenCalledWith(second.id);
    expect(statusBarManager.setPendingCount).toHaveBeenLastCalledWith(0);

    firstApproval!.respond({
      type: "decision",
      id: firstApproval!.request.id,
      approvalKind: firstApproval!.request.kind,
      decision: "allow-once",
    });
    await expect(first.promise).resolves.toEqual({ decision: "allow-once" });
  });

  it("does not enqueue an approval when already aborted", async () => {
    const { provider, statusBarManager } = createProvider();
    const controller = new AbortController();
    controller.abort();
    provider.onForwardApproval = vi.fn();

    await expect(
      provider.enqueuePathApproval(
        "/outside/aborted.txt",
        "session-1",
        controller.signal,
      ).promise,
    ).resolves.toEqual({ decision: "reject" });
    expect(provider.onForwardApproval).not.toHaveBeenCalled();
    expect(statusBarManager.setPendingCount).not.toHaveBeenCalled();
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
      approvalKind: pendingApproval!.request.kind,
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
      respond({
        type: "decision",
        id: request.id,
        approvalKind: request.kind,
        decision: "allow-once",
      });
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
      respond({
        type: "decision",
        id: request.id,
        approvalKind: request.kind,
        decision: "allow-once",
      });
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
      approvalKind: pendingApproval!.request.kind,
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
