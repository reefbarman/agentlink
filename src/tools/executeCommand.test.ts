import * as fs from "fs";
import * as os from "os";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { evaluateCommandRulePolicy } from "../approvals/commandRulePolicy.js";

const {
  getWorkspaceRoots,
  tryGetFirstWorkspaceRoot,
  validateCommand,
  validateInteractiveCommand,
  executeCommand,
  terminalProvider,
  getConfiguration,
} = vi.hoisted(() => ({
  getWorkspaceRoots: vi.fn(),
  tryGetFirstWorkspaceRoot: vi.fn(),
  validateCommand: vi.fn(),
  validateInteractiveCommand: vi.fn(),
  executeCommand: vi.fn(),
  terminalProvider: {
    prepareExecution: vi.fn(async (options, routeContext) => ({
      security: {
        auditId: "default-audit",
        route:
          routeContext.requiredAuthority === "sandbox"
            ? ("sandbox" as const)
            : ("native" as const),
        executionSurface:
          routeContext.requiredAuthority === "sandbox"
            ? ("verified-sandbox" as const)
            : ("agentlink-native" as const),
        confinement:
          routeContext.requiredAuthority === "sandbox"
            ? ("verified-baseline" as const)
            : ("native-unsandboxed" as const),
        routeReason: "verified-local-macos" as const,
        ...routeContext,
        executionPolicy:
          routeContext.requiredAuthority === "sandbox"
            ? ("sandbox-baseline-v2" as const)
            : ("native-legacy-v1" as const),
        preparedAt: 100,
      },
      execute: async () => terminalProvider.executeCommand(options),
      dispose: vi.fn(),
    })),
    executeCommand: vi.fn((options) => executeCommand(options)),
    getBackgroundState: vi.fn(),
    interruptTerminal: vi.fn(),
    getRecentlyClosedTerminals: vi.fn(),
    listTerminals: vi.fn(),
    closeTerminals: vi.fn(),
  },
  getConfiguration: vi.fn(() => ({
    get: vi.fn((key: string, fallback?: unknown) => {
      if (key === "masterBypass") return true;
      return fallback;
    }),
  })),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration,
  },
}));

vi.mock("../util/paths.js", () => ({
  canonicalizePath: (inputPath: string) => inputPath,
  getWorkspaceRoots,
  isPathWithinRoot: (filePath: string, rootPath: string) =>
    filePath === rootPath || filePath.startsWith(`${rootPath}/`),
  tryGetFirstWorkspaceRoot,
}));

vi.mock("../util/pipeValidator.js", () => ({
  validateCommand,
}));

vi.mock("../util/interactiveValidator.js", () => ({
  validateInteractiveCommand,
}));

function textPayload(result: {
  content: Array<{ type: string; text?: string }>;
}) {
  const textItem = result.content[0];
  expect(textItem.type).toBe("text");
  if (textItem.type !== "text" || typeof textItem.text !== "string") {
    throw new Error("Expected text result");
  }
  return JSON.parse(textItem.text);
}

