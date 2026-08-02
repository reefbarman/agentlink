import * as vscode from "vscode";

import type { ApprovalRequest, DecisionMessage } from "./webview/types.js";
import { describe, expect, it, vi } from "vitest";

import { ApprovalPanelProvider } from "./ApprovalPanelProvider.js";
import type { TerminalExecutionSecuritySummary } from "../core/capabilities/terminal.js";

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

describe("requeueCommandApprovalsForPolicyChange", () => {
  it("re-resolves the session's pending command approvals and advances the queue", async () => {
    const { provider } = createProvider();
    const forwarded: ApprovalRequest[] = [];
    const cancelled: string[] = [];
    provider.onForwardApproval = ({ request }) => {
      forwarded.push(request);
    };
    provider.onForwardApprovalCancelled = (_sessionId, id) =>
      cancelled.push(id);

    const first = provider.enqueueCommandApproval("npm test", "npm test", {
      sessionId: "session-a",
    });
    const second = provider.enqueueCommandApproval(
      "npm run build",
      "npm run build",
      { sessionId: "session-a" },
    );
    const other = provider.enqueueCommandApproval("ls", "ls", {
      sessionId: "session-b",
    });
    expect(forwarded.map((request) => request.id)).toEqual([first.id]);

    const resolved = provider.requeueCommandApprovalsForPolicyChange(
      "session-a",
      "Policy changed; retry the command.",
    );

    expect(resolved).toBe(2);
    await expect(first.promise).resolves.toEqual({
      decision: "reject",
      rejectionReason: "Policy changed; retry the command.",
    });
    await expect(second.promise).resolves.toEqual({
      decision: "reject",
      rejectionReason: "Policy changed; retry the command.",
    });
    expect([...cancelled].sort()).toEqual([first.id, second.id].sort());

    // The untouched session's command becomes the visible card.
    expect(forwarded.map((request) => request.id)).toEqual([
      first.id,
      other.id,
    ]);
    provider.dispose();
  });

  it("leaves other sessions and non-command approvals pending", () => {
    const { provider } = createProvider();
    const cancelled: string[] = [];
    provider.onForwardApproval = () => {};
    provider.onForwardApprovalCancelled = (_sessionId, id) =>
      cancelled.push(id);

    provider.enqueueWriteApproval("src/file.ts", {
      operation: "modify",
      outsideWorkspace: false,
      sessionId: "session-a",
    });
    provider.enqueueCommandApproval("ls", "ls", { sessionId: "session-b" });

    expect(
      provider.requeueCommandApprovalsForPolicyChange(
        "session-a",
        "Policy changed; retry the command.",
      ),
    ).toBe(0);
    expect(cancelled).toEqual([]);
    provider.dispose();
  });
});

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

