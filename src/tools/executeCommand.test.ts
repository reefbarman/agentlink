import * as fs from "fs";

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
  getWorkspaceRoots,
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
    });
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

  it("rejects inline files with background commands", async () => {
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

    expect(executeCommand).not.toHaveBeenCalled();
    expect(textPayload(result)).toMatchObject({ status: "rejected" });
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

  it("filters terminal raw output with the same output window", async () => {
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
    expect(payload.terminal_raw_output).toBe(
      "\u001b[32mtwo\u001b[0m\n\u001b[33mthree\u001b[0m",
    );
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
      { terminalProvider },
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

  it("records recent approval", async () => {
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
        isRecentlyApproved: () => true,
        enqueueCommandApproval: vi.fn(),
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
      { terminalProvider },
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