describe("handleExecuteCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "masterBypass") return true;
        return fallback;
      }),
    });
    getWorkspaceRoots.mockReturnValue(["/workspace"]);
    tryGetFirstWorkspaceRoot.mockReturnValue("/workspace");
    validateCommand.mockReturnValue(null);
    validateInteractiveCommand.mockReturnValue(null);
    executeCommand.mockResolvedValue({
      exit_code: 0,
      output: "ok",
      output_captured: true,
      terminal_id: "term_1",
      command_sent: true,
    });
  });

  it("prepares exact execution before master bypass and consumes the same lease", async () => {
    const order: string[] = [];
    const execute = vi.fn(async () => {
      order.push("execute");
      return {
        exit_code: 0,
        output: "prepared",
        output_captured: true,
        terminal_id: "prepared-1",
      };
    });
    const dispose = vi.fn(() => order.push("dispose"));
    const prepareExecution = vi.fn(async () => {
      order.push("prepare");
      return {
        security: {
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
        },
        execute,
        dispose,
      };
    });
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "npm test" },
      { isCommandApproved: () => false } as never,
      { isRecentlyApproved: () => false } as never,
      "session-prepared-master",
      undefined,
      {
        terminalProvider: {
          ...terminalProvider,
          prepareExecution,
        },
      },
    );

    expect(order).toEqual(["prepare", "execute"]);
    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "npm test",
        cwd: "/workspace",
        sandboxSessionId: "session-prepared-master",
      }),
      {
        requiredAuthority: "native-agent",
        permissionIntent: "default",
        approvalRequirement: "policy",
        authorityReason: "approval-policy",
        approvalPolicySnapshot: "on-request" as const,
        approvalReviewerSnapshot: "user" as const,
        executionPresetSnapshot: "native-manual" as const,
        commandApprovalPolicySnapshot: "manual",
      },
    );
    expect(dispose).not.toHaveBeenCalled();
    expect(textPayload(result)).toMatchObject({
      output: "prepared",
      approval: { by: "master_bypass" },
      security: { auditId: "audit-1", route: "sandbox" },
    });
  });

  it("disposes prepared execution when the user rejects approval", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const execute = vi.fn();
    const dispose = vi.fn();
    const prepareExecution = vi.fn(async () => ({
      security: {
        auditId: "audit-rejected",
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
      },
      execute,
      dispose,
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "npm install package" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: vi.fn(),
      } as never,
      {
        isRecentlyApproved: () => false,
        enqueueCommandApproval: vi.fn(() => ({
          promise: Promise.resolve({ decision: "reject" }),
        })),
      } as never,
      "session-prepared-reject",
      undefined,
      {
        terminalProvider: {
          ...terminalProvider,
          prepareExecution,
        },
        getCommandApprovalPolicy: () => "manual",
      },
    );

    expect(textPayload(result)).toMatchObject({ status: "rejected_by_user" });
    expect(prepareExecution).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes and re-prepares the exact descriptor after a human edit", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const firstDispose = vi.fn();
    const secondExecute = vi.fn(async () => ({
      exit_code: 0,
      output: "edited",
      output_captured: true,
      terminal_id: "edited-1",
    }));
    const security = {
      auditId: "audit-edit",
      route: "sandbox" as const,
      confinement: "verified-baseline" as const,
      routeReason: "verified-local-macos" as const,
      executionSurface: "verified-sandbox" as const,
      requiredAuthority: "sandbox" as const,
      approvalPolicySnapshot: "on-request" as const,
      approvalReviewerSnapshot: "auto-review" as const,
      executionPresetSnapshot: "workspace-write" as const,
      commandApprovalPolicySnapshot: "approve-for-me" as const,
      executionPolicy: "sandbox-baseline-v2" as const,
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
          privateTmp: false,
          hostIpcBlocked: false,
          resourceLimits: "partial" as const,
          warnings: [],
        },
      },
    };
    const prepareExecution = vi
      .fn()
      .mockResolvedValueOnce({
        security,
        execute: vi.fn(),
        dispose: firstDispose,
      })
      .mockResolvedValueOnce({
        security: { ...security, auditId: "audit-edited" },
        execute: secondExecute,
        dispose: vi.fn(),
      });
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "npm test" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: vi.fn(),
      } as never,
      {
        isRecentlyApproved: () => false,
        enqueueCommandApproval: vi.fn(() => ({
          promise: Promise.resolve({
            decision: "edit",
            editedCommand: "npm test -- --runInBand",
          }),
        })),
      } as never,
      "session-edit-reprepare",
      undefined,
      {
        terminalProvider: { ...terminalProvider, prepareExecution },
        getCommandApprovalPolicy: () => "manual",
      },
    );

    expect(prepareExecution).toHaveBeenCalledTimes(2);
    expect(prepareExecution.mock.calls[0][0].command).toBe("npm test");
    expect(prepareExecution.mock.calls[1][0].command).toBe(
      "npm test -- --runInBand",
    );
    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(secondExecute).toHaveBeenCalledTimes(1);
    expect(textPayload(result)).toMatchObject({
      output: "edited",
      command_modified: true,
      command: "npm test -- --runInBand",
      security: { auditId: "audit-edited" },
    });
  });

  it("re-prepares an edited native escalation without changing authority", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const firstExecute = vi.fn();
    const firstDispose = vi.fn();
    const secondExecute = vi.fn(async () => ({
      exit_code: 0,
      output: "edited native build",
      output_captured: true,
      terminal_id: "native-edited-1",
      execution_mode: "native_pty" as const,
    }));
    const secondDispose = vi.fn();
    const prepareExecution = vi.fn(async (options, routeContext) => ({
      security: {
        auditId:
          options.command === "dotnet build"
            ? "audit-native-edit-first"
            : "audit-native-edit-second",
        route: "native" as const,
        executionSurface: "agentlink-native" as const,
        confinement: "native-unsandboxed" as const,
        routeReason: "verified-local-macos" as const,
        ...routeContext,
        executionPolicy: "native-legacy-v1" as const,
        preparedAt: options.command === "dotnet build" ? 100 : 101,
      },
      execute:
        options.command === "dotnet build" ? firstExecute : secondExecute,
      dispose:
        options.command === "dotnet build" ? firstDispose : secondDispose,
    }));
    const enqueueCommandApproval = vi.fn(() => ({
      promise: Promise.resolve({
        decision: "edit",
        editedCommand: "dotnet build --no-restore",
      }),
    }));
    const review = vi.fn(async () => ({
      outcome: "deny" as const,
      risk: "high" as const,
      userAuthorization: "unknown" as const,
      rationale: "The exact native command needs human confirmation",
      model: "review-model",
      status: "reviewed" as const,
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      {
        command: "dotnet build",
        sandbox_permissions: "require_escalated",
        reason: "The SDK requires a host facility.",
      },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: vi.fn(),
      } as never,
      { enqueueCommandApproval } as never,
      "session-native-edit",
      undefined,
      {
        terminalProvider: { ...terminalProvider, prepareExecution },
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review },
        isSessionActive: () => true,
      },
    );

    expect(prepareExecution).toHaveBeenCalledTimes(2);
    expect(
      prepareExecution.mock.calls.map(([options, routeContext]) => ({
        command: options.command,
        requiredAuthority: routeContext.requiredAuthority,
        permissionIntent: routeContext.permissionIntent,
      })),
    ).toEqual([
      {
        command: "dotnet build",
        requiredAuthority: "native-agent",
        permissionIntent: "native-escalation",
      },
      {
        command: "dotnet build --no-restore",
        requiredAuthority: "native-agent",
        permissionIntent: "native-escalation",
      },
    ]);
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(firstExecute).not.toHaveBeenCalled();
    expect(secondExecute).toHaveBeenCalledOnce();
    expect(textPayload(result)).toMatchObject({
      output: "edited native build",
      command_modified: true,
      original_command: "dotnet build",
      command: "dotnet build --no-restore",
      security: {
        auditId: "audit-native-edit-second",
        route: "native",
        requiredAuthority: "native-agent",
        permissionIntent: "native-escalation",
      },
    });
  });

  it("rejects an edited command when its sandbox grant changes", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    const execute = vi.fn();
    const security = {
      auditId: "audit-sandbox",
      route: "sandbox" as const,
      confinement: "verified-baseline" as const,
      routeReason: "verified-local-macos" as const,
      executionSurface: "verified-sandbox" as const,
      requiredAuthority: "sandbox" as const,
      permissionIntent: "additional-permissions" as const,
      approvalRequirement: "explicit-permissions" as const,
      authorityReason: "additional-permissions" as const,
      approvalPolicySnapshot: "on-request" as const,
      approvalReviewerSnapshot: "auto-review" as const,
      executionPresetSnapshot: "workspace-write" as const,
      commandApprovalPolicySnapshot: "approve-for-me" as const,
      executionPolicy: "sandbox-baseline-v2" as const,
      preparedAt: 100,
      sandbox: {
        attestationId: "attestation-1",
        attestationVersion: "sandbox-behavior-v1",
        policyVersion: "policy-v1",
        profileId: "workspace-write",
        backend: "seatbelt" as const,
        architecture: "arm64" as const,
        capabilities: { network: "proxy-only" as const },
        grant: { grantId: "grant-1", auditId: "network-audit-1" },
      },
    };
    const prepareExecution = vi
      .fn()
      .mockResolvedValueOnce({
        security,
        execute,
        dispose: firstDispose,
      })
      .mockResolvedValueOnce({
        security: {
          ...security,
          auditId: "audit-sandbox-edited",
          preparedAt: 101,
          sandbox: {
            ...security.sandbox,
            grant: { grantId: "grant-2", auditId: "network-audit-2" },
          },
        },
        execute,
        dispose: secondDispose,
      });
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "npm test" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: vi.fn(),
      } as never,
      {
        isRecentlyApproved: () => false,
        enqueueCommandApproval: vi.fn(() => ({
          promise: Promise.resolve({
            decision: "edit",
            editedCommand: "npm test -- --runInBand",
          }),
        })),
      } as never,
      "session-edit-basis-change",
      undefined,
      {
        terminalProvider: { ...terminalProvider, prepareExecution },
        getCommandApprovalPolicy: () => "manual",
      },
    );

    expect(textPayload(result)).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("security basis changed"),
    });
    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(secondDispose).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns explicit unavailable output before validation or approvals when no terminal provider is supplied", async () => {
    const enqueueCommandApproval = vi.fn();
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "go test ./..." },
      {
        isCommandApproved: vi.fn(() => false),
        findMatchingCommandRule: vi.fn(),
      } as never,
      {
        isRecentlyApproved: vi.fn(() => false),
        enqueueCommandApproval,
      } as never,
      "session-unavailable",
    );

    expect(validateCommand).not.toHaveBeenCalled();
    expect(validateInteractiveCommand).not.toHaveBeenCalled();
    expect(enqueueCommandApproval).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
    expect(textPayload(result)).toEqual({
      error:
        "Command execution is unavailable in this runtime. Provide a TerminalProvider to enable execute_command.",
      command: "go test ./...",
      command_sent: false,
    });
  });

  it("requires a reason before preparing native escalation", async () => {
    const prepareExecution = vi.fn();
    const enqueueCommandApproval = vi.fn();
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      {
        command: "dotnet build",
        sandbox_permissions: "require_escalated",
        reason: "   ",
      },
      { isCommandApproved: () => true } as never,
      { enqueueCommandApproval } as never,
      "session-escalation-no-reason",
      undefined,
      { terminalProvider: { ...terminalProvider, prepareExecution } },
    );

    expect(textPayload(result)).toEqual({
      status: "rejected",
      command: "dotnet build",
      reason:
        'sandbox_permissions="require_escalated" requires a non-empty reason explaining why the additional authority is needed.',
      command_sent: false,
    });
    expect(prepareExecution).not.toHaveBeenCalled();
    expect(enqueueCommandApproval).not.toHaveBeenCalled();
  });

  it("does not execute native escalation when approval resolves after cancellation", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    let resolveApproval!: (response: { decision: "run-once" }) => void;
    const approvalPromise = new Promise<{ decision: "run-once" }>((resolve) => {
      resolveApproval = resolve;
    });
    const enqueueCommandApproval = vi.fn(() => ({ promise: approvalPromise }));
    const nativeExecute = vi.fn();
    const nativeDispose = vi.fn();
    const recordExecutionAudit = vi.fn();
    const prepareExecution = vi.fn(async (_options, routeContext) => ({
      security: {
        auditId: "audit-native-cancelled",
        route: "native" as const,
        executionSurface: "agentlink-native" as const,
        confinement: "native-unsandboxed" as const,
        routeReason: "verified-local-macos" as const,
        ...routeContext,
        executionPolicy: "native-legacy-v1" as const,
        preparedAt: 100,
      },
      execute: nativeExecute,
      dispose: nativeDispose,
    }));
    const controller = new AbortController();
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const execution = handleExecuteCommand(
      {
        command: "dotnet build",
        sandbox_permissions: "require_escalated",
        reason: "The SDK requires a host facility.",
      },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: vi.fn(),
      } as never,
      { enqueueCommandApproval } as never,
      "session-native-cancelled",
      undefined,
      {
        terminalProvider: {
          ...terminalProvider,
          prepareExecution,
          recordExecutionAudit,
        },
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: {
          review: async () => ({
            outcome: "deny",
            risk: "high",
            userAuthorization: "unknown",
            rationale: "Native execution needs human confirmation",
            model: "review-model",
            status: "reviewed",
          }),
        },
        isSessionActive: () => true,
        toolAbortSignal: controller.signal,
      },
    );

    await vi.waitFor(() =>
      expect(enqueueCommandApproval).toHaveBeenCalledOnce(),
    );
    controller.abort();
    resolveApproval({ decision: "run-once" });

    await expect(execution.then(textPayload)).resolves.toMatchObject({
      status: "cancelled",
      command: "dotnet build",
      reason: "Command approval was cancelled before execution",
      security: {
        auditId: "audit-native-cancelled",
        route: "native",
        requiredAuthority: "native-agent",
      },
      command_sent: false,
    });
    expect(prepareExecution).toHaveBeenCalledOnce();
    expect(prepareExecution.mock.calls[0][1]).toMatchObject({
      requiredAuthority: "native-agent",
      permissionIntent: "native-escalation",
    });
    expect(nativeExecute).not.toHaveBeenCalled();
    expect(nativeDispose).toHaveBeenCalledOnce();
    expect(recordExecutionAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "execution_cancelled",
        auditId: "audit-native-cancelled",
        route: "native",
        resultStatus: "approval_cancelled",
      }),
    );
  });

  it("uses the standard command approval card when fresh native review denies", async () => {
    const addCommandRule = vi.fn();
    const review = vi.fn(async () => ({
      outcome: "deny" as const,
      risk: "high" as const,
      userAuthorization: "unknown" as const,
      rationale: "Native execution needs human confirmation",
      model: "review-model",
      status: "reviewed" as const,
    }));
    const enqueueCommandApproval = vi.fn(() => ({
      promise: Promise.resolve({
        decision: "run-once",
        rules: [
          {
            pattern: "dotnet build",
            mode: "exact",
            decision: "allow",
            scope: "project",
          },
        ],
      }),
      commitApprovalRecording: vi.fn(),
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      {
        command: "dotnet build",
        sandbox_permissions: "require_escalated",
        reason: "The SDK needs a host facility unavailable in the sandbox.",
      },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: vi.fn(() => ({
          rule: {
            pattern: "dotnet build",
            mode: "exact",
            decision: "allow",
          },
          scope: "project",
        })),
        addCommandRule,
      } as never,
      { enqueueCommandApproval } as never,
      "session-native-escalation",
      undefined,
      {
        terminalProvider,
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review },
      },
    );

    expect(terminalProvider.prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({ command: "dotnet build", cwd: "/workspace" }),
      {
        requiredAuthority: "native-agent",
        permissionIntent: "native-escalation",
        approvalRequirement: "explicit-escalation",
        authorityReason: "explicit-escalation",
        approvalPolicySnapshot: "on-request" as const,
        approvalReviewerSnapshot: "auto-review" as const,
        executionPresetSnapshot: "workspace-write" as const,
        commandApprovalPolicySnapshot: "approve-for-me",
      },
    );
    expect(review).toHaveBeenCalledOnce();
    expect(enqueueCommandApproval).toHaveBeenCalledWith(
      "dotnet build",
      "dotnet build",
      expect.objectContaining({
        reason: "The SDK needs a host facility unavailable in the sandbox.",
        cwd: "/workspace",
        sessionId: "session-native-escalation",
        commandReview: expect.objectContaining({
          outcome: "deny",
          status: "reviewed",
          rationale: "Native execution needs human confirmation",
        }),
        subCommands: [
          expect.objectContaining({
            command: "dotnet build",
            existingRule: {
              pattern: "dotnet build",
              mode: "exact",
              decision: "allow",
              scope: "project",
            },
          }),
        ],
        security: expect.objectContaining({
          route: "native",
          permissionIntent: "native-escalation",
        }),
      }),
    );
    expect(addCommandRule).toHaveBeenCalledWith(
      "session-native-escalation",
      { pattern: "dotnet build", mode: "exact", decision: "allow" },
      "project",
      "/workspace",
    );
    expect(textPayload(result)).toMatchObject({
      approval: { by: "human" },
      security: {
        route: "native",
        requiredAuthority: "native-agent",
        permissionIntent: "native-escalation",
      },
    });
  });

  it("requires fresh reviewer approval before a matching native escalation rule", async () => {
    const enqueueCommandApproval = vi.fn();
    const review = vi.fn(async () => ({
      outcome: "allow" as const,
      risk: "medium" as const,
      userAuthorization: "high" as const,
      rationale: "Fresh native review approved the bounded build",
      model: "review-model",
      status: "reviewed" as const,
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      {
        command: "dotnet build",
        sandbox_permissions: "require_escalated",
        reason: "The SDK needs a host facility unavailable in the sandbox.",
      },
      {
        isCommandApproved: () => true,
        findMatchingCommandRule: vi.fn(() => ({
          rule: { pattern: "dotnet build", mode: "exact" },
          scope: "project",
        })),
      } as never,
      { enqueueCommandApproval } as never,
      "session-native-escalation-rule",
      undefined,
      {
        terminalProvider,
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review },
      },
    );

    expect(review).toHaveBeenCalledOnce();
    expect(enqueueCommandApproval).not.toHaveBeenCalled();
    expect(textPayload(result)).toMatchObject({
      approval: { by: "model_reviewer" },
      security: {
        route: "native",
        permissionIntent: "native-escalation",
      },
    });
  });

  it("uses explicit all-segment allow rules as native authority under Approve for Me", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const rules = {
      session: [
        {
          pattern: "dotnet build",
          mode: "exact" as const,
          decision: "allow" as const,
        },
      ],
      project: [],
      global: [],
    };
    const evaluateCommandRules = vi.fn((_sessionId, command) =>
      evaluateCommandRulePolicy(rules, command),
    );
    const enqueueCommandApproval = vi.fn();
    const review = vi.fn();
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "dotnet build" },
      {
        evaluateCommandRules,
        isCommandApproved: () => true,
        findMatchingCommandRule: vi.fn(),
      } as never,
      { enqueueCommandApproval } as never,
      "session-explicit-native-rule",
      undefined,
      {
        terminalProvider,
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review },
      },
    );

    expect(terminalProvider.prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({ command: "dotnet build" }),
      expect.objectContaining({
        requiredAuthority: "native-agent",
        permissionIntent: "default",
        authorityReason: "explicit-rule",
      }),
    );
    expect(evaluateCommandRules).toHaveBeenCalledTimes(2);
    expect(review).not.toHaveBeenCalled();
    expect(enqueueCommandApproval).not.toHaveBeenCalled();
    expect(textPayload(result)).toMatchObject({
      approval: { by: "explicit_rule" },
      security: { route: "native", authorityReason: "explicit-rule" },
    });
  });

  it.each([
    {
      ruleKind: "regex allow",
      rule: {
        pattern: "^npm test$",
        mode: "regex" as const,
        decision: "allow" as const,
      },
    },
    {
      ruleKind: "legacy approval-only",
      rule: {
        pattern: "npm test",
        mode: "exact" as const,
      },
    },
  ])(
    "keeps $ruleKind rules sandboxed while skipping repeat approval",
    async ({ rule }) => {
      getConfiguration.mockReturnValue({
        get: vi.fn((key: string, fallback?: unknown) =>
          key === "masterBypass" ? false : fallback,
        ),
      });
      const rules = {
        session: [rule],
        project: [],
        global: [],
      };
      const evaluateCommandRules = vi.fn((_sessionId, command) =>
        evaluateCommandRulePolicy(rules, command),
      );
      const enqueueCommandApproval = vi.fn();
      const review = vi.fn();
      const { handleExecuteCommand } = await import("./executeCommand.js");

      const result = await handleExecuteCommand(
        { command: "npm test" },
        {
          evaluateCommandRules,
          isCommandApproved: () => true,
          findMatchingCommandRule: vi.fn(),
        } as never,
        { enqueueCommandApproval } as never,
        `session-${rule.mode}-sandboxed-rule`,
        undefined,
        {
          terminalProvider,
          getCommandApprovalPolicy: () => "approve-for-me",
          commandApprovalReviewer: { review },
        },
      );

      expect(terminalProvider.prepareExecution).toHaveBeenCalledWith(
        expect.objectContaining({ command: "npm test" }),
        expect.objectContaining({
          requiredAuthority: "sandbox",
          authorityReason: "approval-policy",
        }),
      );
      expect(evaluateCommandRules).toHaveBeenCalledTimes(2);
      expect(review).not.toHaveBeenCalled();
      expect(enqueueCommandApproval).not.toHaveBeenCalled();
      expect(textPayload(result)).toMatchObject({
        approval: { by: "explicit_rule" },
        security: { route: "sandbox", authorityReason: "approval-policy" },
      });
    },
  );

  it("does not let a command-only allow rule grant native authority to env overrides", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const rules = {
      session: [
        {
          pattern: "dotnet build",
          mode: "exact" as const,
          decision: "allow" as const,
        },
      ],
      project: [],
      global: [],
    };
    const enqueueCommandApproval = vi.fn(() => ({
      promise: Promise.resolve({ decision: "run-once" }),
      commitApprovalRecording: vi.fn(),
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "dotnet build", env: { CUSTOM_BUILD_MODE: "1" } },
      {
        evaluateCommandRules: (_sessionId: string, command: string) =>
          evaluateCommandRulePolicy(rules, command),
        isCommandApproved: () => true,
        findMatchingCommandRule: vi.fn(),
      } as never,
      { enqueueCommandApproval } as never,
      "session-explicit-rule-env",
      undefined,
      {
        terminalProvider,
        getCommandApprovalPolicy: () => "approve-for-me",
      },
    );

    expect(terminalProvider.prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({ env: { CUSTOM_BUILD_MODE: "1" } }),
      expect.objectContaining({
        requiredAuthority: "sandbox",
        authorityReason: "approval-policy",
      }),
    );
    expect(enqueueCommandApproval).toHaveBeenCalledOnce();
    expect(textPayload(result)).toMatchObject({
      security: { route: "sandbox" },
    });
  });

  it("keeps a partially allowed compound command sandboxed and requires approval", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const rules = {
      session: [
        {
          pattern: "npm test",
          mode: "exact" as const,
          decision: "allow" as const,
        },
      ],
      project: [],
      global: [],
    };
    const enqueueCommandApproval = vi.fn(() => ({
      promise: Promise.resolve({ decision: "run-once" }),
      commitApprovalRecording: vi.fn(),
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "npm test && npm run lint" },
      {
        evaluateCommandRules: (_sessionId: string, command: string) =>
          evaluateCommandRulePolicy(rules, command),
        isCommandApproved: () => false,
        findMatchingCommandRule: vi.fn(),
      } as never,
      { enqueueCommandApproval } as never,
      "session-partial-rule",
      undefined,
      {
        terminalProvider,
        getCommandApprovalPolicy: () => "approve-for-me",
      },
    );

    expect(terminalProvider.prepareExecution).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        requiredAuthority: "sandbox",
        authorityReason: "approval-policy",
      }),
    );
    expect(enqueueCommandApproval).toHaveBeenCalledOnce();
    expect(textPayload(result)).toMatchObject({
      approval: { by: "human" },
      security: { route: "sandbox" },
    });
  });

  it("does not let safe-tier approval override an explicit prompt rule", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const rules = {
      session: [
        {
          pattern: "git status",
          mode: "exact" as const,
          decision: "prompt" as const,
        },
      ],
      project: [],
      global: [],
    };
    const enqueueCommandApproval = vi.fn(() => ({
      promise: Promise.resolve({ decision: "reject" }),
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "git status" },
      {
        evaluateCommandRules: (_sessionId: string, command: string) =>
          evaluateCommandRulePolicy(rules, command),
        isCommandApproved: () => false,
        findMatchingCommandRule: vi.fn(),
      } as never,
      { enqueueCommandApproval } as never,
      "session-safe-prompt-rule",
      undefined,
      {
        terminalProvider,
        getCommandApprovalPolicy: () => "safe",
      },
    );

    expect(enqueueCommandApproval).toHaveBeenCalledOnce();
    expect(textPayload(result)).toMatchObject({ status: "rejected_by_user" });
  });

  it("lets prompt override allow and prevents native rule authority", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const rules = {
      session: [
        {
          pattern: "npm publish",
          mode: "exact" as const,
          decision: "allow" as const,
        },
      ],
      project: [
        {
          pattern: "npm",
          mode: "prefix" as const,
          decision: "prompt" as const,
        },
      ],
      global: [],
    };
    const enqueueCommandApproval = vi.fn(() => ({
      promise: Promise.resolve({ decision: "reject" }),
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "npm publish" },
      {
        evaluateCommandRules: (_sessionId: string, command: string) =>
          evaluateCommandRulePolicy(rules, command),
        isCommandApproved: () => false,
        findMatchingCommandRule: vi.fn(),
      } as never,
      { enqueueCommandApproval } as never,
      "session-prompt-overrides-allow",
      undefined,
      {
        terminalProvider,
        getCommandApprovalPolicy: () => "approve-for-me",
      },
    );

    expect(terminalProvider.prepareExecution).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requiredAuthority: "sandbox" }),
    );
    expect(enqueueCommandApproval).toHaveBeenCalledOnce();
    expect(textPayload(result)).toMatchObject({ status: "rejected_by_user" });
  });

  it("rejects forbidden rules before terminal preparation", async () => {
    const rules = {
      session: [
        {
          pattern: "npm publish",
          mode: "exact" as const,
          decision: "forbidden" as const,
        },
      ],
      project: [],
      global: [],
    };
    const prepareExecution = vi.fn();
    const enqueueCommandApproval = vi.fn();
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "npm publish" },
      {
        evaluateCommandRules: (_sessionId: string, command: string) =>
          evaluateCommandRulePolicy(rules, command),
        isCommandApproved: () => false,
      } as never,
      { enqueueCommandApproval } as never,
      "session-forbidden-rule",
      undefined,
      {
        terminalProvider: { ...terminalProvider, prepareExecution },
        getCommandApprovalPolicy: () => "approve-for-me",
      },
    );

    expect(prepareExecution).not.toHaveBeenCalled();
    expect(enqueueCommandApproval).not.toHaveBeenCalled();
    expect(textPayload(result)).toEqual({
      status: "rejected",
      command: "npm publish",
      reason:
        "Command execution is forbidden by an applicable command policy rule.",
      command_sent: false,
    });
  });

  it("does not retry an ordinary sandbox failure without a structured violation", async () => {
    const prepareExecution = vi.fn(async (options, routeContext) => ({
      security: {
        auditId: "audit-ordinary-failure",
        route: "sandbox" as const,
        executionSurface: "verified-sandbox" as const,
        confinement: "verified-baseline" as const,
        routeReason: "verified-local-macos" as const,
        ...routeContext,
        executionPolicy: "sandbox-baseline-v2" as const,
        preparedAt: 100,
      },
      execute: async () => ({
        exit_code: 1,
        output: "permission denied in stderr only",
        output_captured: true,
        terminal_id: "sandbox-ordinary",
        command_sent: true,
        process_launched: true,
        execution_mode: "sandbox_pty" as const,
      }),
      dispose: vi.fn(),
    }));
    const review = vi.fn();
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "dotnet build" },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-no-structured-retry",
      undefined,
      {
        terminalProvider: { ...terminalProvider, prepareExecution },
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review },
      },
    );

    expect(prepareExecution).toHaveBeenCalledTimes(1);
    expect(review).not.toHaveBeenCalled();
    expect(textPayload(result)).toMatchObject({
      exit_code: 1,
      output: "permission denied in stderr only",
      terminal_id: "sandbox-ordinary",
    });
    expect(textPayload(result).retry_lineage_id).toBeUndefined();
  });

  it("makes one freshly reviewed native retry for a structured sandbox denial", async () => {
    const violation = {
      operation: "ipc-connect" as const,
      target: "NuGet-Migrations",
      reason: "Named mutex requires host IPC",
      occurredAt: 123,
    };
    const sandboxExecute = vi.fn(async () => ({
      exit_code: 1,
      output: "sandbox denied named mutex",
      output_captured: true,
      terminal_id: "sandbox-retry-1",
      command_sent: true,
      process_launched: true,
      retry_safe: false,
      execution_mode: "sandbox_pty" as const,
      sandbox: {
        policyVersion: "policy-v1",
        profileId: "workspace-write",
        backend: "seatbelt",
        capabilities: {
          backend: "seatbelt",
          processTree: true,
          filesystemRead: "host-visible" as const,
          filesystemWrite: "strict" as const,
          network: "blocked" as const,
          privateHome: false,
          privateTmp: false,
          hostIpcBlocked: true,
          resourceLimits: "partial" as const,
          warnings: [],
        },
        violations: [violation],
      },
    }));
    const nativeExecute = vi.fn(async () => ({
      exit_code: 0,
      output: "native build passed",
      output_captured: true,
      terminal_id: "native-retry-1",
      command_sent: true,
      process_launched: true,
      retry_safe: false,
      execution_mode: "native_pty" as const,
    }));
    const prepareExecution = vi.fn(async (_options, routeContext) => {
      const sandbox = routeContext.requiredAuthority === "sandbox";
      return {
        security: {
          auditId: sandbox ? "audit-sandbox-first" : "audit-native-second",
          route: sandbox ? ("sandbox" as const) : ("native" as const),
          executionSurface: sandbox
            ? ("verified-sandbox" as const)
            : ("agentlink-native" as const),
          confinement: sandbox
            ? ("verified-baseline" as const)
            : ("native-unsandboxed" as const),
          routeReason: "verified-local-macos" as const,
          ...routeContext,
          executionPolicy: sandbox
            ? ("sandbox-baseline-v2" as const)
            : ("native-legacy-v1" as const),
          preparedAt: sandbox ? 100 : 101,
        },
        execute: sandbox ? sandboxExecute : nativeExecute,
        dispose: vi.fn(),
      };
    });
    const review = vi.fn(async () => ({
      outcome: "allow" as const,
      risk: "medium" as const,
      userAuthorization: "high" as const,
      rationale:
        "The exact native retry is justified by the attributed IPC denial",
      model: "review-model",
      status: "reviewed" as const,
    }));
    const enqueueCommandApproval = vi.fn();
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "dotnet build" },
      {
        isCommandApproved: () => true,
        findMatchingCommandRule: vi.fn(() => ({
          rule: { pattern: "dotnet build", mode: "exact" },
          scope: "project",
        })),
      } as never,
      {
        isRecentlyApproved: () => true,
        enqueueCommandApproval,
      } as never,
      "session-structured-retry",
      undefined,
      {
        terminalProvider: { ...terminalProvider, prepareExecution },
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review },
      },
    );

    expect(prepareExecution).toHaveBeenCalledTimes(2);
    expect(prepareExecution.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ command: "dotnet build", cwd: "/workspace" }),
      expect.objectContaining({ command: "dotnet build", cwd: "/workspace" }),
    ]);
    expect(prepareExecution.mock.calls[1][1]).toMatchObject({
      requiredAuthority: "native-agent",
      permissionIntent: "native-escalation",
      approvalRequirement: "explicit-escalation",
      approvalReviewerSnapshot: "auto-review",
      executionPresetSnapshot: "workspace-write",
    });
    expect(review).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "dotnet build",
        cwd: "/workspace",
        reason: expect.stringContaining("Named mutex requires host IPC"),
        security: expect.objectContaining({
          route: "native",
          permissionIntent: "native-escalation",
        }),
      }),
    );
    expect(enqueueCommandApproval).not.toHaveBeenCalled();
    expect(sandboxExecute).toHaveBeenCalledOnce();
    expect(nativeExecute).toHaveBeenCalledOnce();

    const payload = textPayload(result);
    expect(payload).toMatchObject({
      exit_code: 0,
      output: "native build passed",
      terminal_id: "native-retry-1",
      approval: { by: "model_reviewer" },
      capability_denial: violation,
      retry_outcome: "completed",
      retry_safe: false,
      security: {
        auditId: "audit-native-second",
        route: "native",
        permissionIntent: "native-escalation",
      },
      execution_attempts: [
        {
          attempt: 1,
          route: "sandbox",
          audit_id: "audit-sandbox-first",
          command_sent: true,
          process_launched: true,
          retry_safe: false,
          may_have_side_effects: true,
          capability_denial: violation,
        },
        {
          attempt: 2,
          route: "native",
          audit_id: "audit-native-second",
          command_sent: true,
          process_launched: true,
        },
      ],
    });
    expect(payload.retry_lineage_id).toEqual(expect.any(String));
  });

  it.each([
    ["dangerous command", "rm -rf src", "destructive"],
    ["opaque command", "echo $(whoami)", "opaque_shell"],
    ["unknown command", "custom-tool --flag", "unrecognized_executable"],
    ["unknown package script", "npm run custom", "unrecognized_operation"],
    [
      "compound command with an ineligible subcommand",
      "dotnet build && custom-tool --flag",
      "unrecognized_executable",
    ],
  ])(
    "does not retry a structured sandbox denial for an ineligible %s",
    async (_label, command, riskCode) => {
      const violation = {
        operation: "ipc-connect" as const,
        target: "host-service",
        reason: "Sandbox denied host IPC",
        occurredAt: 321,
      };
      const prepareExecution = vi.fn(async (_options, routeContext) => ({
        security: {
          auditId: "audit-ineligible-retry",
          route: "sandbox" as const,
          executionSurface: "verified-sandbox" as const,
          confinement: "verified-baseline" as const,
          routeReason: "verified-local-macos" as const,
          ...routeContext,
          executionPolicy: "sandbox-baseline-v2" as const,
          preparedAt: 100,
        },
        execute: async () => ({
          exit_code: 1,
          output: "sandbox denied host IPC",
          output_captured: true,
          terminal_id: "sandbox-ineligible-retry",
          command_sent: true,
          process_launched: true,
          execution_mode: "sandbox_pty" as const,
          sandbox: {
            policyVersion: "policy-v1",
            profileId: "workspace-write",
            backend: "seatbelt",
            capabilities: {
              backend: "seatbelt",
              processTree: true,
              filesystemRead: "host-visible" as const,
              filesystemWrite: "strict" as const,
              network: "blocked" as const,
              privateHome: false,
              privateTmp: false,
              hostIpcBlocked: true,
              resourceLimits: "partial" as const,
              warnings: [],
            },
            violations: [violation],
          },
        }),
        dispose: vi.fn(),
      }));
      const review = vi.fn();
      const enqueueCommandApproval = vi.fn();
      const { handleExecuteCommand } = await import("./executeCommand.js");

      const result = await handleExecuteCommand(
        { command },
        { isCommandApproved: () => true } as never,
        { isRecentlyApproved: () => true, enqueueCommandApproval } as never,
        `session-ineligible-retry-${riskCode}`,
        undefined,
        {
          terminalProvider: { ...terminalProvider, prepareExecution },
          getCommandApprovalPolicy: () => "approve-for-me",
          commandApprovalReviewer: { review },
        },
      );

      expect(prepareExecution).toHaveBeenCalledOnce();
      expect(review).not.toHaveBeenCalled();
      expect(enqueueCommandApproval).not.toHaveBeenCalled();
      expect(textPayload(result)).toMatchObject({
        exit_code: 1,
        capability_denial: violation,
        retry_outcome: "not_attempted",
        retry_reason: expect.stringContaining(riskCode),
        execution_attempts: [{ attempt: 1, route: "sandbox" }],
      });
    },
  );

  it.each([
    {
      guard: "resource-limit denial",
      command: "dotnet build",
      params: {},
      operation: "resource-limit" as const,
      expectedReason:
        "Resource-limit denials are not retried outside the sandbox.",
    },
    {
      guard: "manual approval policy",
      command: "dotnet build",
      params: {},
      operation: "ipc-connect" as const,
      approvalMode: {
        commandApprovalPolicy: "manual" as const,
        approvalPolicy: "on-request" as const,
        approvalReviewer: "user" as const,
        executionPreset: "workspace-write" as const,
      },
      expectedReason: "Automatic native retry requires Approve for Me.",
    },
    {
      guard: "read-only execution policy",
      command: "git status",
      params: {},
      operation: "ipc-connect" as const,
      commandExecutionPolicy: "read-only" as const,
      expectedReason:
        "Read-only execution policy does not permit native retry.",
    },
    {
      guard: "temporary inline files",
      command: "dotnet build --configfile $AL_FILE(input)",
      params: {
        files: [{ name: "input", content: "fixture" }],
      },
      operation: "ipc-connect" as const,
      expectedReason:
        "Commands with temporary inline files cannot be replayed after sandbox completion.",
    },
    {
      guard: "human-edited command",
      command: "dotnet build",
      params: {},
      operation: "ipc-connect" as const,
      editedCommand: "dotnet build --no-restore",
      expectedReason:
        "Commands edited during approval require a new explicit invocation before native retry.",
    },
    {
      guard: "pinned terminal target",
      command: "dotnet build",
      params: { terminal_name: "Pinned Sandbox" },
      operation: "ipc-connect" as const,
      expectedReason:
        "Commands pinned to a terminal target cannot switch execution authority automatically.",
    },
  ])(
    "does not transition to native for $guard",
    async ({
      command,
      params,
      operation,
      approvalMode,
      commandExecutionPolicy,
      editedCommand,
      expectedReason,
    }) => {
      getConfiguration.mockReturnValue({
        get: vi.fn((key: string, fallback?: unknown) =>
          key === "masterBypass" ? false : fallback,
        ),
      });
      const violation = {
        operation,
        target: "host-service",
        reason: "Sandbox denied the requested host capability",
        occurredAt: 456,
      };
      const prepareExecution = vi.fn(async (options, routeContext) => ({
        security: {
          auditId: `audit-${options.command}`,
          route: "sandbox" as const,
          executionSurface: "verified-sandbox" as const,
          confinement: "verified-baseline" as const,
          routeReason: "verified-local-macos" as const,
          ...routeContext,
          executionPolicy: "sandbox-baseline-v2" as const,
          preparedAt: 100,
        },
        execute: async () => ({
          exit_code: 1,
          output: "sandbox capability denied",
          output_captured: true,
          terminal_id: "sandbox-no-transition",
          command_sent: true,
          process_launched: true,
          execution_mode: "sandbox_pty" as const,
          sandbox: {
            policyVersion: "policy-v1",
            profileId: "workspace-write",
            backend: "seatbelt",
            capabilities: {
              backend: "seatbelt",
              processTree: true,
              filesystemRead: "host-visible" as const,
              filesystemWrite: "strict" as const,
              network: "blocked" as const,
              privateHome: false,
              privateTmp: false,
              hostIpcBlocked: true,
              resourceLimits: "partial" as const,
              warnings: [],
            },
            violations: [violation],
          },
        }),
        dispose: vi.fn(),
      }));
      const enqueueCommandApproval = vi.fn(() => ({
        promise: Promise.resolve(
          editedCommand
            ? {
                decision: "edit" as const,
                editedCommand,
              }
            : { decision: "run-once" as const },
        ),
        commitApprovalRecording: vi.fn(),
      }));
      const review = vi.fn(async () =>
        editedCommand
          ? {
              outcome: "deny" as const,
              risk: "high" as const,
              userAuthorization: "unknown" as const,
              rationale: "The command needs human editing",
              model: "review-model",
              status: "reviewed" as const,
            }
          : {
              outcome: "allow" as const,
              risk: "medium" as const,
              userAuthorization: "high" as const,
              rationale: "The bounded sandbox attempt is authorized",
              model: "review-model",
              status: "reviewed" as const,
            },
      );
      const { handleExecuteCommand } = await import("./executeCommand.js");

      const result = await handleExecuteCommand(
        { command, ...params },
        {
          isCommandApproved: () => false,
          findMatchingCommandRule: vi.fn(),
        } as never,
        {
          isRecentlyApproved: () => false,
          enqueueCommandApproval,
        } as never,
        `session-no-transition-${operation}`,
        undefined,
        {
          terminalProvider: { ...terminalProvider, prepareExecution },
          getCommandApprovalPolicy: () =>
            approvalMode?.commandApprovalPolicy ?? "approve-for-me",
          ...(approvalMode
            ? { getCommandApprovalMode: () => approvalMode }
            : {}),
          commandApprovalReviewer: { review },
          isSessionActive: () => true,
          ...(commandExecutionPolicy ? { commandExecutionPolicy } : {}),
        },
      );

      const payload = textPayload(result);
      expect(prepareExecution).toHaveBeenCalledTimes(editedCommand ? 2 : 1);
      expect(
        prepareExecution.mock.calls.every(
          ([, routeContext]) => routeContext.requiredAuthority === "sandbox",
        ),
      ).toBe(true);
      expect(payload).toMatchObject({
        exit_code: 1,
        capability_denial: violation,
        retry_outcome: "not_attempted",
        retry_reason: expectedReason,
        execution_attempts: [{ attempt: 1, route: "sandbox" }],
      });
    },
  );

  it("does not make a third attempt after the native retry also fails", async () => {
    const violation = {
      operation: "ipc-connect" as const,
      target: "NuGet-Migrations",
      reason: "Named mutex requires host IPC",
      occurredAt: 654,
    };
    const prepareExecution = vi.fn(async (_options, routeContext) => {
      const sandbox = routeContext.requiredAuthority === "sandbox";
      return {
        security: {
          auditId: sandbox ? "audit-terminal-first" : "audit-terminal-second",
          route: sandbox ? ("sandbox" as const) : ("native" as const),
          executionSurface: sandbox
            ? ("verified-sandbox" as const)
            : ("agentlink-native" as const),
          confinement: sandbox
            ? ("verified-baseline" as const)
            : ("native-unsandboxed" as const),
          routeReason: "verified-local-macos" as const,
          ...routeContext,
          executionPolicy: sandbox
            ? ("sandbox-baseline-v2" as const)
            : ("native-legacy-v1" as const),
          preparedAt: sandbox ? 100 : 101,
        },
        execute: async () =>
          sandbox
            ? {
                exit_code: 1,
                output: "sandbox denied named mutex",
                output_captured: true,
                terminal_id: "sandbox-terminal-retry",
                command_sent: true,
                process_launched: true,
                execution_mode: "sandbox_pty" as const,
                sandbox: {
                  policyVersion: "policy-v1",
                  profileId: "workspace-write",
                  backend: "seatbelt",
                  capabilities: {
                    backend: "seatbelt",
                    processTree: true,
                    filesystemRead: "host-visible" as const,
                    filesystemWrite: "strict" as const,
                    network: "blocked" as const,
                    privateHome: false,
                    privateTmp: false,
                    hostIpcBlocked: true,
                    resourceLimits: "partial" as const,
                    warnings: [],
                  },
                  violations: [violation],
                },
              }
            : {
                exit_code: 1,
                output: "native build failed",
                output_captured: true,
                terminal_id: "native-terminal-retry",
                command_sent: true,
                process_launched: true,
                execution_mode: "native_pty" as const,
                sandbox: {
                  policyVersion: "policy-v1",
                  profileId: "workspace-write",
                  backend: "seatbelt",
                  capabilities: {
                    backend: "seatbelt",
                    processTree: true,
                    filesystemRead: "host-visible" as const,
                    filesystemWrite: "strict" as const,
                    network: "blocked" as const,
                    privateHome: false,
                    privateTmp: false,
                    hostIpcBlocked: true,
                    resourceLimits: "partial" as const,
                    warnings: [],
                  },
                  violations: [violation],
                },
              },
        dispose: vi.fn(),
      };
    });
    const review = vi.fn(async () => ({
      outcome: "allow" as const,
      risk: "medium" as const,
      userAuthorization: "high" as const,
      rationale: "The attributed IPC denial justifies one native retry",
      model: "review-model",
      status: "reviewed" as const,
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "dotnet build" },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-terminal-retry",
      undefined,
      {
        terminalProvider: { ...terminalProvider, prepareExecution },
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review },
      },
    );

    expect(prepareExecution).toHaveBeenCalledTimes(2);
    expect(review).toHaveBeenCalledOnce();
    expect(textPayload(result)).toMatchObject({
      exit_code: 1,
      output: "native build failed",
      retry_outcome: "completed",
      execution_attempts: [
        { attempt: 1, route: "sandbox" },
        { attempt: 2, route: "native" },
      ],
    });
  });

  it("falls back to the normal human card when fresh native retry review denies", async () => {
    const violation = {
      operation: "file-read" as const,
      target: "/private/host-sdk",
      reason: "Sandbox denied host SDK metadata",
      occurredAt: 456,
    };
    const sandboxExecute = vi.fn(async () => ({
      exit_code: 1,
      output: "sandbox denied read",
      output_captured: true,
      terminal_id: "sandbox-review-denial",
      command_sent: true,
      process_launched: true,
      execution_mode: "sandbox_pty" as const,
      sandbox: {
        policyVersion: "policy-v1",
        profileId: "workspace-write",
        backend: "seatbelt",
        capabilities: {
          backend: "seatbelt",
          processTree: true,
          filesystemRead: "host-visible" as const,
          filesystemWrite: "strict" as const,
          network: "blocked" as const,
          privateHome: false,
          privateTmp: false,
          hostIpcBlocked: true,
          resourceLimits: "partial" as const,
          warnings: [],
        },
        violations: [violation],
      },
    }));
    const nativeExecute = vi.fn();
    const prepareExecution = vi.fn(async (_options, routeContext) => {
      const sandbox = routeContext.requiredAuthority === "sandbox";
      return {
        security: {
          auditId: sandbox ? "audit-denial-first" : "audit-denial-second",
          route: sandbox ? ("sandbox" as const) : ("native" as const),
          executionSurface: sandbox
            ? ("verified-sandbox" as const)
            : ("agentlink-native" as const),
          confinement: sandbox
            ? ("verified-baseline" as const)
            : ("native-unsandboxed" as const),
          routeReason: "verified-local-macos" as const,
          ...routeContext,
          executionPolicy: sandbox
            ? ("sandbox-baseline-v2" as const)
            : ("native-legacy-v1" as const),
          preparedAt: 100,
        },
        execute: sandbox ? sandboxExecute : nativeExecute,
        dispose: vi.fn(),
      };
    });
    const review = vi.fn(async () => ({
      outcome: "deny" as const,
      risk: "high" as const,
      userAuthorization: "unknown" as const,
      rationale: "The host SDK read needs human confirmation",
      model: "review-model",
      status: "reviewed" as const,
    }));
    const enqueueCommandApproval = vi.fn(() => ({
      promise: Promise.resolve({
        decision: "reject",
        rejectionReason: "Use the sandbox-compatible SDK instead",
      }),
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "dotnet build" },
      {
        isCommandApproved: () => true,
        findMatchingCommandRule: vi.fn(),
      } as never,
      { isRecentlyApproved: () => true, enqueueCommandApproval } as never,
      "session-retry-human-fallback",
      undefined,
      {
        terminalProvider: { ...terminalProvider, prepareExecution },
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review },
      },
    );

    expect(review).toHaveBeenCalledOnce();
    expect(enqueueCommandApproval).toHaveBeenCalledWith(
      "dotnet build",
      "dotnet build",
      expect.objectContaining({
        commandReview: expect.objectContaining({
          outcome: "deny",
          rationale: "The host SDK read needs human confirmation",
        }),
        security: expect.objectContaining({ route: "native" }),
      }),
    );
    expect(nativeExecute).not.toHaveBeenCalled();
    expect(prepareExecution).toHaveBeenCalledTimes(2);
    expect(textPayload(result)).toMatchObject({
      status: "rejected_by_user",
      reason: "Use the sandbox-compatible SDK instead",
      command_sent: true,
      process_launched: true,
      retry_safe: false,
      failure_stage: "approval",
      capability_denial: violation,
      retry_outcome: "approval_denied",
      execution_attempts: [
        { attempt: 1, route: "sandbox", command_sent: true },
        {
          attempt: 2,
          route: "native",
          status: "approval_denied",
          command_sent: false,
          process_launched: false,
        },
      ],
    });
  });

  it("reports network denial without attempting an unconditional native retry", async () => {
    const violation = {
      operation: "network-connect" as const,
      target: "https://registry.npmjs.org",
      reason: "Public network requires managed capability review",
      occurredAt: 789,
    };
    const prepareExecution = vi.fn(async (_options, routeContext) => ({
      security: {
        auditId: "audit-network-denial",
        route: "sandbox" as const,
        executionSurface: "verified-sandbox" as const,
        confinement: "verified-baseline" as const,
        routeReason: "verified-local-macos" as const,
        ...routeContext,
        executionPolicy: "sandbox-baseline-v2" as const,
        preparedAt: 100,
      },
      execute: async () => ({
        exit_code: 1,
        output: "network denied",
        output_captured: true,
        terminal_id: "sandbox-network-denial",
        command_sent: true,
        process_launched: true,
        execution_mode: "sandbox_pty" as const,
        sandbox: {
          policyVersion: "policy-v1",
          profileId: "workspace-write",
          backend: "seatbelt",
          capabilities: {
            backend: "seatbelt",
            processTree: true,
            filesystemRead: "host-visible" as const,
            filesystemWrite: "strict" as const,
            network: "blocked" as const,
            privateHome: false,
            privateTmp: false,
            hostIpcBlocked: true,
            resourceLimits: "partial" as const,
            warnings: [],
          },
          violations: [violation],
        },
      }),
      dispose: vi.fn(),
    }));
    const review = vi.fn();
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "npm view vite version" },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-network-no-native-retry",
      undefined,
      {
        terminalProvider: { ...terminalProvider, prepareExecution },
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review },
      },
    );

    expect(prepareExecution).toHaveBeenCalledOnce();
    expect(review).not.toHaveBeenCalled();
    expect(textPayload(result)).toMatchObject({
      exit_code: 1,
      capability_denial: violation,
      retry_outcome: "not_attempted",
      retry_reason: expect.stringContaining(
        "Managed network capability review",
      ),
      execution_attempts: [{ attempt: 1, route: "sandbox" }],
    });
  });

  it("requires a reason before preparing managed public network", async () => {
    const prepareExecution = vi.fn();
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      {
        command: "npm view vite version",
        sandbox_permissions: "require_managed_network",
        reason: "   ",
      },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-managed-network-no-reason",
      undefined,
      { terminalProvider: { ...terminalProvider, prepareExecution } },
    );

    expect(textPayload(result)).toEqual({
      status: "rejected",
      command: "npm view vite version",
      reason:
        'sandbox_permissions="require_managed_network" requires a non-empty reason explaining why the additional authority is needed.',
      command_sent: false,
    });
    expect(prepareExecution).not.toHaveBeenCalled();
  });

  it("keeps managed public network sandboxed and reviews each live destination", async () => {
    const networkRequest = {
      requestId: "network-1",
      sessionId: "session-managed-network",
      auditId: "audit-managed-network",
      terminalId: "sandbox-network-1",
      commandId: "command-1",
      generation: 1,
      command: "npm view vite version",
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
    const execute = vi.fn();
    const prepareExecution = vi.fn(async (options, routeContext) => ({
      security: {
        auditId: "audit-managed-network",
        route: "sandbox" as const,
        executionSurface: "verified-sandbox" as const,
        confinement: "verified-baseline" as const,
        routeReason: "verified-local-macos" as const,
        ...routeContext,
        executionPolicy: "sandbox-baseline-v2" as const,
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
            filesystemRead: "host-visible" as const,
            filesystemWrite: "strict" as const,
            network: "proxy-only" as const,
            privateHome: false,
            privateTmp: false,
            hostIpcBlocked: false,
            resourceLimits: "partial" as const,
            warnings: [],
          },
          grant: { grantId: "grant-1", auditId: "network-audit-1" },
        },
      },
      execute: async () => {
        const decision = await options.onManagedNetworkRequest?.(
          networkRequest,
          new AbortController().signal,
        );
        execute(decision);
        return {
          exit_code: 0,
          output: "7.0.0",
          output_captured: true,
          terminal_id: "sandbox-network-1",
          command_sent: true,
          process_launched: true,
          execution_mode: "sandbox_pty" as const,
        };
      },
      dispose: vi.fn(),
    }));
    const enqueueCommandApproval = vi.fn();
    const review = vi.fn(async () => ({
      outcome: "allow" as const,
      risk: "medium" as const,
      userAuthorization: "high" as const,
      rationale: "Routine package registry lookup",
      model: "review-model",
      status: "reviewed" as const,
    }));
    const networkReview = vi.fn(async () => ({
      outcome: "allow" as const,
      risk: "low" as const,
      userAuthorization: "high" as const,
      rationale: "Authorized package registry destination",
      model: "network-review-model",
      status: "reviewed" as const,
    }));
    const evaluateNetworkRules = vi.fn(() => ({
      key: "https://registry.npmjs.org:443",
      decision: "unmatched" as const,
      matches: [],
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      {
        command: "npm view vite version",
        sandbox_permissions: "require_managed_network",
        reason: "Read public package metadata from the npm registry.",
      },
      {
        isCommandApproved: () => true,
        findMatchingCommandRule: vi.fn(() => ({
          rule: {
            pattern: "npm view vite version",
            mode: "exact",
            decision: "allow",
          },
          scope: "project",
        })),
        evaluateNetworkRules,
      } as never,
      { isRecentlyApproved: () => true, enqueueCommandApproval } as never,
      "session-managed-network",
      undefined,
      {
        terminalProvider: { ...terminalProvider, prepareExecution },
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review },
        networkApprovalReviewer: { review: networkReview },
        isSessionActive: () => true,
      },
    );

    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "npm view vite version",
        sandboxCapabilityRequest: { unrestrictedPublicNetwork: true },
        onManagedNetworkRequest: expect.any(Function),
      }),
      expect.objectContaining({
        requiredAuthority: "sandbox",
        permissionIntent: "additional-permissions",
        approvalRequirement: "explicit-permissions",
        authorityReason: "additional-permissions",
      }),
    );
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "npm view vite version",
        reason: "Read public package metadata from the npm registry.",
        security: expect.objectContaining({
          route: "sandbox",
          permissionIntent: "additional-permissions",
          sandbox: expect.objectContaining({
            capabilities: expect.objectContaining({ network: "proxy-only" }),
            grant: { grantId: "grant-1", auditId: "network-audit-1" },
          }),
        }),
      }),
    );
    expect(networkReview).toHaveBeenCalledWith(
      expect.objectContaining({
        request: networkRequest,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(evaluateNetworkRules).toHaveBeenCalledTimes(2);
    expect(enqueueCommandApproval).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith("allow-once");
    expect(textPayload(result)).toMatchObject({
      exit_code: 0,
      approval: {
        by: "model_reviewer",
        outcome: "allow",
        rationale: "Routine package registry lookup",
      },
      security: {
        route: "sandbox",
        permissionIntent: "additional-permissions",
        sandbox: {
          capabilities: { network: "proxy-only" },
          grant: { grantId: "grant-1", auditId: "network-audit-1" },
        },
      },
    });
  });

  it.each(["session", "project", "global"] as const)(
    "saves and reuses an exact %s managed-network rule",
    async (scope) => {
      const request = {
        requestId: "network-save-1",
        sessionId: `session-network-${scope}`,
        auditId: "audit-network-save",
        terminalId: "sandbox-network-save",
        commandId: "command-network-save",
        generation: 1,
        command: "npm view vite version",
        cwd: "/workspace",
        reason: "Read public package metadata",
        host: "registry.npmjs.org",
        protocol: "https" as const,
        port: 443,
        address: "104.16.24.34",
        family: 4 as const,
        dnsAnswers: [{ address: "104.16.24.34", family: 4 as const }],
        destinationClass: "public" as const,
      };
      let saved = false;
      const decisions: string[] = [];
      const addNetworkRule = vi.fn(() => {
        saved = true;
        return true;
      });
      const evaluateNetworkRules = vi.fn(() => ({
        key: "https://registry.npmjs.org:443",
        decision: saved ? ("allow" as const) : ("prompt" as const),
        matches: [],
      }));
      const enqueueNetworkApproval = vi.fn(() => ({
        promise: Promise.resolve({ decision: `allow-${scope}` }),
      }));
      const prepareExecution = vi.fn(async (options, routeContext) => ({
        security: {
          auditId: "audit-network-save",
          route: "sandbox" as const,
          executionSurface: "verified-sandbox" as const,
          confinement: "verified-baseline" as const,
          routeReason: "verified-local-macos" as const,
          ...routeContext,
          executionPolicy: "sandbox-baseline-v2" as const,
          preparedAt: 100,
          sandbox: {
            attestationId: "attestation-1",
            attestationVersion: "sandbox-behavior-v1",
            policyVersion: "policy-v1",
            profileId: "workspace-write",
            backend: "seatbelt" as const,
            architecture: "arm64" as const,
            capabilities: { network: "proxy-only" as const },
            grant: { grantId: "grant-save", auditId: "network-audit-save" },
          },
        },
        execute: async () => {
          decisions.push(
            await options.onManagedNetworkRequest(
              request,
              new AbortController().signal,
            ),
          );
          decisions.push(
            await options.onManagedNetworkRequest(
              { ...request, requestId: "network-save-2" },
              new AbortController().signal,
            ),
          );
          return {
            exit_code: 0,
            output: "7.0.0",
            output_captured: true,
            terminal_id: "sandbox-network-save",
            command_sent: true,
            process_launched: true,
            execution_mode: "sandbox_pty" as const,
          };
        },
        dispose: vi.fn(),
      }));
      const commandReview = vi.fn(async () => ({
        outcome: "allow" as const,
        risk: "low" as const,
        userAuthorization: "high" as const,
        rationale: "Authorized package metadata lookup",
        model: "review-model",
        status: "reviewed" as const,
      }));
      const networkReview = vi.fn();
      const { handleExecuteCommand } = await import("./executeCommand.js");

      const result = await handleExecuteCommand(
        {
          command: "npm view vite version",
          sandbox_permissions: "require_managed_network",
          reason: "Read public package metadata from the npm registry.",
        },
        {
          isCommandApproved: () => true,
          findMatchingCommandRule: vi.fn(() => ({
            rule: {
              pattern: "npm view vite version",
              mode: "exact",
              decision: "allow",
            },
            scope: "project",
          })),
          evaluateNetworkRules,
          addNetworkRule,
        } as never,
        {
          isRecentlyApproved: () => true,
          enqueueCommandApproval: vi.fn(),
          enqueueNetworkApproval,
        } as never,
        `session-network-${scope}`,
        undefined,
        {
          terminalProvider: { ...terminalProvider, prepareExecution },
          getCommandApprovalPolicy: () => "approve-for-me",
          commandApprovalReviewer: { review: commandReview },
          networkApprovalReviewer: { review: networkReview },
          isSessionActive: () => true,
        },
      );

      expect(textPayload(result).exit_code).toBe(0);
      expect(decisions).toEqual(["allow-once", "allow-once"]);
      expect(enqueueNetworkApproval).toHaveBeenCalledOnce();
      expect(networkReview).not.toHaveBeenCalled();
      expect(addNetworkRule).toHaveBeenCalledWith(
        `session-network-${scope}`,
        {
          pattern: "https://registry.npmjs.org:443",
          mode: "exact",
          decision: "allow",
        },
        scope,
      );
      expect(evaluateNetworkRules).toHaveBeenCalledTimes(3);
    },
  );

  it("rejects a forbidden managed-network destination without review or UI", async () => {
    const decision = vi.fn();
    const prepareExecution = vi.fn(async (options, routeContext) => ({
      security: {
        auditId: "audit-network-forbidden",
        route: "sandbox" as const,
        executionSurface: "verified-sandbox" as const,
        confinement: "verified-baseline" as const,
        routeReason: "verified-local-macos" as const,
        ...routeContext,
        executionPolicy: "sandbox-baseline-v2" as const,
        preparedAt: 100,
      },
      execute: async () => {
        decision(
          await options.onManagedNetworkRequest(
            {
              requestId: "network-forbidden",
              sessionId: "session-network-forbidden",
              auditId: "audit-network-forbidden",
              terminalId: "sandbox-network-forbidden",
              commandId: "command-network-forbidden",
              generation: 1,
              command: "npm view vite version",
              cwd: "/workspace",
              reason: "Read public package metadata",
              host: "registry.npmjs.org",
              protocol: "https",
              port: 443,
              address: "104.16.24.34",
              family: 4,
              dnsAnswers: [{ address: "104.16.24.34", family: 4 }],
              destinationClass: "public",
            },
            new AbortController().signal,
          ),
        );
        return {
          exit_code: 1,
          output: "network rejected",
          output_captured: true,
          terminal_id: "sandbox-network-forbidden",
          command_sent: true,
          process_launched: true,
          execution_mode: "sandbox_pty" as const,
        };
      },
      dispose: vi.fn(),
    }));
    const commandReview = vi.fn(async () => ({
      outcome: "allow" as const,
      risk: "low" as const,
      userAuthorization: "high" as const,
      rationale: "Authorized package metadata lookup",
      model: "review-model",
      status: "reviewed" as const,
    }));
    const networkReview = vi.fn();
    const enqueueNetworkApproval = vi.fn();
    const { handleExecuteCommand } = await import("./executeCommand.js");

    await handleExecuteCommand(
      {
        command: "npm view vite version",
        sandbox_permissions: "require_managed_network",
        reason: "Read public package metadata from the npm registry.",
      },
      {
        isCommandApproved: () => true,
        findMatchingCommandRule: vi.fn(),
        evaluateNetworkRules: vi.fn(() => ({
          key: "https://registry.npmjs.org:443",
          decision: "forbidden",
          matches: [{ scope: "project" }],
        })),
      } as never,
      {
        isRecentlyApproved: () => true,
        enqueueCommandApproval: vi.fn(),
        enqueueNetworkApproval,
      } as never,
      "session-network-forbidden",
      undefined,
      {
        terminalProvider: { ...terminalProvider, prepareExecution },
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review: commandReview },
        networkApprovalReviewer: { review: networkReview },
        isSessionActive: () => true,
      },
    );

    expect(decision).toHaveBeenCalledWith("reject");
    expect(networkReview).not.toHaveBeenCalled();
    expect(enqueueNetworkApproval).not.toHaveBeenCalled();
  });

  it("rejects a late managed-network allow after tool cancellation", async () => {
    let resolveApproval!: (value: { decision: "allow-once" }) => void;
    const pendingApproval = new Promise<{ decision: "allow-once" }>(
      (resolve) => {
        resolveApproval = resolve;
      },
    );
    const controller = new AbortController();
    const decision = vi.fn();
    const enqueueNetworkApproval = vi.fn(() => ({ promise: pendingApproval }));
    const prepareExecution = vi.fn(async (options, routeContext) => ({
      security: {
        auditId: "audit-network-cancelled",
        route: "sandbox" as const,
        executionSurface: "verified-sandbox" as const,
        confinement: "verified-baseline" as const,
        routeReason: "verified-local-macos" as const,
        ...routeContext,
        executionPolicy: "sandbox-baseline-v2" as const,
        preparedAt: 100,
      },
      execute: async () => {
        decision(
          await options.onManagedNetworkRequest(
            {
              requestId: "network-cancelled",
              sessionId: "session-network-cancelled",
              auditId: "audit-network-cancelled",
              terminalId: "sandbox-network-cancelled",
              commandId: "command-network-cancelled",
              generation: 1,
              command: "npm view vite version",
              cwd: "/workspace",
              reason: "Read public package metadata",
              host: "registry.npmjs.org",
              protocol: "https",
              port: 443,
              address: "104.16.24.34",
              family: 4,
              dnsAnswers: [{ address: "104.16.24.34", family: 4 }],
              destinationClass: "public",
            },
            new AbortController().signal,
          ),
        );
        return {
          exit_code: 1,
          output: "network cancelled",
          output_captured: true,
          terminal_id: "sandbox-network-cancelled",
          command_sent: true,
          process_launched: true,
          execution_mode: "sandbox_pty" as const,
        };
      },
      dispose: vi.fn(),
    }));
    const commandReview = vi.fn(async () => ({
      outcome: "allow" as const,
      risk: "low" as const,
      userAuthorization: "high" as const,
      rationale: "Authorized package metadata lookup",
      model: "review-model",
      status: "reviewed" as const,
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");
    const result = handleExecuteCommand(
      {
        command: "npm view vite version",
        sandbox_permissions: "require_managed_network",
        reason: "Read public package metadata from the npm registry.",
      },
      {
        isCommandApproved: () => true,
        findMatchingCommandRule: vi.fn(),
        evaluateNetworkRules: vi.fn(() => ({
          key: "https://registry.npmjs.org:443",
          decision: "prompt",
          matches: [{ scope: "project" }],
        })),
      } as never,
      {
        isRecentlyApproved: () => true,
        enqueueCommandApproval: vi.fn(),
        enqueueNetworkApproval,
      } as never,
      "session-network-cancelled",
      undefined,
      {
        terminalProvider: { ...terminalProvider, prepareExecution },
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review: commandReview },
        isSessionActive: () => true,
        toolAbortSignal: controller.signal,
      },
    );
    await vi.waitFor(() =>
      expect(enqueueNetworkApproval).toHaveBeenCalledOnce(),
    );
    controller.abort();
    resolveApproval({ decision: "allow-once" });
    await result;

    expect(decision).toHaveBeenCalledWith("reject");
  });

  it("keeps use_default sandbox-routed under Approve for Me", async () => {
    const { handleExecuteCommand } = await import("./executeCommand.js");

    await handleExecuteCommand(
      { command: "pwd", sandbox_permissions: "use_default" },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-default-permissions",
      undefined,
      {
        terminalProvider,
        getCommandApprovalPolicy: () => "approve-for-me",
      },
    );

    expect(terminalProvider.prepareExecution).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        requiredAuthority: "sandbox",
        permissionIntent: "default",
        approvalRequirement: "policy",
        authorityReason: "approval-policy",
      }),
    );
  });

  it("rejects native escalation in read-only command mode", async () => {
    const prepareExecution = vi.fn();
    const enqueueCommandApproval = vi.fn();
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      {
        command: "pwd",
        sandbox_permissions: "require_escalated",
        reason: "Needs host execution.",
      },
      { isCommandApproved: () => false } as never,
      { enqueueCommandApproval } as never,
      "session-readonly-escalation",
      undefined,
      {
        terminalProvider: { ...terminalProvider, prepareExecution },
        commandExecutionPolicy: "read-only",
      },
    );

    expect(textPayload(result)).toEqual({
      status: "rejected",
      command: "pwd",
      reason:
        "Read-only command execution does not allow the sandbox_permissions parameter",
      command_sent: false,
    });
    expect(prepareExecution).not.toHaveBeenCalled();
    expect(enqueueCommandApproval).not.toHaveBeenCalled();
  });

  it("allows commands to run from a sibling workspace root", async () => {
    getWorkspaceRoots.mockReturnValue([
      "/workspace/project-a",
      "/workspace/project-b",
    ]);
    tryGetFirstWorkspaceRoot.mockReturnValue("/workspace/project-a");
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      {
        command: "touch output.txt",
        cwd: "/workspace/project-b",
      },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-a",
      undefined,
      { terminalProvider },
    );

    expect(textPayload(result)).toMatchObject({
      exit_code: 0,
      command_sent: true,
    });
    expect(executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "touch output.txt",
        cwd: "/workspace/project-b",
      }),
    );
  });

  it("forwards env map to TerminalProvider.executeCommand", async () => {
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      {
        command: "go test ./...",
        env: { CI: "1", GOFLAGS: "-count=1" },
      },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-1",
      undefined,
      { terminalProvider },
    );

    expect(textPayload(result).approval).toEqual({ by: "master_bypass" });
    expect(terminalProvider.executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand.mock.calls[0][0]).toMatchObject({
      command: "go test ./...",
      env: { CI: "1", GOFLAGS: "-count=1" },
    });
  });

  it("forwards terminal assignment to tracker context", async () => {
    const trackerCtx = { setTerminalId: vi.fn() };
    vi.mocked(terminalProvider.executeCommand).mockImplementationOnce(
      async (options) => {
        options.onTerminalAssigned?.("term_tracker");
        return {
          exit_code: 0,
          output: "ok",
          output_captured: true,
          terminal_id: "term_tracker",
        };
      },
    );
    const { handleExecuteCommand } = await import("./executeCommand.js");

    await handleExecuteCommand(
      { command: "go test ./..." },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-tracker",
      trackerCtx as never,
      { terminalProvider },
    );

    expect(trackerCtx.setTerminalId).toHaveBeenCalledWith("term_tracker");
  });

  it("materializes inline files, substitutes temp paths, and cleans up", async () => {
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      {
        command: "gh pr comment 1 --body-file $AL_FILE(body)",
        files: [{ name: "body", content: "hello `code`", ext: "md" }],
      },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-inline",
      undefined,
      { terminalProvider },
    );

    expect(validateCommand).toHaveBeenCalledWith(
      expect.stringMatching(/^gh pr comment 1 --body-file '\/.*\/body\.md'$/),
    );
    expect(executeCommand).toHaveBeenCalledTimes(1);
    const executedOptions = executeCommand.mock.calls[0][0];
    const executed = executedOptions.command as string;
    expect(executed).toMatch(/^gh pr comment 1 --body-file '\/.*\/body\.md'$/);
    expect(executedOptions.sandboxInlineFiles).toEqual([
      {
        name: "body",
        path: expect.stringMatching(/\/agentlink-cmd-[^/]+\/body\.md$/),
        bytes: Buffer.byteLength("hello `code`", "utf-8"),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    const tempPath = executed.match(/'([^']+\/body\.md)'/)?.[1];
    expect(tempPath).toBeTruthy();
    expect(fs.existsSync(tempPath!)).toBe(false);

    const payload = textPayload(result);
    expect(payload.command_template).toBe(
      "gh pr comment 1 --body-file $AL_FILE(body)",
    );
    expect(payload.inline_files).toEqual([
      {
        name: "body",
        bytes: Buffer.byteLength("hello `code`", "utf-8"),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
  });

  it("defers inline-file cleanup for background commands", async () => {
    let finalizeCommand!: () => void;
    vi.mocked(terminalProvider.executeCommand).mockImplementationOnce(
      async (options) => {
        options.onCommandFinalizationDeferred?.();
        finalizeCommand = () => options.onCommandFinalized?.();
        return {
          exit_code: null,
          output: "started",
          output_captured: true,
          terminal_id: "term_inline_background",
          backgrounded: true,
          is_running: true,
        };
      },
    );
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      {
        command: "cat $AL_FILE(body)",
        background: true,
        files: [{ name: "body", content: "hello" }],
      },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-inline-background",
      undefined,
      { terminalProvider },
    );

    const executed = vi.mocked(terminalProvider.executeCommand).mock.calls[0][0]
      .command;
    const tempPath = executed.match(/'([^']+\/body)'/)?.[1];
    expect(tempPath).toBeTruthy();
    expect(fs.existsSync(tempPath!)).toBe(true);
    expect(textPayload(result)).toMatchObject({
      backgrounded: true,
      is_running: true,
      terminal_id: "term_inline_background",
    });

    finalizeCommand();
    expect(fs.existsSync(tempPath!)).toBe(false);
    finalizeCommand();
    expect(fs.existsSync(tempPath!)).toBe(false);
  });

  it("prompts inline-file commands even when tier auto-approval is enabled", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "masterBypass") return false;
        if (key === "commandAutoApproveTier") return "safe";
        return fallback;
      }),
    });
    const enqueueCommandApproval = vi.fn(() => ({
      promise: Promise.resolve({ decision: "accept" }),
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      {
        command: "git status --short --porcelain=v1 $AL_FILE(body)",
        files: [{ name: "body", content: "hello" }],
      },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      {
        isRecentlyApproved: () => true,
        enqueueCommandApproval,
      } as never,
      "session-inline-human",
      undefined,
      { terminalProvider },
    );

    expect(enqueueCommandApproval).toHaveBeenCalledTimes(1);
    const approvalCall = enqueueCommandApproval.mock.calls[0] as unknown[];
    expect(approvalCall[0]).toMatch(
      /^git status --short --porcelain=v1 '\/.*\/body'$/,
    );
    expect(approvalCall[1]).toBe(
      "git status --short --porcelain=v1 $AL_FILE(body)",
    );
    expect(
      (approvalCall[2] as { inlineFiles?: unknown[] }).inlineFiles,
    ).toMatchObject([{ name: "body", bytes: 5, preview: "hello" }]);
    expect(textPayload(result).approval).toEqual({ by: "human" });
  });

  it("lets the reviewer approve a bounded inline-file copy in a verified sandbox", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const enqueueCommandApproval = vi.fn();
    const review = vi.fn(async (input) => {
      expect(input).toMatchObject({
        command:
          "mkdir -p tmp && cp $AL_FILE(input) tmp/approve-for-me-smoke.txt",
        inlineFiles: [
          {
            name: "input",
            bytes: 14,
            preview: "sandbox smoke\n",
            executable: false,
            truncated: false,
          },
        ],
      });
      return {
        outcome: "allow" as const,
        risk: "medium" as const,
        userAuthorization: "high" as const,
        rationale: "Bounded workspace file creation from immutable input",
        model: "review-model",
        status: "reviewed" as const,
      };
    });
    let executedSourcePath = "";
    const prepareExecution = vi.fn(async (options) => ({
      security: {
        auditId: "audit-inline-sandbox",
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
      },
      execute: async () => {
        executedSourcePath = options.sandboxInlineFiles?.[0]?.path ?? "";
        expect(fs.existsSync(executedSourcePath)).toBe(true);
        expect(fs.realpathSync(executedSourcePath)).toBe(executedSourcePath);
        return {
          exit_code: 0,
          output: "",
          output_captured: true,
          terminal_id: "sandbox-inline-1",
        };
      },
      dispose: vi.fn(),
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      {
        command:
          "mkdir -p tmp && cp $AL_FILE(input) tmp/approve-for-me-smoke.txt",
        files: [{ name: "input", content: "sandbox smoke\n", ext: "txt" }],
      },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      {
        isRecentlyApproved: () => false,
        enqueueCommandApproval,
      } as never,
      "session-inline-reviewer",
      undefined,
      {
        terminalProvider: { ...terminalProvider, prepareExecution },
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review },
        isSessionActive: () => true,
      },
    );

    expect(review).toHaveBeenCalledTimes(1);
    expect(enqueueCommandApproval).not.toHaveBeenCalled();
    expect(executedSourcePath).toMatch(/\/agentlink-cmd-[^/]+\/input\.txt$/);
    expect(fs.existsSync(executedSourcePath)).toBe(false);
    expect(textPayload(result).approval).toMatchObject({
      by: "model_reviewer",
      model: "review-model",
    });
  });

  it("rejects edited inline-file commands with unresolved tokens", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "masterBypass") return false;
        return fallback;
      }),
    });
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      {
        command: "cat $AL_FILE(body)",
        files: [{ name: "body", content: "hello" }],
      },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      {
        isRecentlyApproved: () => false,
        enqueueCommandApproval: () => ({
          promise: Promise.resolve({
            decision: "edit",
            editedCommand: "cat $AL_FILE(body)",
          }),
        }),
      } as never,
      "session-inline-edited-token",
      undefined,
      { terminalProvider },
    );

    expect(executeCommand).not.toHaveBeenCalled();
    expect(textPayload(result)).toMatchObject({ status: "rejected" });
  });

  it("omits duplicate terminal raw output from the model-facing result", async () => {
    executeCommand.mockResolvedValue({
      exit_code: 0,
      output: "one\ntwo\nthree",
      terminal_raw_output:
        "\u001b[31mone\u001b[0m\n\u001b[32mtwo\u001b[0m\n\u001b[33mthree\u001b[0m",
      output_captured: true,
      terminal_id: "term_1",
    });

    const { handleExecuteCommand } = await import("./executeCommand.js");
    const result = await handleExecuteCommand(
      {
        command: "printf lines",
        output_tail: 2,
      },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-raw",
      undefined,
      { terminalProvider },
    );

    const payload = textPayload(result);
    expect(payload.output).toBe("two\nthree");
    expect(payload.terminal_raw_output).toBeUndefined();
  });

  it("reports line counts as retained while output is not finalized", async () => {
    executeCommand.mockResolvedValue({
      exit_code: null,
      output: "one\ntwo",
      output_captured: true,
      terminal_id: "term-running-lines",
      is_running: true,
      backgrounded: true,
    });
    const getRetainedOutput = vi.fn(() => ({
      output: "one\ntwo",
      complete: true,
      finalized: false,
      total_bytes: 7,
      retained_bytes: 7,
      dropped_bytes: 0,
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "printf lines" },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-running-lines",
      undefined,
      { terminalProvider: { ...terminalProvider, getRetainedOutput } },
    );

    expect(textPayload(result)).toMatchObject({
      total_lines: 2,
      lines_shown: 2,
      total_lines_scope: "retained",
      output_complete: true,
      output_finalized: false,
      output_warning: expect.stringContaining("retained output so far"),
    });
  });

  it("rejects malformed shell commands before masterBypass and force handling", async () => {
    const enqueueCommandApproval = vi.fn();
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const command = `echo "unterminated && rm -rf tmp`;
    const result = await handleExecuteCommand(
      {
        command,
        force: true,
        force_reason: "malformed shell should not be force-bypassable",
      },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true, enqueueCommandApproval } as never,
      "session-malformed",
      undefined,
      { terminalProvider },
    );

    expect(enqueueCommandApproval).not.toHaveBeenCalled();
    expect(validateCommand).not.toHaveBeenCalled();
    expect(validateInteractiveCommand).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
    expect(textPayload(result)).toMatchObject({
      status: "rejected",
      command,
      reason: expect.stringContaining("malformed shell syntax"),
      command_sent: false,
    });
  });

  it("rejects malformed materialized inline-file commands and cleans up", async () => {
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      {
        command: `cat "$AL_FILE(body)`,
        files: [{ name: "body", content: "hello" }],
      },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-malformed-inline",
      undefined,
      { terminalProvider },
    );

    expect(validateCommand).not.toHaveBeenCalled();
    expect(validateInteractiveCommand).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();

    const payload = textPayload(result);
    expect(payload).toMatchObject({
      status: "rejected",
      command_template: `cat "$AL_FILE(body)`,
      reason: expect.stringContaining("malformed shell syntax"),
    });
    expect(payload.command).toMatch(/^cat "'\/.*\/body'$/);
    const tempPath = (payload.command as string).match(/'([^']+\/body)'/)?.[1];
    expect(tempPath).toBeTruthy();
    expect(fs.existsSync(tempPath!)).toBe(false);
  });

  it("rejects single-quote dangling escapes before command execution", async () => {
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const command = "echo 'trailing\\";
    const result = await handleExecuteCommand(
      { command },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-malformed-single-quote",
      undefined,
      { terminalProvider },
    );

    expect(validateCommand).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
    expect(textPayload(result)).toMatchObject({
      status: "rejected",
      command,
      reason: expect.stringContaining("malformed shell syntax"),
    });
  });

  it("does not reject opaque but well-formed shell syntax as malformed", async () => {
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const command = "npm test & echo done";
    const result = await handleExecuteCommand(
      { command },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-opaque-shell",
      undefined,
      { terminalProvider },
    );

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand.mock.calls[0][0]).toMatchObject({ command });
    expect(textPayload(result).command).toBeUndefined();
  });

  it("does not reject closed quotes and escaped operators as malformed", async () => {
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const command = String.raw`echo "a && b" && echo left \; right`;
    const result = await handleExecuteCommand(
      { command },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-valid-quoted-escapes",
      undefined,
      { terminalProvider },
    );

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand.mock.calls[0][0]).toMatchObject({ command });
    expect(textPayload(result).command).toBeUndefined();
  });

  it("rejects protected memory writes before masterBypass and force handling", async () => {
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      {
        command: "echo remember >> AGENTS.md",
        force: true,
        force_reason: "test should still reject protected memory writes",
      },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-protected",
      undefined,
      { terminalProvider },
    );

    expect(executeCommand).not.toHaveBeenCalled();
    const textItem = result.content[0];
    expect(textItem.type).toBe("text");
    if (textItem.type !== "text") throw new Error("Expected text result");

    const payload = JSON.parse(textItem.text);
    expect(payload.status).toBe("rejected");
    expect(payload.reason).toContain("protected instructions or memory");
    expect(payload.reason).toContain("force=true cannot bypass");
    expect(payload.command_sent).toBe(false);
  });

  it("reports pipe-validator rejection before terminal dispatch", async () => {
    validateCommand.mockReturnValueOnce({
      type: "pipe",
      message: "Use output_grep instead",
    });
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "npm test | grep failed" },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-pipe-rejected",
      undefined,
      { terminalProvider },
    );

    expect(executeCommand).not.toHaveBeenCalled();
    expect(textPayload(result)).toMatchObject({
      status: "rejected",
      reason: "Use output_grep instead",
      command_sent: false,
    });
  });

  it("reports interactive-validator rejection before terminal dispatch", async () => {
    validateInteractiveCommand.mockReturnValueOnce({
      message: "Command rejected: interactive shell",
    });
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "bash" },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-interactive-rejected",
      undefined,
      { terminalProvider },
    );

    expect(executeCommand).not.toHaveBeenCalled();
    expect(textPayload(result)).toMatchObject({
      status: "rejected",
      reason: "Command rejected: interactive shell",
      command_sent: false,
    });
  });

  it("auto-approves safe commands when the safe threshold is enabled", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "masterBypass") return false;
        if (key === "commandAutoApproveTier") return "safe";
        return fallback;
      }),
    });
    const enqueueCommandApproval = vi.fn();
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "git status --short" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      {
        isRecentlyApproved: () => false,
        enqueueCommandApproval,
      } as never,
      "session-tier-safe",
      undefined,
      {
        terminalProvider,
        getCommandApprovalPolicy: () => "safe",
      },
    );

    expect(enqueueCommandApproval).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledTimes(1);
    const textItem = result.content[0];
    expect(textItem.type).toBe("text");
    if (textItem.type !== "text") throw new Error("Expected text result");
    const payload = JSON.parse(textItem.text);
    expect(payload.approval).toEqual({
      by: "tier",
      tier: "safe",
      threshold: "safe",
    });
    expect(payload.auto_approved).toEqual({
      by: "tier",
      tier: "safe",
      threshold: "safe",
    });
  });

  it("auto-approves workspace-local strings inspection under approve-for-me", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const enqueueCommandApproval = vi.fn();
    const review = vi.fn(async () => {
      throw new Error("guardrail should skip reviewer");
    });
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "strings -a fixtures/app.bin" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      {
        isRecentlyApproved: () => false,
        enqueueCommandApproval,
      } as never,
      "session-strings-inspection",
      undefined,
      {
        terminalProvider,
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review },
      },
    );

    expect(review).not.toHaveBeenCalled();
    expect(enqueueCommandApproval).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(textPayload(result)).toMatchObject({
      approval: {
        by: "tier",
        tier: "safe",
        threshold: "safe",
      },
    });
  });

  it("prompts sensitive commands when only the safe threshold is enabled", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "masterBypass") return false;
        if (key === "commandAutoApproveTier") return "safe";
        return fallback;
      }),
    });
    const enqueueCommandApproval = vi.fn(() => ({
      promise: Promise.resolve({ decision: "accept" }),
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    await handleExecuteCommand(
      { command: "mkdir generated" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      {
        isRecentlyApproved: () => false,
        enqueueCommandApproval,
      } as never,
      "session-tier-prompt-sensitive",
      undefined,
      { terminalProvider },
    );

    expect(enqueueCommandApproval).toHaveBeenCalledTimes(1);
  });

  it("records human approval when the user accepts a prompted command", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "masterBypass") return false;
        if (key === "commandAutoApproveTier") return "safe";
        return fallback;
      }),
    });
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "mkdir generated" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      {
        isRecentlyApproved: () => false,
        enqueueCommandApproval: () => ({
          promise: Promise.resolve({ decision: "accept" }),
        }),
      } as never,
      "session-human",
      undefined,
      { terminalProvider },
    );

    expect(textPayload(result).approval).toEqual({ by: "human" });
  });

  it("records explicit rule approval", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "masterBypass") return false;
        return fallback;
      }),
    });
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "go test ./..." },
      {
        isCommandApproved: () => true,
        findMatchingCommandRule: () => ({
          rule: { pattern: "go test", mode: "prefix" },
          scope: "session",
        }),
      } as never,
      {
        isRecentlyApproved: () => false,
        enqueueCommandApproval: vi.fn(),
      } as never,
      "session-rule",
      undefined,
      { terminalProvider },
    );

    expect(textPayload(result).approval).toEqual({ by: "explicit_rule" });
  });

  it("records an attributed recent approval returned by the panel", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "masterBypass") return false;
        return fallback;
      }),
    });
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "go test ./..." },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      {
        enqueueCommandApproval: vi.fn(() => ({
          promise: Promise.resolve({
            decision: "run-once",
            recentApproval: true,
          }),
        })),
      } as never,
      "session-recent",
      undefined,
      { terminalProvider },
    );

    expect(textPayload(result).approval).toEqual({ by: "recent_approval" });
  });

  it("auto-approves sensitive commands when the sensitive threshold is enabled", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "masterBypass") return false;
        if (key === "commandAutoApproveTier") return "sensitive";
        return fallback;
      }),
    });
    const enqueueCommandApproval = vi.fn();
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "mkdir generated" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      {
        isRecentlyApproved: () => false,
        enqueueCommandApproval,
      } as never,
      "session-tier-sensitive",
      undefined,
      {
        terminalProvider,
        getCommandApprovalPolicy: () => "sensitive",
      },
    );

    expect(enqueueCommandApproval).not.toHaveBeenCalled();
    const textItem = result.content[0];
    expect(textItem.type).toBe("text");
    if (textItem.type !== "text") throw new Error("Expected text result");
    const payload = JSON.parse(textItem.text);
    expect(payload.approval).toEqual({
      by: "tier",
      tier: "sensitive",
      threshold: "sensitive",
    });
    expect(payload.auto_approved).toEqual({
      by: "tier",
      tier: "sensitive",
      threshold: "sensitive",
    });
  });

  it("uses the reviewer for eligible sensitive commands under approve-for-me", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const enqueueCommandApproval = vi.fn();
    const review = vi.fn(async () => ({
      outcome: "allow" as const,
      risk: "medium" as const,
      userAuthorization: "high" as const,
      rationale: "Bounded workspace directory creation",
      model: "review-model",
      status: "reviewed" as const,
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "mkdir generated", reason: "Create generated output folder" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      {
        isRecentlyApproved: () => false,
        enqueueCommandApproval,
      } as never,
      "session-review",
      undefined,
      {
        terminalProvider,
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review },
        isSessionActive: () => true,
        getUserObjective: () => "Generate project output",
      },
    );

    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-review",
        command: "mkdir generated",
        reason: "Create generated output folder",
        userObjective: "Generate project output",
      }),
    );
    expect(enqueueCommandApproval).not.toHaveBeenCalled();
    expect(textPayload(result)).toMatchObject({
      approval: {
        by: "model_reviewer",
        model: "review-model",
        tier: "sensitive",
        outcome: "allow",
        risk: "medium",
        user_authorization: "high",
        rationale: "Bounded workspace directory creation",
      },
    });
    expect(textPayload(result).auto_approved).toBeUndefined();
  });

  it("falls through to the human card when the reviewer asks the user", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const enqueueCommandApproval = vi.fn(() => ({
      promise: Promise.resolve({ decision: "accept" }),
    }));
    const review = vi.fn(async () => ({
      outcome: "deny" as const,
      risk: "high" as const,
      userAuthorization: "unknown" as const,
      rationale: "Intent is ambiguous",
      model: "review-model",
      status: "reviewed" as const,
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "mkdir generated" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      { isRecentlyApproved: () => false, enqueueCommandApproval } as never,
      "session-review-escalate",
      undefined,
      {
        terminalProvider,
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review },
        isSessionActive: () => true,
      },
    );

    expect(review).toHaveBeenCalledTimes(1);
    expect(enqueueCommandApproval).toHaveBeenCalledTimes(1);
    expect(enqueueCommandApproval).toHaveBeenCalledWith(
      "mkdir generated",
      "mkdir generated",
      expect.objectContaining({
        commandReview: expect.objectContaining({
          outcome: "deny",
          risk: "high",
          userAuthorization: "unknown",
          rationale: "Intent is ambiguous",
        }),
      }),
    );
    expect(textPayload(result).approval).toEqual({ by: "human" });
  });

  it("does not execute when a pending human approval resolves after cancellation", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    let resolveApproval!: (response: { decision: "accept" }) => void;
    const approvalPromise = new Promise<{ decision: "accept" }>((resolve) => {
      resolveApproval = resolve;
    });
    const enqueueCommandApproval = vi.fn(() => ({ promise: approvalPromise }));
    const controller = new AbortController();
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const execution = handleExecuteCommand(
      { command: "mkdir generated" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      { isRecentlyApproved: () => false, enqueueCommandApproval } as never,
      "session-review-cancelled",
      undefined,
      {
        terminalProvider,
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: {
          review: async () => ({
            outcome: "deny",
            risk: "high",
            userAuthorization: "unknown",
            rationale: "Needs human confirmation",
            model: "review-model",
            status: "reviewed",
          }),
        },
        isSessionActive: () => true,
        toolAbortSignal: controller.signal,
      },
    );

    await vi.waitFor(() => {
      expect(enqueueCommandApproval).toHaveBeenCalledTimes(1);
    });
    controller.abort();
    resolveApproval({ decision: "accept" });

    await expect(execution.then(textPayload)).resolves.toMatchObject({
      status: "cancelled",
      command: "mkdir generated",
      reason: "Command approval was cancelled before execution",
      security: {
        route: "sandbox",
        confinement: "verified-baseline",
      },
      command_sent: false,
    });
    expect(terminalProvider.executeCommand).not.toHaveBeenCalled();
  });

  it("lets the reviewer approve a confidently recognized unknown executable", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const enqueueCommandApproval = vi.fn();
    const review = vi.fn(async () => ({
      outcome: "allow" as const,
      risk: "low" as const,
      userAuthorization: "high" as const,
      rationale: "Recognized read-only binary inspection",
      model: "review-model",
      status: "reviewed" as const,
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "otool -L fixtures/app.bin" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      { isRecentlyApproved: () => false, enqueueCommandApproval } as never,
      "session-review-unknown-approved",
      undefined,
      {
        terminalProvider,
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review },
        isSessionActive: () => true,
      },
    );

    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "otool -L fixtures/app.bin",
        classified: expect.objectContaining({ tier: "sensitive" }),
      }),
    );
    expect(enqueueCommandApproval).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(textPayload(result).approval).toMatchObject({
      by: "model_reviewer",
      model: "review-model",
      rationale: "Recognized read-only binary inspection",
    });
  });

  it("sends execution-context evidence to Guardian and falls back on deny", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const enqueueCommandApproval = vi.fn(() => ({
      promise: Promise.resolve({ decision: "accept" }),
    }));
    const review = vi.fn(async () => ({
      outcome: "deny" as const,
      risk: "high" as const,
      userAuthorization: "unknown" as const,
      rationale: "Executable is unfamiliar",
      model: "review-model",
      status: "reviewed" as const,
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");
    const providers = {
      terminalProvider,
      getCommandApprovalPolicy: () => "approve-for-me" as const,
      commandApprovalReviewer: { review },
      isSessionActive: () => true,
    };

    await handleExecuteCommand(
      { command: "unknown-tool run" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      { isRecentlyApproved: () => false, enqueueCommandApproval } as never,
      "session-review-unknown",
      undefined,
      providers,
    );
    await handleExecuteCommand(
      { command: "mkdir generated", env: { CI: "1" } },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      { isRecentlyApproved: () => false, enqueueCommandApproval } as never,
      "session-review-env",
      undefined,
      providers,
    );

    expect(review).toHaveBeenCalledTimes(2);
    expect(review).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ command: "unknown-tool run" }),
    );
    expect(review).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ command: "mkdir generated" }),
    );
    expect(enqueueCommandApproval).toHaveBeenCalledTimes(2);
    expect(enqueueCommandApproval).toHaveBeenLastCalledWith(
      "mkdir generated",
      "mkdir generated",
      expect.objectContaining({
        commandReview: expect.objectContaining({
          outcome: "deny",
          risk: "high",
          userAuthorization: "unknown",
        }),
        humanOnlyReason: undefined,
      }),
    );
  });

  it("lets Guardian allow a dangerous network command when authorized", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const enqueueCommandApproval = vi.fn(() => ({
      promise: Promise.resolve({ decision: "accept" }),
    }));
    const review = vi.fn(async () => ({
      outcome: "allow" as const,
      risk: "low" as const,
      userAuthorization: "high" as const,
      rationale: "Exactly authorized network action",
      model: "review-model",
      status: "reviewed" as const,
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "git push origin main" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      { isRecentlyApproved: () => false, enqueueCommandApproval } as never,
      "session-review-dangerous",
      undefined,
      {
        terminalProvider,
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review },
        isSessionActive: () => true,
      },
    );

    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({ command: "git push origin main" }),
    );
    expect(enqueueCommandApproval).not.toHaveBeenCalled();
    expect(textPayload(result).approval).toMatchObject({
      by: "model_reviewer",
      tier: "dangerous",
      outcome: "allow",
      risk: "low",
      user_authorization: "high",
      rationale: "Exactly authorized network action",
    });
  });

  it("sends non-temp outside paths to Guardian", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const enqueueCommandApproval = vi.fn(() => ({
      promise: Promise.resolve({ decision: "accept" }),
    }));
    const review = vi.fn(async () => ({
      outcome: "deny" as const,
      risk: "high" as const,
      userAuthorization: "unknown" as const,
      rationale: "Outside path is not authorized",
      model: "review-model",
      status: "reviewed" as const,
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    await handleExecuteCommand(
      { command: "custom-tool /outside/input.txt" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      { isRecentlyApproved: () => false, enqueueCommandApproval } as never,
      "session-review-outside",
      undefined,
      {
        terminalProvider,
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review },
        isSessionActive: () => true,
      },
    );

    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({ command: "custom-tool /outside/input.txt" }),
    );
    expect(enqueueCommandApproval).toHaveBeenCalledWith(
      "custom-tool /outside/input.txt",
      "custom-tool /outside/input.txt",
      expect.objectContaining({
        commandReview: expect.objectContaining({
          outcome: "deny",
          rationale: "Outside path is not authorized",
        }),
        humanOnlyReason: undefined,
      }),
    );
  });

  it("lets the reviewer approve read-only extraction from an OS temp file", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const enqueueCommandApproval = vi.fn();
    const review = vi.fn(async () => ({
      outcome: "allow" as const,
      risk: "low" as const,
      userAuthorization: "high" as const,
      rationale: "Read-only extraction from generated test output",
      model: "review-model",
      status: "reviewed" as const,
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");
    const tempOutput = `${os.tmpdir()}/agentlink-output.txt`;
    const command = `awk 'match($0, /testId: "[^"]+"/) { print $0 }' ${tempOutput}`;

    const result = await handleExecuteCommand(
      { command },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      { isRecentlyApproved: () => false, enqueueCommandApproval } as never,
      "session-review-temp-output",
      undefined,
      {
        terminalProvider,
        getCommandApprovalPolicy: () => "approve-for-me",
        commandApprovalReviewer: { review },
        isSessionActive: () => true,
      },
    );

    expect(review).toHaveBeenCalledWith(expect.objectContaining({ command }));
    expect(enqueueCommandApproval).not.toHaveBeenCalled();
    expect(textPayload(result).approval).toMatchObject({
      by: "model_reviewer",
      outcome: "allow",
      risk: "low",
      user_authorization: "high",
    });
  });

  it.each(["high", "critical"] as const)(
    "treats a completed Guardian allow as authoritative at %s risk",
    async (risk) => {
      getConfiguration.mockReturnValue({
        get: vi.fn((key: string, fallback?: unknown) =>
          key === "masterBypass" ? false : fallback,
        ),
      });
      const enqueueCommandApproval = vi.fn(() => ({
        promise: Promise.resolve({ decision: "accept" }),
      }));
      const { handleExecuteCommand } = await import("./executeCommand.js");

      const result = await handleExecuteCommand(
        { command: "mkdir generated" },
        {
          isCommandApproved: () => false,
          findMatchingCommandRule: () => undefined,
        } as never,
        { isRecentlyApproved: () => false, enqueueCommandApproval } as never,
        `session-review-${risk}`,
        undefined,
        {
          terminalProvider,
          getCommandApprovalPolicy: () => "approve-for-me",
          commandApprovalReviewer: {
            review: async () => ({
              outcome: "allow",
              risk,
              userAuthorization: "high",
              rationale: "Exactly authorized action",
              model: "review-model",
              status: "reviewed",
            }),
          },
          isSessionActive: () => true,
        },
      );

      expect(enqueueCommandApproval).not.toHaveBeenCalled();
      expect(textPayload(result).approval).toMatchObject({
        by: "model_reviewer",
        outcome: "allow",
        risk,
        user_authorization: "high",
      });
    },
  );

  it("does not commit approval mutations when policy drifts before execution", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const addCommandRule = vi.fn();
    const commitApprovalRecording = vi.fn();
    const getCommandApprovalPolicy = vi
      .fn<() => "manual" | "safe">()
      .mockReturnValueOnce("manual")
      .mockReturnValueOnce("manual")
      .mockReturnValue("safe");
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "npm install package" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
        addCommandRule,
      } as never,
      {
        isRecentlyApproved: () => false,
        enqueueCommandApproval: () => ({
          promise: Promise.resolve({
            decision: "run-once",
            rules: [
              {
                pattern: "npm install",
                mode: "prefix",
                scope: "session",
              },
            ],
          }),
          commitApprovalRecording,
        }),
      } as never,
      "session-human-policy-drift",
      undefined,
      { terminalProvider, getCommandApprovalPolicy },
    );

    expect(textPayload(result)).toMatchObject({
      status: "retry_required",
      security_failure: "policy_drift",
      command_sent: false,
    });
    expect(commitApprovalRecording).not.toHaveBeenCalled();
    expect(addCommandRule).not.toHaveBeenCalled();
    expect(terminalProvider.executeCommand).not.toHaveBeenCalled();
  });

  it("requires a retry when policy changes during review", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    let policy: "approve-for-me" | "safe" = "approve-for-me";
    const enqueueCommandApproval = vi.fn(() => ({
      promise: Promise.resolve({ decision: "accept" }),
    }));
    const review = vi.fn(async () => {
      policy = "safe";
      return {
        outcome: "allow" as const,
        risk: "medium" as const,
        userAuthorization: "high" as const,
        rationale: "Would otherwise approve",
        model: "review-model",
        status: "reviewed" as const,
      };
    });
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "mkdir generated" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      { isRecentlyApproved: () => false, enqueueCommandApproval } as never,
      "session-review-policy-change",
      undefined,
      {
        terminalProvider,
        getCommandApprovalPolicy: () => policy,
        commandApprovalReviewer: { review },
        isSessionActive: () => true,
      },
    );

    expect(enqueueCommandApproval).not.toHaveBeenCalled();
    expect(terminalProvider.executeCommand).not.toHaveBeenCalled();
    expect(textPayload(result)).toMatchObject({
      status: "retry_required",
      security_failure: "policy_drift",
      command_sent: false,
    });
  });

  it("still prompts dangerous commands at the sensitive threshold", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "masterBypass") return false;
        if (key === "commandAutoApproveTier") return "sensitive";
        return fallback;
      }),
    });
    const enqueueCommandApproval = vi.fn(() => ({
      promise: Promise.resolve({ decision: "accept" }),
    }));
    const { handleExecuteCommand } = await import("./executeCommand.js");

    await handleExecuteCommand(
      { command: "git push origin main" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      {
        isRecentlyApproved: () => false,
        enqueueCommandApproval,
      } as never,
      "session-tier-dangerous",
      undefined,
      { terminalProvider },
    );

    expect(enqueueCommandApproval).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed commands introduced by approval command edits", async () => {
    getConfiguration.mockReturnValueOnce({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "masterBypass") return false;
        return fallback;
      }),
    });
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "echo ok" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      {
        isRecentlyApproved: () => false,
        enqueueCommandApproval: () => ({
          promise: Promise.resolve({
            decision: "accept",
            editedCommand: `echo "unterminated`,
          }),
        }),
      } as never,
      "session-edited-malformed",
      undefined,
      { terminalProvider },
    );

    expect(executeCommand).not.toHaveBeenCalled();
    expect(textPayload(result)).toMatchObject({
      status: "rejected",
      command: `echo "unterminated`,
      original_command: "echo ok",
      reason: expect.stringContaining("malformed shell syntax"),
      command_sent: false,
    });
  });

  it("rejects protected memory writes introduced by approval command edits", async () => {
    getConfiguration.mockReturnValueOnce({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "masterBypass") return false;
        return fallback;
      }),
    });
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "echo ok" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      {
        isRecentlyApproved: () => false,
        enqueueCommandApproval: () => ({
          promise: Promise.resolve({
            decision: "accept",
            editedCommand: "echo remember >> .agentlink/memory.md",
          }),
        }),
      } as never,
      "session-edited-protected",
      undefined,
      { terminalProvider },
    );

    expect(executeCommand).not.toHaveBeenCalled();
    const textItem = result.content[0];
    expect(textItem.type).toBe("text");
    if (textItem.type !== "text") throw new Error("Expected text result");

    const payload = JSON.parse(textItem.text);
    expect(payload.status).toBe("rejected");
    expect(payload.command).toBe("echo remember >> .agentlink/memory.md");
    expect(payload.original_command).toBe("echo ok");
    expect(payload.reason).toContain("protected instructions or memory");
    expect(payload.command_sent).toBe(false);
  });

  it("rejects pipe validation violations introduced by approval command edits", async () => {
    getConfiguration.mockReturnValueOnce({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "masterBypass") return false;
        return fallback;
      }),
    });
    validateCommand.mockReturnValueOnce(null).mockReturnValueOnce({
      type: "pipe",
      message: "Use output_grep instead",
    });
    const { handleExecuteCommand } = await import("./executeCommand.js");

    const result = await handleExecuteCommand(
      { command: "npm test" },
      {
        isCommandApproved: () => false,
        findMatchingCommandRule: () => undefined,
      } as never,
      {
        isRecentlyApproved: () => false,
        enqueueCommandApproval: () => ({
          promise: Promise.resolve({
            decision: "accept",
            editedCommand: "npm test | grep failed",
          }),
        }),
      } as never,
      "session-edited-pipe",
      undefined,
      { terminalProvider },
    );

    expect(executeCommand).not.toHaveBeenCalled();
    const textItem = result.content[0];
    expect(textItem.type).toBe("text");
    if (textItem.type !== "text") throw new Error("Expected text result");
    const payload = JSON.parse(textItem.text);
    expect(payload.status).toBe("rejected");
    expect(payload.command).toBe("npm test | grep failed");
    expect(payload.original_command).toBe("npm test");
    expect(payload.reason).toBe("Use output_grep instead");
    expect(payload.command_sent).toBe(false);
  });

  describe("read-only execution policy", () => {
    const providers = () => ({
      terminalProvider,
      getCommandApprovalPolicy: () => "approve-for-me" as const,
      commandExecutionPolicy: "read-only" as const,
    });

    it("rejects before terminal preparation when Approve for Me is disabled", async () => {
      const enqueueCommandApproval = vi.fn();
      const { handleExecuteCommand } = await import("./executeCommand.js");

      const result = await handleExecuteCommand(
        { command: "git status --short" },
        {
          isCommandApproved: () => false,
          findMatchingCommandRule: () => undefined,
        } as never,
        {
          isRecentlyApproved: () => false,
          enqueueCommandApproval,
        } as never,
        "readonly-native-disabled",
        undefined,
        {
          terminalProvider,
          getCommandApprovalPolicy: () => "safe",
          commandExecutionPolicy: "read-only",
        },
      );

      expect(terminalProvider.prepareExecution).not.toHaveBeenCalled();
      expect(executeCommand).not.toHaveBeenCalled();
      expect(enqueueCommandApproval).not.toHaveBeenCalled();
      expect(textPayload(result)).toMatchObject({
        status: "rejected",
        reason: expect.stringContaining("requires Approve for Me"),
        command_sent: false,
      });
    });

    it("executes a recognized safe command in Sandbox without entering the approval flow", async () => {
      const enqueueCommandApproval = vi.fn();
      const { handleExecuteCommand } = await import("./executeCommand.js");

      const result = await handleExecuteCommand(
        { command: "git status --short", output_head: 20 },
        {
          isCommandApproved: () => false,
          findMatchingCommandRule: () => undefined,
        } as never,
        {
          isRecentlyApproved: () => false,
          enqueueCommandApproval,
        } as never,
        "readonly-safe",
        undefined,
        providers(),
      );

      expect(enqueueCommandApproval).not.toHaveBeenCalled();
      expect(terminalProvider.prepareExecution).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          requiredAuthority: "sandbox",
          permissionIntent: "default",
          approvalRequirement: "policy",
          authorityReason: "approval-policy",
          approvalPolicySnapshot: "on-request" as const,
          approvalReviewerSnapshot: "auto-review" as const,
          executionPresetSnapshot: "workspace-write" as const,
          commandApprovalPolicySnapshot: "approve-for-me",
          commandExecutionPolicySnapshot: "read-only",
        }),
      );
      expect(executeCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "git status --short",
          cwd: "/workspace",
          background: undefined,
          env: undefined,
        }),
      );
      expect(textPayload(result)).toMatchObject({
        approval: { by: "readonly_policy" },
      });
      expect(textPayload(result)).not.toHaveProperty("auto_approved");
    });

    it.each([
      ["unsafe command", { command: "rm -rf src" }, "dangerous command"],
      [
        "unknown command",
        { command: "custom-inspector src" },
        "unrecognized command",
      ],
      [
        "mutating command",
        { command: "mkdir generated" },
        "workspace-local command",
      ],
      [
        "redirected command",
        { command: "echo ok > generated.txt" },
        "shell redirection",
      ],
      [
        "input-redirected command",
        { command: "rg --no-config token < input.txt" },
        "shell redirection",
      ],
      [
        "environment overrides",
        { command: "pwd", env: { CI: "1" } },
        "env parameter",
      ],
      [
        "inline files",
        {
          command: "wc -l $AL_FILE(input)",
          files: [{ name: "input", content: "hello" }],
        },
        "files parameter",
      ],
      [
        "force",
        { command: "pwd", force: true, force_reason: "test" },
        "force parameter",
      ],
      [
        "background execution",
        { command: "pwd", background: true },
        "background parameter",
      ],
      ["timeout", { command: "pwd", timeout: 1 }, "timeout parameter"],
      [
        "named terminal",
        { command: "pwd", terminal_name: "Research" },
        "terminal_name parameter",
      ],
      [
        "split terminal",
        { command: "pwd", split_from: "term_1" },
        "split_from parameter",
      ],
      [
        "outside-workspace cwd",
        { command: "pwd", cwd: "/tmp" },
        "inside the workspace",
      ],
      [
        "mixed compound command",
        { command: "pwd && mkdir generated" },
        "workspace-local command",
      ],
      [
        "path-qualified executable",
        { command: "./ls" },
        "path-qualified executable",
      ],
      [
        "git external helper",
        { command: "git grep -O../evil.sh token" },
        "git executable or output option",
      ],
      [
        "git output",
        { command: "git log --output=/tmp/log" },
        "git executable or output option",
      ],
      [
        "git path override",
        { command: "git --git-dir=/tmp/repo status" },
        "git path or config override",
      ],
      [
        "git network remote",
        { command: "git remote update" },
        "git remote operation",
      ],
      [
        "ripgrep preprocessor",
        { command: "rg --pre=./evil token src" },
        "ripgrep preprocessor execution",
      ],
      ["unquoted shell glob", { command: "ls *" }, "shell path expansion"],
      [
        "symlink-following find",
        { command: "find -L ." },
        "find option is not read-only-safe",
      ],
      [
        "ripgrep ignore file",
        { command: "rg --no-config --ignore-file config/ignore token src" },
        "rg option is not read-only-safe",
      ],
      [
        "grep pattern file",
        { command: "grep -f config/patterns src/file" },
        "grep option is not read-only-safe",
      ],
      [
        "secret hash",
        { command: "shasum ~/.ssh/id_rsa" },
        "read targets secret path",
      ],
    ])(
      "rejects %s before approval or execution",
      async (_name, params, reason) => {
        const enqueueCommandApproval = vi.fn();
        const { handleExecuteCommand } = await import("./executeCommand.js");

        const result = await handleExecuteCommand(
          params as Parameters<typeof handleExecuteCommand>[0],
          {
            isCommandApproved: () => true,
            findMatchingCommandRule: () => undefined,
          } as never,
          {
            isRecentlyApproved: () => true,
            enqueueCommandApproval,
          } as never,
          `readonly-reject-${_name}`,
          undefined,
          providers(),
        );

        expect(executeCommand).not.toHaveBeenCalled();
        expect(enqueueCommandApproval).not.toHaveBeenCalled();
        expect(textPayload(result)).toMatchObject({
          status: "rejected",
          reason: expect.stringContaining(reason),
          command_sent: false,
        });
      },
    );
  });

  it("returns actionable newline regex hint on ripgrep newline error", async () => {
    executeCommand.mockRejectedValue(
      new Error("ripgrep error: regex parse error: unescaped literal newline"),
    );

    const { handleExecuteCommand } = await import("./executeCommand.js");
    const result = await handleExecuteCommand(
      {
        command: "rg -n 'foo\\nbar' src",
      },
      { isCommandApproved: () => true } as never,
      { isRecentlyApproved: () => true } as never,
      "session-2",
      undefined,
      { terminalProvider },
    );

    const textItem = result.content[0];
    expect(textItem.type).toBe("text");
    if (textItem.type !== "text") throw new Error("Expected text result");

    const payload = JSON.parse(textItem.text);
    expect(payload.error).toContain("ripgrep error");
    expect(payload.hint).toContain("literal newline");
    expect(payload.hint).toContain("multiline");
  });
});