describe("ApprovalPanelProvider coordinator preflight", () => {
  it("resolves a coordinator one-shot decision before human UI or status attention", async () => {
    vi.mocked(vscode.commands.executeCommand).mockClear();
    const { provider, statusBarManager } = createProvider();
    const forwarded = vi.fn();
    provider.onForwardApproval = forwarded;
    provider.onBeforeApproval = vi.fn(async ({ request }) => {
      expect(request).toMatchObject({
        kind: "path",
        filePath: "/outside/file.txt",
      });
      return { action: "resolve", decision: "approve-once" } as const;
    });

    await expect(
      provider.enqueuePathApproval("/outside/file.txt", "background-1").promise,
    ).resolves.toEqual({
      decision: "allow-once",
      coordinatorApproval: true,
    });

    expect(forwarded).not.toHaveBeenCalled();
    expect(statusBarManager.showAlert).not.toHaveBeenCalled();
    expect(statusBarManager.setPendingCount).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("cancels an unresolved coordinator preflight without later showing human attention", async () => {
    const { provider, statusBarManager } = createProvider();
    let finishPreflight!: (result: {
      action: "escalate";
      backgroundTask?: string;
    }) => void;
    provider.onBeforeApproval = () =>
      new Promise((resolve) => {
        finishPreflight = resolve;
      });
    provider.onForwardApproval = vi.fn();

    const approval = provider.enqueuePathApproval(
      "/outside/file.txt",
      "background-1",
    );
    await Promise.resolve();
    provider.cancelApproval(approval.id);

    await expect(approval.promise).resolves.toEqual({ decision: "reject" });
    finishPreflight({ action: "escalate", backgroundTask: "late task" });
    await Promise.resolve();
    expect(provider.onForwardApproval).not.toHaveBeenCalled();
    expect(statusBarManager.showAlert).not.toHaveBeenCalled();
    expect(statusBarManager.setPendingCount).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("disposes an unresolved coordinator preflight without later showing human attention", async () => {
    const { provider, statusBarManager } = createProvider();
    let finishPreflight!: (result: { action: "escalate" }) => void;
    provider.onBeforeApproval = () =>
      new Promise((resolve) => {
        finishPreflight = resolve;
      });
    provider.onForwardApproval = vi.fn();

    const approval = provider.enqueuePathApproval(
      "/outside/file.txt",
      "background-1",
    );
    await Promise.resolve();
    provider.dispose();

    await expect(approval.promise).resolves.toEqual({ decision: "reject" });
    finishPreflight({ action: "escalate" });
    await Promise.resolve();
    expect(provider.onForwardApproval).not.toHaveBeenCalled();
    expect(statusBarManager.showAlert).not.toHaveBeenCalled();
  });

  it("fails closed when preflight tries to auto-approve an unsupported kind", async () => {
    const { provider, statusBarManager } = createProvider();
    provider.onBeforeApproval = vi.fn(async () => ({
      action: "resolve" as const,
      decision: "approve-once" as const,
    }));
    provider.onForwardApproval = vi.fn();

    await expect(
      provider.enqueueMemoryApproval({
        tier: "memory",
        scope: "project",
        operation: "add",
        title: "Remember preference",
        rationale: "Requested by the user",
        targetPath: "/workspace/memory.md",
        sessionId: "background-1",
      }).promise,
    ).resolves.toEqual({ decision: "reject" });
    expect(provider.onForwardApproval).not.toHaveBeenCalled();
    expect(statusBarManager.showAlert).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("does not enter the human queue when a coordinator wait is aborted", async () => {
    const { provider, statusBarManager } = createProvider();
    const controller = new AbortController();
    const forwarded = vi.fn();
    provider.onForwardApproval = forwarded;
    provider.onBeforeApproval = ({ signal }) =>
      new Promise((resolve) => {
        signal?.addEventListener(
          "abort",
          () => resolve({ action: "resolve", decision: "reject" }),
          { once: true },
        );
      });

    const approval = provider.enqueuePathApproval(
      "/outside/file.txt",
      "background-1",
      controller.signal,
    );
    controller.abort();

    await expect(approval.promise).resolves.toEqual({ decision: "reject" });
    expect(forwarded).not.toHaveBeenCalled();
    expect(statusBarManager.showAlert).not.toHaveBeenCalled();
    expect(statusBarManager.setPendingCount).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("shows the original standard card and status attention only after escalation", async () => {
    const { provider, statusBarManager } = createProvider();
    let pending:
      | {
          request: ApprovalRequest;
          respond: (message: DecisionMessage) => boolean;
        }
      | undefined;
    provider.onBeforeApproval = vi.fn(
      async () =>
        ({
          action: "escalate",
          backgroundTask: "Inspect outside docs",
        }) as const,
    );
    provider.onForwardApproval = ({ request }, respond) => {
      pending = { request, respond };
    };

    const approval = provider.enqueuePathApproval(
      "/outside/file.txt",
      "background-1",
    );
    await vi.waitFor(() => expect(pending).toBeDefined());

    expect(pending!.request).toMatchObject({
      id: approval.id,
      kind: "path",
      filePath: "/outside/file.txt",
      backgroundTask: "Inspect outside docs",
    });
    expect(statusBarManager.showAlert).toHaveBeenCalledWith(
      "Path access approval required",
      expect.objectContaining({
        command: "agentLink.focusApproval",
        arguments: [{ sessionId: "background-1" }],
      }),
    );
    expect(statusBarManager.setPendingCount).toHaveBeenCalledWith(1);

    expect(
      pending!.respond({
        type: "decision",
        id: approval.id,
        approvalKind: "path",
        decision: "allow-session",
        rulePattern: "/outside/file.txt",
        ruleMode: "exact",
      }),
    ).toBe(true);
    await expect(approval.promise).resolves.toEqual(
      expect.objectContaining({ decision: "allow-session" }),
    );
    provider.dispose();
  });

  it("passes human-only classification to preflight without coordinator resolution", async () => {
    const { provider } = createProvider();
    let pending:
      | {
          request: ApprovalRequest;
          respond: (message: DecisionMessage) => boolean;
        }
      | undefined;
    const onBeforeApproval = vi.fn(async ({ request }) => {
      expect(request.humanOnlyReason).toBe("credential-store");
      return { action: "escalate" as const };
    });
    provider.onBeforeApproval = onBeforeApproval;
    provider.onForwardApproval = ({ request }, respond) => {
      pending = { request, respond };
    };

    const approval = provider.enqueuePathApproval(
      "/outside/.ssh/config",
      "background-1",
      undefined,
      "credential-store",
    );
    await vi.waitFor(() => expect(pending).toBeDefined());

    expect(onBeforeApproval).toHaveBeenCalledOnce();
    expect(pending!.request.humanOnlyReason).toBe("credential-store");
    pending!.respond({
      type: "decision",
      id: approval.id,
      approvalKind: "path",
      decision: "reject",
    });
    await expect(approval.promise).resolves.toEqual(
      expect.objectContaining({ decision: "reject" }),
    );
    provider.dispose();
  });
});

describe("ApprovalPanelProvider forwarded approval attention", () => {
  it("shows a status-bar alert until an inline chat approval is resolved", async () => {
    const { provider, statusBarManager, alertDisposable } = createProvider();
    let pending:
      | { request: ApprovalRequest; respond: (msg: DecisionMessage) => void }
      | undefined;
    provider.onForwardApproval = ({ request }, respond) => {
      pending = { request, respond };
    };

    const approval = provider.enqueueCommandApproval("npm test", "npm test", {
      sessionId: "session-1",
    });

    expect(statusBarManager.showAlert).toHaveBeenCalledWith(
      "Command approval required",
      expect.objectContaining({
        command: "agentLink.focusApproval",
        arguments: [{ sessionId: "session-1" }],
      }),
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
    provider.onForwardApproval = ({ request }, respond) => {
      pending = { request, respond };
    };

    const approval = provider.enqueueCommandApproval(
      "npm publish",
      "npm publish",
      { sessionId: "session-1" },
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
    provider.onForwardApproval = ({ request }, respond) => {
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

    provider.onForwardApproval = ({ request }, respond) => {
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

    provider.onForwardApproval = ({ request }, respond) => {
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
      provider.isRecentlyApproved(
        "command",
        "npm test",
        "project-a",
        "unspecified",
        "unspecified",
        "session-a",
      ),
    ).toBe(false);

    first.commitApprovalRecording();
    first.commitApprovalRecording();
    expect(
      provider.isRecentlyApproved(
        "command",
        "npm test",
        "project-a",
        "unspecified",
        "unspecified",
        "session-a",
      ),
    ).toBe(true);

    await expect(
      provider.enqueueCommandApproval("npm test", "npm test", {
        sessionId: "session-a",
      }).promise,
    ).resolves.toEqual({ decision: "run-once", recentApproval: true });
    expect(shown).toEqual(["npm test"]);
  });

  it("does not retain a one-time command approval when recording is disabled", async () => {
    const { provider } = createProvider(projectContext);
    const shown: string[] = [];

    provider.onForwardApproval = ({ request }, respond) => {
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
      skipApprovalRecording: true,
    });
    await expect(first.promise).resolves.toEqual({ decision: "run-once" });
    first.commitApprovalRecording();

    expect(
      provider.isRecentlyApproved(
        "command",
        "npm test",
        "project-a",
        "unspecified",
        "unspecified",
        "session-a",
      ),
    ).toBe(false);

    await expect(
      provider.enqueueCommandApproval("npm test", "npm test", {
        sessionId: "session-a",
      }).promise,
    ).resolves.toEqual({ decision: "run-once" });
    expect(shown).toEqual(["npm test", "npm test"]);
  });

  it("reuses only the exact committed command approval identity during preflight", async () => {
    const { provider, statusBarManager } = createProvider(projectContext);
    const forwarded: ApprovalRequest[] = [];
    const security: TerminalExecutionSecuritySummary = {
      auditId: "audit-recent-preflight",
      route: "native" as const,
      executionSurface: "agentlink-native" as const,
      confinement: "native-unsandboxed" as const,
      routeReason: "verified-local-macos" as const,
      requiredAuthority: "native-agent" as const,
      permissionIntent: "native-escalation" as const,
      approvalRequirement: "explicit-escalation" as const,
      authorityReason: "explicit-escalation" as const,
      approvalPolicySnapshot: "on-request" as const,
      approvalReviewerSnapshot: "auto-review" as const,
      executionPresetSnapshot: "native-manual" as const,
      commandApprovalPolicySnapshot: "approve-for-me" as const,
      executionPolicy: "native-legacy-v1" as const,
      preparedAt: 100,
    };

    provider.onForwardApproval = ({ request }, respond) => {
      forwarded.push(request);
      respond({
        type: "decision",
        id: request.id,
        approvalKind: request.kind,
        decision: "run-once",
      });
    };

    const approval = provider.enqueueCommandApproval("npm test", "npm test", {
      sessionId: "session-a",
      cwd: "/workspace/a",
      security,
      commandPolicyFingerprint: "policy-a",
      deferApprovalRecording: true,
    });
    await expect(approval.promise).resolves.toEqual({ decision: "run-once" });
    approval.commitApprovalRecording();

    const preflight = (
      overrides: {
        command?: string;
        cwd?: string;
        sessionId?: string;
        security?: typeof security;
        commandPolicyFingerprint?: string;
      } = {},
    ) =>
      provider.isCommandRecentlyApproved({
        command: overrides.command ?? "npm test",
        cwd: overrides.cwd ?? "/workspace/a",
        sessionId: overrides.sessionId ?? "session-a",
        security: overrides.security ?? security,
        commandPolicyFingerprint:
          overrides.commandPolicyFingerprint ?? "policy-a",
      });
    const forwardedCount = forwarded.length;
    const pendingCountCalls =
      statusBarManager.setPendingCount.mock.calls.length;

    expect(preflight()).toBe(true);
    expect(preflight({ command: "npm test -- --watch" })).toBe(false);
    expect(preflight({ cwd: "/workspace/b" })).toBe(false);
    expect(preflight({ sessionId: "session-b" })).toBe(false);
    expect(
      preflight({
        security: {
          ...security,
          requiredAuthority: "sandbox",
          permissionIntent: "default",
        },
      }),
    ).toBe(false);
    expect(
      preflight({
        security: { ...security, permissionIntent: "additional-permissions" },
      }),
    ).toBe(false);
    expect(preflight({ commandPolicyFingerprint: "policy-b" })).toBe(false);
    expect(forwarded).toHaveLength(forwardedCount);
    expect(statusBarManager.setPendingCount).toHaveBeenCalledTimes(
      pendingCountCalls,
    );
  });

  it("uses the attributed project's recent-approval TTL during preflight", async () => {
    getConfiguration.mockImplementation((...args: unknown[]) => ({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "recentApprovalTtl" &&
        (args[1] as { fsPath?: string } | undefined)?.fsPath === "/workspace/a"
          ? 0
          : fallback,
      ),
    }));
    try {
      const { provider } = createProvider(projectContext);
      provider.onForwardApproval = ({ request }, respond) => {
        respond({
          type: "decision",
          id: request.id,
          approvalKind: request.kind,
          decision: "run-once",
        });
      };
      const security = {
        requiredAuthority: "sandbox" as const,
        permissionIntent: "default" as const,
      } as never;
      const approval = provider.enqueueCommandApproval("npm test", "npm test", {
        sessionId: "session-a",
        cwd: "/workspace/a",
        security,
        commandPolicyFingerprint: "policy-a",
        deferApprovalRecording: true,
      });
      await approval.promise;
      approval.commitApprovalRecording();

      expect(
        provider.isCommandRecentlyApproved({
          command: "npm test",
          cwd: "/workspace/a",
          sessionId: "session-a",
          security,
          commandPolicyFingerprint: "policy-a",
        }),
      ).toBe(false);
      expect(getConfiguration).toHaveBeenCalledWith(
        "agentlink",
        expect.objectContaining({ fsPath: "/workspace/a" }),
      );
    } finally {
      getConfiguration.mockImplementation(
        (..._args: unknown[]) => configuration,
      );
    }
  });

  it("does not collide an unscoped cwd with a real path named unscoped", async () => {
    const { provider } = createProvider();
    const shownCwds: Array<string | undefined> = [];

    provider.onForwardApproval = ({ request }, respond) => {
      shownCwds.push(request.cwd);
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
      cwd: `${process.cwd()}/unscoped`,
    }).promise;

    expect(shownCwds).toEqual([undefined, `${process.cwd()}/unscoped`]);
  });

  it("does not reuse a recent command approval across sessions in the same project", async () => {
    const { provider } = createProvider(() => ({
      sourceProject: {
        projectId: "project-a",
        displayName: "Project A",
        availability: "available",
      },
      projectResourceUri: "file:///workspace/a",
    }));
    const shownCommands: string[] = [];

    provider.onForwardApproval = ({ request }, respond) => {
      shownCommands.push(request.command ?? "");
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

    expect(shownCommands).toEqual(["npm test", "npm test"]);
  });

  it("clears recent command and path approvals for retired sessions only", async () => {
    const { provider } = createProvider(projectContext);
    const shown: string[] = [];

    provider.onForwardApproval = ({ sessionId, request }, respond) => {
      shown.push(
        request.kind === "command"
          ? `${sessionId}:command:${request.command}`
          : `${sessionId}:path:${request.filePath}`,
      );
      respond({
        type: "decision",
        id: request.id,
        approvalKind: request.kind,
        decision: request.kind === "command" ? "run-once" : "allow-once",
      });
    };

    await provider.enqueueCommandApproval("npm test", "npm test", {
      sessionId: "session-a",
    }).promise;
    await provider.enqueueCommandApproval("npm test", "npm test", {
      sessionId: "session-b",
    }).promise;
    await provider.enqueuePathApproval(
      "/outside/shared/first-a.txt",
      "session-a",
    ).promise;
    await provider.enqueuePathApproval(
      "/outside/shared/first-b.txt",
      "session-b",
    ).promise;

    provider.clearRecentApprovalsForSessions(["session-a"]);

    await provider.enqueueCommandApproval("npm test", "npm test", {
      sessionId: "session-a",
    }).promise;
    await expect(
      provider.enqueueCommandApproval("npm test", "npm test", {
        sessionId: "session-b",
      }).promise,
    ).resolves.toEqual({ decision: "run-once", recentApproval: true });
    const recentPathApprovals = (
      provider as unknown as {
        recentPathApprovals: Array<{ sessionId?: string }>;
      }
    ).recentPathApprovals;

    expect(shown).toEqual([
      "session-a:command:npm test",
      "session-b:command:npm test",
      "session-a:path:/outside/shared/first-a.txt",
      "session-b:path:/outside/shared/first-b.txt",
      "session-a:command:npm test",
    ]);
    expect(recentPathApprovals.map((approval) => approval.sessionId)).toEqual([
      "session-b",
    ]);
  });

  it("bypasses a matching recent approval when a fresh decision is required", async () => {
    const { provider } = createProvider(projectContext);
    const shown: string[] = [];

    provider.onForwardApproval = ({ request }, respond) => {
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

    provider.onForwardApproval = ({ request }, respond) => {
      shownAuthorities.push(
        `${request.security?.requiredAuthority ?? "unspecified"}:${request.security?.permissionIntent ?? "unspecified"}:${request.cwd ?? "unscoped"}`,
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
    await provider.enqueueCommandApproval("npm test", "npm test", {
      sessionId: "session-a",
      cwd: "/workspace/other",
      security: securityFor("native-agent"),
    }).promise;
    await provider.enqueueCommandApproval("npm test", "npm test", {
      sessionId: "session-a",
      cwd: "/workspace/other",
      commandPolicyFingerprint: "policy-b",
      security: securityFor("native-agent"),
    }).promise;

    expect(shownAuthorities).toEqual([
      "sandbox:default:unscoped",
      "sandbox:additional-permissions:unscoped",
      "native-agent:native-escalation:unscoped",
      "native-agent:native-escalation:/workspace/other",
      "native-agent:native-escalation:/workspace/other",
    ]);
  });

  it("does not reuse a recent command approval across source projects", async () => {
    const { provider } = createProvider(projectContext);
    const shownProjects: string[] = [];

    provider.onForwardApproval = ({ request }, respond) => {
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

    provider.onForwardApproval = ({ request }, respond) => {
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

    provider.onForwardApproval = ({ request }, respond) => {
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
    provider.onForwardApproval = ({ request: approval }, respond) => {
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
      expect.objectContaining({
        command: "agentLink.focusApproval",
        arguments: [{ sessionId: "session-a" }],
      }),
    );
  });

  it("resolves queued same-session requests for the exact destination after allow once", async () => {
    const { provider } = createProvider(projectContext);
    const shown: Array<{
      request: ApprovalRequest;
      respond: (message: DecisionMessage) => boolean;
    }> = [];
    provider.onForwardApproval = ({ request: approval }, respond) => {
      shown.push({ request: approval, respond });
    };

    const first = provider.enqueueNetworkApproval({ request });
    const matching = provider.enqueueNetworkApproval({
      request: { ...request, requestId: "network-2" },
    });
    const anotherCommand = provider.enqueueNetworkApproval({
      request: {
        ...request,
        requestId: "network-other-command",
        commandId: "command-other",
      },
    });
    const otherHost = provider.enqueueNetworkApproval({
      request: {
        ...request,
        requestId: "network-other-host",
        commandId: "command-other-host",
        host: "example.com",
      },
    });
    await vi.waitFor(() => expect(shown).toHaveLength(1));

    shown[0].respond({
      type: "decision",
      id: first.id,
      approvalKind: "network",
      decision: "allow-once",
    });

    await expect(first.promise).resolves.toEqual({ decision: "allow-once" });
    await expect(matching.promise).resolves.toEqual({
      decision: "allow-once",
    });
    await vi.waitFor(() => expect(shown).toHaveLength(2));
    expect(shown[1].request.managedNetwork?.commandId).toBe("command-other");
    shown[1].respond({
      type: "decision",
      id: anotherCommand.id,
      approvalKind: "network",
      decision: "reject",
    });
    await expect(anotherCommand.promise).resolves.toEqual({
      decision: "reject",
    });
    await vi.waitFor(() => expect(shown).toHaveLength(3));
    expect(shown[2].request.managedNetwork?.host).toBe("example.com");
    shown[2].respond({
      type: "decision",
      id: otherHost.id,
      approvalKind: "network",
      decision: "reject",
    });
    await expect(otherHost.promise).resolves.toEqual({ decision: "reject" });
    provider.dispose();
  });

  it("resolves queued exact destinations within the selected project rule scope", async () => {
    const { provider } = createProvider(projectContext);
    const shown: Array<{
      request: ApprovalRequest;
      respond: (message: DecisionMessage) => boolean;
    }> = [];
    provider.onForwardApproval = ({ request: approval }, respond) => {
      shown.push({ request: approval, respond });
    };

    const first = provider.enqueueNetworkApproval({ request });
    const matching = provider.enqueueNetworkApproval({
      request: {
        ...request,
        requestId: "network-project-2",
        commandId: "command-2",
      },
    });
    await vi.waitFor(() => expect(shown).toHaveLength(1));

    shown[0].respond({
      type: "decision",
      id: first.id,
      approvalKind: "network",
      decision: "allow-project",
    });

    await expect(first.promise).resolves.toEqual({ decision: "allow-project" });
    await expect(matching.promise).resolves.toEqual({
      decision: "allow-project",
    });
    expect(shown).toHaveLength(1);
    provider.dispose();
  });

  it("rejects mismatched kinds and accepts only network decisions", async () => {
    const { provider } = createProvider();
    let pending:
      | {
          request: ApprovalRequest;
          respond: (message: DecisionMessage) => boolean;
        }
      | undefined;
    provider.onForwardApproval = ({ request: approval }, respond) => {
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
    let forwardedSessionId: string | undefined;
    provider.onForwardApproval = ({ sessionId }) => {
      forwardedSessionId = sessionId;
    };
    provider.onForwardApprovalCancelled = cancelled;

    const { promise, id } = provider.enqueuePathApproval(
      "/outside/current.txt",
      "session-1",
      controller.signal,
    );
    controller.abort();

    await expect(promise).resolves.toEqual({ decision: "reject" });
    expect(forwardedSessionId).toBe("session-1");
    expect(cancelled).toHaveBeenCalledWith("session-1", id);
    expect(statusBarManager.setPendingCount).toHaveBeenLastCalledWith(0);
  });

  it("removes only the aborted queued approval", async () => {
    const { provider, statusBarManager } = createProvider();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const cancelled = vi.fn();
    let firstApproval:
      | { request: ApprovalRequest; respond: (msg: DecisionMessage) => void }
      | undefined;
    provider.onForwardApproval = ({ request }, respond) => {
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
    expect(cancelled).toHaveBeenCalledWith("session-1", second.id);
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

    provider.onForwardApproval = ({ request }, respond) => {
      shownPaths.push(request.filePath ?? "");
      pendingApproval = { request, respond };
    };

    const first = provider.enqueuePathApproval(
      "/outside/sibling/a.txt",
      "session-1",
    ).promise;
    const second = provider.enqueuePathApproval(
      "/outside/sibling/b.txt",
      "session-1",
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

    provider.onForwardApproval = ({ request }, respond) => {
      shownPaths.push(request.filePath ?? "");
      respond({
        type: "decision",
        id: request.id,
        approvalKind: request.kind,
        decision: "allow-once",
      });
    };

    const first = provider.enqueuePathApproval(
      "/outside/one/a.txt",
      "session-1",
    ).promise;
    const second = provider.enqueuePathApproval(
      "/outside/two/b.txt",
      "session-1",
    ).promise;

    await expect(first).resolves.toEqual({ decision: "allow-once" });
    await expect(second).resolves.toEqual({ decision: "allow-once" });
    expect(shownPaths).toEqual(["/outside/one/a.txt", "/outside/two/b.txt"]);
  });

  it("does not reuse a queued path approval across sessions in the same project", async () => {
    const { provider } = createProvider(() => ({
      sourceProject: {
        projectId: "project-a",
        displayName: "Project A",
        availability: "available",
      },
      projectResourceUri: "file:///workspace/a",
    }));
    const shownPaths: string[] = [];
    let firstApproval:
      | {
          request: ApprovalRequest;
          respond: (msg: DecisionMessage) => void;
        }
      | undefined;

    provider.onForwardApproval = ({ request }, respond) => {
      shownPaths.push(request.filePath ?? "");
      if (!firstApproval) {
        firstApproval = { request, respond };
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
      "/outside/sibling/a.txt",
      "session-a",
    ).promise;
    const second = provider.enqueuePathApproval(
      "/outside/sibling/b.txt",
      "session-b",
    ).promise;

    firstApproval!.respond({
      type: "decision",
      id: firstApproval!.request.id,
      approvalKind: firstApproval!.request.kind,
      decision: "allow-once",
    });

    await expect(first).resolves.toEqual({ decision: "allow-once" });
    await expect(second).resolves.toEqual({ decision: "allow-once" });
    expect(shownPaths).toEqual([
      "/outside/sibling/a.txt",
      "/outside/sibling/b.txt",
    ]);
  });

  it("does not auto-approve later path requests after the queue drains", async () => {
    const { provider } = createProvider();
    const shownPaths: string[] = [];

    provider.onForwardApproval = ({ request }, respond) => {
      shownPaths.push(request.filePath ?? "");
      respond({
        type: "decision",
        id: request.id,
        approvalKind: request.kind,
        decision: "allow-once",
      });
    };

    await expect(
      provider.enqueuePathApproval("/outside/sibling/a.txt", "session-1")
        .promise,
    ).resolves.toEqual({ decision: "allow-once" });
    await expect(
      provider.enqueuePathApproval("/outside/sibling/b.txt", "session-1")
        .promise,
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
    provider.onForwardApproval = ({ request }, respond) => {
      shownPaths.push(request.filePath ?? "");
      pendingApproval = { request, respond };
    };

    const first = provider.enqueuePathApproval(
      "/outside/project/a.txt",
      "session-1",
    ).promise;
    const second = provider.enqueuePathApproval(
      "/outside/project/nested/b.txt",
      "session-1",
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
