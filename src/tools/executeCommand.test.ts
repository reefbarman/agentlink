import * as fs from "fs";
import * as os from "os";

import { beforeEach, describe, expect, it, vi } from "vitest";

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
    const executed = executeCommand.mock.calls[0][0].command as string;
    expect(executed).toMatch(/^gh pr comment 1 --body-file '\/.*\/body\.md'$/);
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
      decision: "approve" as const,
      confidence: "high" as const,
      risk: "medium" as const,
      reason: "Bounded workspace directory creation",
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
        confidence: "high",
        risk: "medium",
        reason: "Bounded workspace directory creation",
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
      decision: "ask_user" as const,
      confidence: "low" as const,
      risk: "high" as const,
      reason: "Intent is ambiguous",
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
          decision: "ask_user",
          confidence: "low",
          risk: "high",
          reason: "Intent is ambiguous",
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
            decision: "ask_user",
            confidence: "low",
            risk: "high",
            reason: "Needs human confirmation",
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

    await expect(execution.then(textPayload)).resolves.toEqual({
      status: "cancelled",
      command: "mkdir generated",
      reason: "Command approval was cancelled before execution",
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
      decision: "approve" as const,
      confidence: "high" as const,
      risk: "low" as const,
      reason: "Recognized read-only binary inspection",
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
      reason: "Recognized read-only binary inspection",
    });
  });

  it("sends eligible commands to the reviewer but routes guardrails directly to the user", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const enqueueCommandApproval = vi.fn(() => ({
      promise: Promise.resolve({ decision: "accept" }),
    }));
    const review = vi.fn(async () => ({
      decision: "ask_user" as const,
      confidence: "low" as const,
      risk: "high" as const,
      reason: "Executable is unfamiliar",
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

    expect(review).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({ command: "unknown-tool run" }),
    );
    expect(enqueueCommandApproval).toHaveBeenCalledTimes(2);
    expect(enqueueCommandApproval).toHaveBeenLastCalledWith(
      "mkdir generated",
      "mkdir generated",
      expect.objectContaining({
        commandReview: undefined,
        humanOnlyReason: "Environment overrides",
      }),
    );
  });

  it("routes dangerous commands directly to the user without reviewer output", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const enqueueCommandApproval = vi.fn(() => ({
      promise: Promise.resolve({ decision: "accept" }),
    }));
    const review = vi.fn(async () => ({
      decision: "approve" as const,
      confidence: "high" as const,
      risk: "low" as const,
      reason: "Incorrectly considered safe",
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

    expect(review).not.toHaveBeenCalled();
    expect(enqueueCommandApproval).toHaveBeenCalledWith(
      "git push origin main",
      "git push origin main",
      expect.objectContaining({
        commandReview: undefined,
        humanOnlyReason: "External or network effect",
      }),
    );
    expect(textPayload(result).approval).toEqual({ by: "human" });
  });

  it("shows only a concise guardrail reason for non-temp outside paths", async () => {
    getConfiguration.mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) =>
        key === "masterBypass" ? false : fallback,
      ),
    });
    const enqueueCommandApproval = vi.fn(() => ({
      promise: Promise.resolve({ decision: "accept" }),
    }));
    const review = vi.fn();
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

    expect(review).not.toHaveBeenCalled();
    expect(enqueueCommandApproval).toHaveBeenCalledWith(
      "custom-tool /outside/input.txt",
      "custom-tool /outside/input.txt",
      expect.objectContaining({
        commandReview: undefined,
        humanOnlyReason: "Outside workspace",
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
      decision: "approve" as const,
      confidence: "high" as const,
      risk: "low" as const,
      reason: "Read-only extraction from generated test output",
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
      confidence: "high",
      risk: "low",
    });
  });

  it.each([
    { confidence: "medium" as const, risk: "medium" as const },
    { confidence: "high" as const, risk: "high" as const },
  ])(
    "requires a human for a $confidence-confidence $risk-risk approval",
    async ({ confidence, risk }) => {
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
        `session-review-${confidence}-${risk}`,
        undefined,
        {
          terminalProvider,
          getCommandApprovalPolicy: () => "approve-for-me",
          commandApprovalReviewer: {
            review: async () => ({
              decision: "approve",
              confidence,
              risk,
              reason: "Not sufficient for automatic execution",
              model: "review-model",
              status: "reviewed",
            }),
          },
          isSessionActive: () => true,
        },
      );

      expect(enqueueCommandApproval).toHaveBeenCalledTimes(1);
      expect(textPayload(result).approval).toEqual({ by: "human" });
    },
  );

  it("does not auto-execute when policy changes during review", async () => {
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
        decision: "approve" as const,
        confidence: "high" as const,
        risk: "medium" as const,
        reason: "Would otherwise approve",
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

    expect(enqueueCommandApproval).toHaveBeenCalledTimes(1);
    expect(enqueueCommandApproval).toHaveBeenCalledWith(
      "mkdir generated",
      "mkdir generated",
      expect.objectContaining({
        commandReview: undefined,
        humanOnlyReason: "Approve for Me was turned off during review",
      }),
    );
    expect(textPayload(result).approval).toEqual({ by: "human" });
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
      commandExecutionPolicy: "read-only" as const,
    });

    it("executes a recognized safe command without entering the approval flow", async () => {
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
