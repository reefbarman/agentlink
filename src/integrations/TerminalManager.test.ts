import type {
  TerminalExecuteOptions,
  TerminalExecutionOwner,
} from "../core/capabilities/terminal.js";
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as vscode from "vscode";

import {
  TerminalManager,
  escapeHistoryExpansion,
  shouldEscapeHistoryExpansion,
} from "./TerminalManager.js";

type MockVscodeTerminal = {
  name: string;
  show: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  shellIntegration?: {
    cwd?: { fsPath: string };
    executeCommand: ReturnType<typeof vi.fn>;
  };
};

type MockVscodeWindow = {
  terminals?: MockVscodeTerminal[];
};

type MockManagedTerminal = {
  id: string;
  name: string;
  cwd: string;
  busy: boolean;
  envKey?: string;
  implicit?: boolean;
  owner?: TerminalExecutionOwner;
  backgroundRunning: boolean;
  lastCommandEndedAt: number;
  outputBuffer: string;
  backgroundExitCode: number | null;
  backgroundOutputCaptured: boolean;
  backgroundState?:
    | "running"
    | "detached"
    | "timed_out"
    | "completed"
    | "unknown_termination";
  backgroundDisposables: Array<{ dispose(): void }>;
  terminal: {
    show: ReturnType<typeof vi.fn>;
    sendText: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    shellIntegration?: {
      cwd?: { fsPath: string };
      executeCommand: ReturnType<typeof vi.fn>;
    };
  };
};

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

describe("shouldEscapeHistoryExpansion", () => {
  it("always escapes on non-windows platforms", () => {
    expect(shouldEscapeHistoryExpansion("linux", "/usr/bin/bash")).toBe(true);
    expect(shouldEscapeHistoryExpansion("darwin", "/bin/zsh")).toBe(true);
    expect(shouldEscapeHistoryExpansion("linux", undefined)).toBe(true);
  });

  it("escapes on windows only for bash-like shells", () => {
    expect(
      shouldEscapeHistoryExpansion(
        "win32",
        "C:\\Program Files\\Git\\bin\\bash.exe",
      ),
    ).toBe(true);
    expect(
      shouldEscapeHistoryExpansion("win32", "C:/msys64/usr/bin/bash.exe"),
    ).toBe(true);
    expect(shouldEscapeHistoryExpansion("win32", "C:/tools/zsh.exe")).toBe(
      true,
    );
  });

  it("does not escape on windows powershell/cmd or unknown shell", () => {
    expect(
      shouldEscapeHistoryExpansion(
        "win32",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ),
    ).toBe(false);
    expect(
      shouldEscapeHistoryExpansion("win32", "C:\\Windows\\System32\\cmd.exe"),
    ).toBe(false);
    expect(shouldEscapeHistoryExpansion("win32", undefined)).toBe(false);
  });
});

describe("escapeHistoryExpansion", () => {
  it("escapes unquoted and double-quoted exclamation marks", () => {
    expect(escapeHistoryExpansion("echo wow!")).toBe("echo wow\\!");
    expect(escapeHistoryExpansion('echo "wow!"')).toBe('echo "wow\\!"');
  });

  it("does not escape inside single quotes", () => {
    expect(escapeHistoryExpansion("echo 'wow!'")).toBe("echo 'wow!'");
  });

  it("preserves already escaped exclamation marks", () => {
    expect(escapeHistoryExpansion("echo wow\\!")).toBe("echo wow\\!");
  });

  it("handles windows git bash patterns used to wrap powershell", () => {
    const input =
      'powershell -NoProfile -Command "if (!(Test-Path $bashrc)) { Write-Output ok }"';
    const output = escapeHistoryExpansion(input);
    expect(output).toContain("if (\\!(Test-Path $bashrc))");
  });
});

describe("TerminalManager terminal selection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(vscode.window as object, "terminals");
  });

  it("reveals and focuses a managed terminal by id", () => {
    const manager = new TerminalManager();
    const show = vi.fn();
    (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
      {
        id: "term_reveal",
        name: "AgentLink",
        cwd: "/workspace",
        busy: true,
        backgroundRunning: false,
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundExitCode: null,
        backgroundOutputCaptured: false,
        backgroundDisposables: [],
        terminal: {
          show,
          sendText: vi.fn(),
          dispose: vi.fn(),
        },
      },
    ];

    expect(
      manager.revealTerminal({ owner: undefined, terminalId: "term_reveal" }),
    ).toBe(true);
    expect(show).toHaveBeenCalledWith(false);
    expect(
      manager.revealTerminal({ owner: undefined, terminalId: "term_missing" }),
    ).toBe(false);
  });

  it("refreshes descendant attribution on reuse and isolates the next owner generation", async () => {
    const manager = new TerminalManager();
    const rootOwner: TerminalExecutionOwner = {
      scopeId: "tab-1",
      displayLabel: "T1",
      generation: 1,
      authoritySessionId: "root-session",
    };
    const childOwner: TerminalExecutionOwner = {
      ...rootOwner,
      authoritySessionId: "child-session",
    };
    const nextGeneration: TerminalExecutionOwner = {
      ...rootOwner,
      generation: 2,
      authoritySessionId: "replacement-session",
    };
    const managed = {
      id: "term_owned",
      name: "AgentLink T1",
      cwd: "/workspace",
      owner: rootOwner,
      busy: false,
      backgroundRunning: false,
      lastCommandEndedAt: Date.now(),
      outputBuffer: "",
      backgroundExitCode: null,
      backgroundOutputCaptured: false,
      backgroundDisposables: [],
      terminal: {
        show: vi.fn(),
        sendText: vi.fn(),
        dispose: vi.fn(),
      },
    } satisfies MockManagedTerminal;
    (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
      managed,
    ];

    const reused = await (
      manager as unknown as {
        resolveTerminal(
          options: TerminalExecuteOptions,
        ): Promise<MockManagedTerminal>;
      }
    ).resolveTerminal({
      owner: childOwner,
      command: "pwd",
      cwd: "/workspace",
      terminal_id: managed.id,
    });

    expect(reused).toBe(managed);
    expect(managed.owner).toEqual(childOwner);
    expect(manager.listTerminals({ owner: childOwner })).toEqual([
      expect.objectContaining({ id: managed.id, owner: childOwner }),
    ]);
    expect(manager.listTerminals({ owner: nextGeneration })).toEqual([]);
    expect(
      manager.getBackgroundState({
        owner: nextGeneration,
        terminalId: managed.id,
      }),
    ).toBeUndefined();
    expect(
      manager.interruptTerminal({
        owner: nextGeneration,
        terminalId: managed.id,
      }),
    ).toBe(false);
    expect(
      manager.closeTerminals({
        owner: nextGeneration,
        names: [managed.id],
      }),
    ).toEqual({ closed: 0, not_found: [managed.id] });
  });

  it("emits terminal open, command, and state events for sendText fallback execution", async () => {
    const manager = new TerminalManager();
    const openEvents: unknown[] = [];
    const commandStartEvents: unknown[] = [];
    const stateEvents: unknown[] = [];
    manager.onTerminalEvent("open", (event) => openEvents.push(event));
    manager.onTerminalEvent("commandStart", (event) =>
      commandStartEvents.push(event),
    );
    manager.onTerminalEvent("state", (event) => stateEvents.push(event));

    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockResolvedValue(false);

    const result = await manager.executeCommand({
      owner: undefined,
      command: "echo no-capture",
      cwd: "/workspace/events",
    });

    expect(result).toMatchObject({
      terminal_id: expect.stringMatching(/^term_/),
      execution_mode: "send_text",
      output_captured: false,
    });
    expect(openEvents).toEqual([
      expect.objectContaining({
        id: result.terminal_id,
        name: "AgentLink",
        cwd: "/workspace/events",
        busy: false,
      }),
    ]);
    expect(commandStartEvents).toEqual([
      expect.objectContaining({
        terminalId: result.terminal_id,
        command: "echo no-capture",
        captureLevel: "command-sent-only",
      }),
    ]);
    expect(stateEvents).toEqual([
      expect.objectContaining({
        id: result.terminal_id,
        name: "AgentLink",
        cwd: "/workspace/events",
        busy: true,
      }),
    ]);
  });

  it("stops notifying disposed terminal event listeners", () => {
    const manager = new TerminalManager();
    const listener = vi.fn();
    const subscription = manager.onTerminalEvent("open", listener);

    subscription.dispose();

    (
      manager as unknown as {
        createTerminal: (cwd: string, name: string) => MockManagedTerminal;
      }
    ).createTerminal("/workspace", "AgentLink");
    expect(listener).not.toHaveBeenCalled();
  });

  it("returns managed metadata for a VS Code terminal object", () => {
    const manager = new TerminalManager();
    const terminal = {
      name: "AgentLink",
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
    } satisfies MockVscodeTerminal;
    Object.defineProperty(vscode.window, "terminals", {
      configurable: true,
      value: [terminal],
    });
    (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
      {
        id: "term_lookup",
        name: "AgentLink",
        cwd: "/workspace",
        busy: false,
        backgroundRunning: true,
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundExitCode: null,
        backgroundOutputCaptured: false,
        backgroundDisposables: [],
        terminal,
      },
    ];

    expect(
      manager.getManagedTerminalMetadataForTerminal(terminal as never),
    ).toEqual({
      id: "term_lookup",
      name: "AgentLink",
      cwd: "/workspace",
      busy: true,
    });
  });

  it("creates a new default terminal when the only idle default terminal has a different cwd", async () => {
    const manager = new TerminalManager();

    const existing = {
      id: "term_existing",
      name: "AgentLink",
      cwd: "/workspace/templates",
      busy: false,
      backgroundRunning: false,
      lastCommandEndedAt: 0,
      outputBuffer: "",
      backgroundExitCode: null,
      backgroundOutputCaptured: false,
      backgroundDisposables: [],
      terminal: {
        show: vi.fn(),
        sendText: vi.fn(),
        dispose: vi.fn(),
      },
    } satisfies MockManagedTerminal;

    const createTerminalSpy = vi
      .spyOn(
        manager as unknown as {
          createTerminal: (
            cwd: string,
            name: string,
            env: Record<string, string> | undefined,
            owner: undefined,
          ) => MockManagedTerminal;
        },
        "createTerminal",
      )
      .mockImplementation((cwd: string, name: string) => ({
        id: "term_new",
        name,
        cwd,
        busy: false,
        backgroundRunning: false,
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundExitCode: null,
        backgroundOutputCaptured: false,
        backgroundDisposables: [],
        terminal: {
          show: vi.fn(),
          sendText: vi.fn(),
          dispose: vi.fn(),
        },
      }));

    (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
      existing,
    ];
    vi.spyOn(
      manager as unknown as {
        waitForCooldown: (managed: MockManagedTerminal) => Promise<void>;
      },
      "waitForCooldown",
    ).mockResolvedValue();
    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockResolvedValue(false);

    const result = await manager.executeCommand({
      owner: undefined,
      command: "pwd",
      cwd: "/workspace",
    });

    expect(createTerminalSpy).toHaveBeenCalledWith(
      "/workspace",
      "AgentLink",
      undefined,
      undefined,
      true,
    );
    expect(result.terminal_id).toBe("term_new");
    expect(existing.terminal.sendText).not.toHaveBeenCalled();
  });

  it("rejects a missing explicit terminal ID without creating a replacement", async () => {
    const manager = new TerminalManager();
    const createTerminal = vi.spyOn(
      manager as unknown as {
        createTerminal: (...args: unknown[]) => MockManagedTerminal;
      },
      "createTerminal",
    );

    await expect(
      (
        manager as unknown as {
          resolveTerminal: (
            options: TerminalExecuteOptions,
          ) => Promise<MockManagedTerminal>;
        }
      ).resolveTerminal({
        owner: undefined,
        command: "pwd",
        cwd: "/workspace",
        terminal_id: "missing",
      }),
    ).rejects.toThrow("Terminal not found: missing");
    expect(createTerminal).not.toHaveBeenCalled();
  });

  it("rejects a busy named terminal without creating a duplicate", async () => {
    const manager = new TerminalManager();
    const existing = {
      id: "term_named",
      name: "Server",
      cwd: "/workspace/server",
      busy: false,
      backgroundRunning: true,
      lastCommandEndedAt: 0,
      outputBuffer: "",
      backgroundExitCode: null,
      backgroundOutputCaptured: true,
      backgroundDisposables: [],
      terminal: {
        show: vi.fn(),
        sendText: vi.fn(),
        dispose: vi.fn(),
      },
    } satisfies MockManagedTerminal;
    (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
      existing,
    ];
    const createTerminal = vi.spyOn(
      manager as unknown as {
        createTerminal: (...args: unknown[]) => MockManagedTerminal;
      },
      "createTerminal",
    );

    await expect(
      (
        manager as unknown as {
          resolveTerminal: (
            options: TerminalExecuteOptions,
          ) => Promise<MockManagedTerminal>;
        }
      ).resolveTerminal({
        owner: undefined,
        command: "npm run dev",
        cwd: "/workspace/server",
        terminal_name: "Server",
      }),
    ).rejects.toThrow("Terminal Server is busy");
    expect(createTerminal).not.toHaveBeenCalled();
  });

  it("refreshes cwd when a background command finishes", () => {
    const manager = new TerminalManager();
    const existing = {
      id: "term_background",
      name: "AgentLink",
      cwd: "/workspace",
      busy: false,
      backgroundRunning: true,
      lastCommandEndedAt: 0,
      outputBuffer: "",
      backgroundExitCode: 0,
      backgroundOutputCaptured: true,
      backgroundDisposables: [],
      terminal: {
        show: vi.fn(),
        sendText: vi.fn(),
        dispose: vi.fn(),
        shellIntegration: {
          cwd: { fsPath: "/workspace/subdir" },
          executeCommand: vi.fn(),
        },
      },
    } satisfies MockManagedTerminal;

    expect(
      (
        manager as unknown as {
          finishBackgroundCommand: (
            managed: MockManagedTerminal,
            commandId: string,
          ) => boolean;
        }
      ).finishBackgroundCommand(existing, "command-1"),
    ).toBe(true);
    expect(existing.cwd).toBe("/workspace/subdir");
  });

  it("preserves named-terminal reuse across requested cwd changes", async () => {
    const manager = new TerminalManager();
    const existing = {
      id: "term_named",
      name: "Server",
      cwd: "/workspace/server",
      busy: false,
      backgroundRunning: false,
      lastCommandEndedAt: 0,
      outputBuffer: "",
      backgroundExitCode: null,
      backgroundOutputCaptured: false,
      backgroundDisposables: [],
      terminal: {
        show: vi.fn(),
        sendText: vi.fn(),
        dispose: vi.fn(),
      },
    } satisfies MockManagedTerminal;
    (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
      existing,
    ];
    vi.spyOn(
      manager as unknown as {
        waitForCooldown: (managed: MockManagedTerminal) => Promise<void>;
      },
      "waitForCooldown",
    ).mockResolvedValue();
    const createTerminal = vi.spyOn(
      manager as unknown as {
        createTerminal: (...args: unknown[]) => MockManagedTerminal;
      },
      "createTerminal",
    );

    const resolved = await (
      manager as unknown as {
        resolveTerminal: (options: {
          command: string;
          cwd: string;
          terminal_name: string;
        }) => Promise<MockManagedTerminal>;
      }
    ).resolveTerminal({
      command: "npm test",
      cwd: "/workspace/client",
      terminal_name: "Server",
    });

    expect(resolved).toBe(existing);
    expect(createTerminal).not.toHaveBeenCalled();
  });

  it("marks a reused terminal busy before awaiting cooldown so concurrent callers cannot race onto it", async () => {
    const manager = new TerminalManager();

    const existing = {
      id: "term_existing",
      name: "AgentLink",
      cwd: "/workspace",
      implicit: true,
      busy: false,
      backgroundRunning: false,
      lastCommandEndedAt: 0,
      outputBuffer: "",
      backgroundExitCode: null,
      backgroundOutputCaptured: false,
      backgroundDisposables: [],
      terminal: {
        show: vi.fn(),
        sendText: vi.fn(),
        dispose: vi.fn(),
      },
    } satisfies MockManagedTerminal;

    let releaseCooldown: (() => void) | undefined;
    const cooldownPromise = new Promise<void>((resolve) => {
      releaseCooldown = resolve;
    });

    const waitForCooldownSpy = vi
      .spyOn(
        manager as unknown as {
          waitForCooldown: (managed: MockManagedTerminal) => Promise<void>;
        },
        "waitForCooldown",
      )
      .mockImplementation(async () => cooldownPromise);

    const createTerminalSpy = vi
      .spyOn(
        manager as unknown as {
          createTerminal: (
            cwd: string,
            name: string,
            env: Record<string, string> | undefined,
            owner: undefined,
          ) => MockManagedTerminal;
        },
        "createTerminal",
      )
      .mockImplementation((cwd: string, name: string) => ({
        id: "term_new",
        name,
        cwd,
        busy: false,
        backgroundRunning: false,
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundExitCode: null,
        backgroundOutputCaptured: false,
        backgroundDisposables: [],
        terminal: {
          show: vi.fn(),
          sendText: vi.fn(),
          dispose: vi.fn(),
        },
      }));

    (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
      existing,
    ];
    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockResolvedValue(false);

    const first = manager.executeCommand({
      owner: undefined,
      command: "echo first",
      cwd: "/workspace",
    });
    await Promise.resolve();

    expect(existing.busy).toBe(true);
    expect(waitForCooldownSpy).toHaveBeenCalledTimes(1);

    const second = manager.executeCommand({
      owner: undefined,
      command: "echo second",
      cwd: "/workspace",
    });
    await Promise.resolve();

    expect(createTerminalSpy).toHaveBeenCalledWith(
      "/workspace",
      "AgentLink",
      undefined,
      undefined,
      true,
    );

    releaseCooldown?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.terminal_id).toBe("term_existing");
    expect(secondResult.terminal_id).toBe("term_new");
  });

  it("rejects execute_command when terminal_id targets a busy terminal", async () => {
    const manager = new TerminalManager();

    const existing = {
      id: "term_busy",
      name: "AgentLink",
      cwd: "/workspace",
      busy: true,
      backgroundRunning: false,
      lastCommandEndedAt: 0,
      outputBuffer: "",
      backgroundExitCode: null,
      backgroundOutputCaptured: false,
      backgroundDisposables: [],
      terminal: {
        show: vi.fn(),
        sendText: vi.fn(),
        dispose: vi.fn(),
      },
    } satisfies MockManagedTerminal;

    (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
      existing,
    ];

    await expect(
      manager.executeCommand({
        owner: undefined,
        command: "echo blocked",
        cwd: "/workspace",
        terminal_id: "term_busy",
      }),
    ).rejects.toThrow(/Terminal term_busy is busy/);
  });

  it("returns explicit send_text execution metadata when shell integration is unavailable", async () => {
    const manager = new TerminalManager();

    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockResolvedValue(false);

    const result = await manager.executeCommand({
      owner: undefined,
      command: "echo no-capture",
      cwd: "/workspace/no-capture",
    });

    expect(result.output_captured).toBe(false);
    expect(result.execution_mode).toBe("send_text");
    expect(result.command_sent).toBe(true);
    expect(result.verification_hint).toContain("Do not re-run");
  });

  it("starts in background when detached before shell integration is ready", async () => {
    const manager = new TerminalManager();
    let assignedTerminalId = "";

    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockImplementation(() => new Promise(() => {}));
    vi.spyOn(
      manager as unknown as {
        createTerminal: (cwd: string, name: string) => MockManagedTerminal;
      },
      "createTerminal",
    ).mockImplementation((cwd: string, name: string) => {
      const managed = {
        id: "term_waiting",
        name,
        cwd,
        busy: false,
        backgroundRunning: false,
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundExitCode: null,
        backgroundOutputCaptured: false,
        backgroundDisposables: [],
        terminal: {
          show: vi.fn(),
          sendText: vi.fn(),
          dispose: vi.fn(),
        },
      } satisfies MockManagedTerminal;
      (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
        managed,
      ];
      return managed;
    });

    const execution = manager.executeCommand({
      owner: undefined,
      command: "npm run dev",
      cwd: "/workspace",
      onTerminalAssigned: (terminalId) => {
        assignedTerminalId = terminalId;
      },
    });
    await waitForCondition(() => assignedTerminalId.length > 0);

    expect(
      manager.detachTerminal({
        owner: undefined,
        terminalId: assignedTerminalId,
      }),
    ).toBe(true);
    const result = await execution;

    expect(result).toMatchObject({
      terminal_id: assignedTerminalId,
      backgrounded: true,
      is_running: true,
      execution_mode: "send_text",
    });
    expect(
      manager.getBackgroundState({
        owner: undefined,
        terminalId: assignedTerminalId,
      }),
    ).toMatchObject({
      is_running: true,
      output_captured: false,
    });
    expect(
      manager.detachTerminal({
        owner: undefined,
        terminalId: assignedTerminalId,
      }),
    ).toBe(false);

    manager.interruptTerminal({
      owner: undefined,
      terminalId: assignedTerminalId,
    });
  });

  it("detaches an active shell execution and finalizes deferred cleanup on completion", async () => {
    const manager = new TerminalManager();
    const onCommandFinalizationDeferred = vi.fn();
    const onCommandFinalized = vi.fn();
    let releaseCompletion!: () => void;
    const completionReady = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const executeCommand = vi.fn(() => ({
      read: async function* () {
        yield "watching\r\n";
        await completionReady;
        yield "done\r\n\x1B]633;D;0\x07";
      },
    }));

    vi.spyOn(
      manager as unknown as {
        createTerminal: (cwd: string, name: string) => MockManagedTerminal;
      },
      "createTerminal",
    ).mockImplementation((cwd: string, name: string) => {
      const managed = {
        id: "term_detach",
        name,
        cwd,
        busy: false,
        backgroundRunning: false,
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundExitCode: null,
        backgroundOutputCaptured: false,
        backgroundDisposables: [],
        terminal: {
          show: vi.fn(),
          sendText: vi.fn(),
          dispose: vi.fn(),
          shellIntegration: {
            cwd: { fsPath: cwd },
            executeCommand,
          },
        },
      } satisfies MockManagedTerminal;
      (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
        managed,
      ];
      return managed;
    });

    const execution = manager.executeCommand({
      owner: undefined,
      command: "npm run dev",
      cwd: "/workspace",
      onCommandFinalizationDeferred,
      onCommandFinalized,
    });
    await waitForCondition(() => executeCommand.mock.calls.length > 0);
    await waitForCondition(
      () =>
        manager.getCurrentOutput({
          owner: undefined,
          terminalId: "term_detach",
          force: true,
        }) === "watching",
    );

    expect(
      manager.detachTerminal({ owner: undefined, terminalId: "term_detach" }),
    ).toBe(true);
    const result = await execution;

    expect(result).toMatchObject({
      terminal_id: "term_detach",
      backgrounded: true,
      is_running: true,
      output_captured: true,
    });
    expect(result.output).toContain("watching");
    expect(result.output).toContain("get_terminal_output");
    expect(onCommandFinalizationDeferred).toHaveBeenCalledTimes(1);
    expect(onCommandFinalized).not.toHaveBeenCalled();
    expect(
      manager.getBackgroundState({
        owner: undefined,
        terminalId: "term_detach",
      }),
    ).toMatchObject({
      is_running: true,
      output: "watching",
      output_captured: true,
    });

    releaseCompletion();
    await waitForCondition(
      () =>
        manager.getBackgroundState({
          owner: undefined,
          terminalId: "term_detach",
        })?.is_running === false,
      1_000,
    );
    expect(
      manager.getBackgroundState({
        owner: undefined,
        terminalId: "term_detach",
      }),
    ).toMatchObject({
      is_running: false,
      exit_code: 0,
      output: "watching\ndone",
      output_captured: true,
    });
    expect(onCommandFinalized).toHaveBeenCalledTimes(1);
  });

  it("finalizes deferred cleanup when background dispatch fails", async () => {
    const manager = new TerminalManager();
    const onCommandFinalizationDeferred = vi.fn();
    const onCommandFinalized = vi.fn();
    const executeCommand = vi.fn(() => {
      throw new Error("dispatch failed");
    });

    vi.spyOn(
      manager as unknown as {
        createTerminal: (cwd: string, name: string) => MockManagedTerminal;
      },
      "createTerminal",
    ).mockImplementation((cwd: string, name: string) => ({
      id: "term_dispatch_failure",
      name,
      cwd,
      busy: false,
      backgroundRunning: false,
      lastCommandEndedAt: 0,
      outputBuffer: "",
      backgroundExitCode: null,
      backgroundOutputCaptured: false,
      backgroundDisposables: [],
      terminal: {
        show: vi.fn(),
        sendText: vi.fn(),
        dispose: vi.fn(),
        shellIntegration: {
          cwd: { fsPath: cwd },
          executeCommand,
        },
      },
    }));

    await expect(
      manager.executeCommand({
        owner: undefined,
        command: "npm run dev",
        cwd: "/workspace",
        background: true,
        onCommandFinalizationDeferred,
        onCommandFinalized,
      }),
    ).rejects.toThrow("dispatch failed");

    expect(onCommandFinalizationDeferred).toHaveBeenCalledTimes(1);
    expect(onCommandFinalized).toHaveBeenCalledTimes(1);
  });

  it("treats a returned shell prompt as completion when Ctrl+C omits the exit marker", async () => {
    const manager = new TerminalManager();
    const executeCommand = vi.fn(() => ({
      read: async function* () {
        yield "starting\r\n^C\r\n\x1B]633;A\x07";
        await new Promise(() => {});
      },
    }));

    vi.spyOn(
      manager as unknown as {
        createTerminal: (cwd: string, name: string) => MockManagedTerminal;
      },
      "createTerminal",
    ).mockImplementation((cwd: string, name: string) => ({
      id: "term_prompt",
      name,
      cwd,
      busy: false,
      backgroundRunning: false,
      lastCommandEndedAt: 0,
      outputBuffer: "",
      backgroundExitCode: null,
      backgroundOutputCaptured: false,
      backgroundDisposables: [],
      terminal: {
        show: vi.fn(),
        sendText: vi.fn(),
        dispose: vi.fn(),
        shellIntegration: {
          cwd: { fsPath: cwd },
          executeCommand,
        },
      },
    }));

    const result = await manager.executeCommand({
      owner: undefined,
      command: "sleep 60",
      cwd: "/workspace",
    });

    expect(result).toMatchObject({
      exit_code: 130,
      output: "starting\n^C",
      output_captured: true,
      terminal_id: "term_prompt",
    });
  });

  it("prefers an exact shell end status over an earlier code-less marker", async () => {
    const manager = new TerminalManager();
    const endListeners: Array<
      Parameters<typeof vscode.window.onDidEndTerminalShellExecution>[0]
    > = [];
    vi.spyOn(
      vscode.window,
      "onDidEndTerminalShellExecution",
    ).mockImplementation((listener) => {
      endListeners.push(listener);
      return { dispose: vi.fn() };
    });
    const execution = {
      read: async function* () {
        yield "done\r\n\x1B]633;D\x07";
      },
    };
    const executeCommand = vi.fn(() => execution);
    let terminal!: MockManagedTerminal["terminal"];

    vi.spyOn(
      manager as unknown as {
        createTerminal: (cwd: string, name: string) => MockManagedTerminal;
      },
      "createTerminal",
    ).mockImplementation((cwd: string, name: string) => {
      terminal = {
        show: vi.fn(),
        sendText: vi.fn(),
        dispose: vi.fn(),
        shellIntegration: {
          cwd: { fsPath: cwd },
          executeCommand,
        },
      };
      const managed = {
        id: "term_unknown_marker",
        name,
        cwd,
        busy: false,
        backgroundRunning: false,
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundExitCode: null,
        backgroundOutputCaptured: false,
        backgroundDisposables: [],
        terminal,
      } satisfies MockManagedTerminal;
      (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
        managed,
      ];
      return managed;
    });

    const resultPromise = manager.executeCommand({
      owner: undefined,
      command: "exit 7",
      cwd: "/workspace",
    });
    await waitForCondition(() => endListeners.length === 1);
    endListeners[0]({
      terminal: terminal as never,
      shellIntegration: terminal.shellIntegration as never,
      execution: execution as never,
      exitCode: 7,
    });

    await expect(resultPromise).resolves.toMatchObject({
      exit_code: 7,
      output: "done",
    });
  });

  it("returns promptly after a code-less marker when no exact end event arrives", async () => {
    const manager = new TerminalManager();
    const executeCommand = vi.fn(() => ({
      read: async function* () {
        yield "done\r\n\x1B]633;D\x07";
      },
    }));

    vi.spyOn(
      manager as unknown as {
        createTerminal: (cwd: string, name: string) => MockManagedTerminal;
      },
      "createTerminal",
    ).mockImplementation((cwd: string, name: string) => {
      const managed = {
        id: "term_unknown_marker_no_end",
        name,
        cwd,
        busy: false,
        backgroundRunning: false,
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundExitCode: null,
        backgroundOutputCaptured: false,
        backgroundDisposables: [],
        terminal: {
          show: vi.fn(),
          sendText: vi.fn(),
          dispose: vi.fn(),
          shellIntegration: {
            cwd: { fsPath: cwd },
            executeCommand,
          },
        },
      } satisfies MockManagedTerminal;
      (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
        managed,
      ];
      return managed;
    });

    const startedAt = Date.now();
    const result = await manager.executeCommand({
      owner: undefined,
      command: "echo done",
      cwd: "/workspace",
    });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result).toMatchObject({
      exit_code: null,
      output: "done",
    });
    expect(
      manager.getBackgroundState({
        owner: undefined,
        terminalId: "term_unknown_marker_no_end",
      }),
    ).toMatchObject({
      state: "unknown_termination",
      exit_code: null,
    });
  });

  it("preserves a marker exit code when the output stream wins the completion race", async () => {
    const manager = new TerminalManager();
    const executeCommand = vi.fn(() => ({
      read: async function* () {
        yield "failed output\r\n\x1B]633;D;7\x07";
      },
    }));

    vi.spyOn(
      manager as unknown as {
        createTerminal: (cwd: string, name: string) => MockManagedTerminal;
      },
      "createTerminal",
    ).mockImplementation((cwd: string, name: string) => {
      const managed = {
        id: "term_marker_exit",
        name,
        cwd,
        busy: false,
        backgroundRunning: false,
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundExitCode: null,
        backgroundOutputCaptured: false,
        backgroundDisposables: [],
        terminal: {
          show: vi.fn(),
          sendText: vi.fn(),
          dispose: vi.fn(),
          shellIntegration: {
            cwd: { fsPath: cwd },
            executeCommand,
          },
        },
      } satisfies MockManagedTerminal;
      (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
        managed,
      ];
      return managed;
    });

    const result = await manager.executeCommand({
      owner: undefined,
      command: "exit 7",
      cwd: "/workspace",
    });

    expect(result).toMatchObject({
      exit_code: 7,
      output: "failed output",
      output_captured: true,
    });
    expect(
      manager.getBackgroundState({
        owner: undefined,
        terminalId: "term_marker_exit",
      }),
    ).toMatchObject({
      state: "completed",
      exit_code: 7,
      output: "failed output",
    });
  });

  it("ignores stale shell end events from a prior execution", async () => {
    const manager = new TerminalManager();
    const onCommandFinalizationDeferred = vi.fn();
    const onCommandFinalized = vi.fn();
    const endListeners: Array<
      Parameters<typeof vscode.window.onDidEndTerminalShellExecution>[0]
    > = [];
    vi.spyOn(
      vscode.window,
      "onDidEndTerminalShellExecution",
    ).mockImplementation((listener) => {
      endListeners.push(listener);
      return { dispose: vi.fn() };
    });

    const execution = {
      read: async function* () {
        yield "";
        await new Promise(() => {});
      },
    };
    const executeCommand = vi.fn(() => execution);
    let terminal!: MockManagedTerminal["terminal"];

    vi.spyOn(
      manager as unknown as {
        createTerminal: (cwd: string, name: string) => MockManagedTerminal;
      },
      "createTerminal",
    ).mockImplementation((cwd: string, name: string) => {
      terminal = {
        show: vi.fn(),
        sendText: vi.fn(),
        dispose: vi.fn(),
        shellIntegration: {
          cwd: { fsPath: cwd },
          executeCommand,
        },
      };
      const managed = {
        id: "term_exact_execution",
        name,
        cwd,
        busy: false,
        backgroundRunning: false,
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundExitCode: null,
        backgroundOutputCaptured: false,
        backgroundDisposables: [],
        terminal,
      } satisfies MockManagedTerminal;
      (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
        managed,
      ];
      return managed;
    });

    await manager.executeCommand({
      owner: undefined,
      command: "npm run dev",
      cwd: "/workspace",
      background: true,
      onCommandFinalizationDeferred,
      onCommandFinalized,
    });

    expect(endListeners).toHaveLength(1);
    endListeners[0]({
      terminal: terminal as never,
      shellIntegration: terminal.shellIntegration as never,
      execution: {} as never,
      exitCode: 0,
    });
    expect(onCommandFinalized).not.toHaveBeenCalled();
    expect(
      manager.getBackgroundState({
        owner: undefined,
        terminalId: "term_exact_execution",
      })?.is_running,
    ).toBe(true);

    endListeners[0]({
      terminal: terminal as never,
      shellIntegration: terminal.shellIntegration as never,
      execution: execution as never,
      exitCode: 0,
    });
    expect(onCommandFinalized).toHaveBeenCalledTimes(1);
    expect(
      manager.getBackgroundState({
        owner: undefined,
        terminalId: "term_exact_execution",
      })?.is_running,
    ).toBe(false);
  });

  it("keeps background tracking alive after a code-less marker until exact completion", async () => {
    const manager = new TerminalManager();
    const endListeners: Array<
      Parameters<typeof vscode.window.onDidEndTerminalShellExecution>[0]
    > = [];
    vi.spyOn(
      vscode.window,
      "onDidEndTerminalShellExecution",
    ).mockImplementation((listener) => {
      endListeners.push(listener);
      return { dispose: vi.fn() };
    });
    const execution = {
      read: async function* () {
        yield "background done\r\n\x1B]633;D\x07";
      },
    };
    const executeCommand = vi.fn(() => execution);
    let terminal!: MockManagedTerminal["terminal"];

    vi.spyOn(
      manager as unknown as {
        createTerminal: (cwd: string, name: string) => MockManagedTerminal;
      },
      "createTerminal",
    ).mockImplementation((cwd: string, name: string) => {
      terminal = {
        show: vi.fn(),
        sendText: vi.fn(),
        dispose: vi.fn(),
        shellIntegration: {
          cwd: { fsPath: cwd },
          executeCommand,
        },
      };
      const managed = {
        id: "term_bg_unknown_marker",
        name,
        cwd,
        busy: false,
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundRunning: false,
        backgroundExitCode: null,
        backgroundOutputCaptured: false,
        backgroundDisposables: [],
        terminal,
      } satisfies MockManagedTerminal;
      (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
        managed,
      ];
      return managed;
    });

    await manager.executeCommand({
      owner: undefined,
      command: "exit 7",
      cwd: "/workspace",
      background: true,
    });
    await waitForCondition(
      () =>
        manager.getBackgroundState({
          owner: undefined,
          terminalId: "term_bg_unknown_marker",
        })?.output === "background done",
    );
    expect(
      manager.getBackgroundState({
        owner: undefined,
        terminalId: "term_bg_unknown_marker",
      }),
    ).toMatchObject({
      is_running: true,
      state: "detached",
      exit_code: null,
    });

    endListeners[0]({
      terminal: terminal as never,
      shellIntegration: terminal.shellIntegration as never,
      execution: execution as never,
      exitCode: 7,
    });

    expect(
      manager.getBackgroundState({
        owner: undefined,
        terminalId: "term_bg_unknown_marker",
      }),
    ).toMatchObject({
      is_running: false,
      state: "completed",
      exit_code: 7,
      output: "background done",
    });
  });

  it("retroactively marks sendText background output as captured on completion", async () => {
    const manager = new TerminalManager();
    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockResolvedValue(false);
    const endListeners: Array<
      Parameters<typeof vscode.window.onDidEndTerminalShellExecution>[0]
    > = [];
    vi.spyOn(
      vscode.window,
      "onDidEndTerminalShellExecution",
    ).mockImplementation((listener) => {
      endListeners.push(listener);
      return { dispose: vi.fn() };
    });

    let managed!: MockManagedTerminal;
    vi.spyOn(
      manager as unknown as {
        createTerminal: (cwd: string, name: string) => MockManagedTerminal;
      },
      "createTerminal",
    ).mockImplementation((cwd: string, name: string) => {
      managed = {
        id: "term_retroactive_capture",
        name,
        cwd,
        busy: false,
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundRunning: false,
        backgroundExitCode: null,
        backgroundOutputCaptured: false,
        backgroundDisposables: [],
        terminal: {
          show: vi.fn(),
          sendText: vi.fn(),
          dispose: vi.fn(),
        },
      };
      (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
        managed,
      ];
      return managed;
    });

    const result = await manager.executeCommand({
      owner: undefined,
      command: "npm run dev",
      cwd: "/workspace",
      background: true,
    });
    expect(result.execution_mode).toBe("send_text");
    expect(endListeners).toHaveLength(1);

    managed.outputBuffer = "captured later";
    endListeners[0]({
      terminal: managed.terminal as never,
      shellIntegration: {} as never,
      execution: {} as never,
      exitCode: 3,
    });

    expect(
      manager.getBackgroundState({ owner: undefined, terminalId: managed.id }),
    ).toMatchObject({
      is_running: false,
      exit_code: 3,
      output: "captured later",
      output_captured: true,
    });
  });

  it("marks captured background commands finished when Ctrl+C returns the prompt without an exit marker", async () => {
    const manager = new TerminalManager();
    const executeCommand = vi.fn(() => ({
      read: async function* () {
        yield "watching\r\n^C\r\n\x1B]133;A\x07";
        await new Promise(() => {});
      },
    }));

    vi.spyOn(
      manager as unknown as {
        createTerminal: (cwd: string, name: string) => MockManagedTerminal;
      },
      "createTerminal",
    ).mockImplementation((cwd: string, name: string) => {
      const managed = {
        id: "term_bg_prompt",
        name,
        cwd,
        busy: false,
        backgroundRunning: false,
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundExitCode: null,
        backgroundOutputCaptured: false,
        backgroundDisposables: [],
        terminal: {
          show: vi.fn(),
          sendText: vi.fn(),
          dispose: vi.fn(),
          shellIntegration: {
            cwd: { fsPath: cwd },
            executeCommand,
          },
        },
      } satisfies MockManagedTerminal;
      (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
        managed,
      ];
      return managed;
    });

    const result = await manager.executeCommand({
      owner: undefined,
      command: "npm run dev",
      cwd: "/workspace",
      background: true,
    });

    expect(result.terminal_id).toBe("term_bg_prompt");
    await waitForCondition(
      () =>
        manager.getBackgroundState({
          owner: undefined,
          terminalId: "term_bg_prompt",
        })?.is_running === false,
    );

    expect(
      manager.getBackgroundState({
        owner: undefined,
        terminalId: "term_bg_prompt",
      }),
    ).toMatchObject({
      is_running: false,
      exit_code: 130,
      output: "watching\n^C",
      output_captured: true,
    });
  });

  it("creates a separate default terminal when env map differs", async () => {
    const manager = new TerminalManager();

    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockResolvedValue(false);

    const first = await manager.executeCommand({
      owner: undefined,
      command: "echo first",
      cwd: "/workspace",
      env: { CI: "1" },
    });

    const second = await manager.executeCommand({
      owner: undefined,
      command: "echo second",
      cwd: "/workspace",
      env: { CI: "0" },
    });

    expect(first.terminal_id).not.toBe(second.terminal_id);
  });

  it("rejects terminal_id reuse when env differs", async () => {
    const manager = new TerminalManager();

    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockResolvedValue(false);

    const first = await manager.executeCommand({
      owner: undefined,
      command: "echo first",
      cwd: "/workspace",
      env: { CI: "1" },
    });

    await expect(
      manager.executeCommand({
        owner: undefined,
        command: "echo second",
        cwd: "/workspace",
        terminal_id: first.terminal_id,
      }),
    ).rejects.toThrow(/different env set/);
  });

  it("allows terminal_id reuse when env matches", async () => {
    const manager = new TerminalManager();

    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockResolvedValue(false);

    const first = await manager.executeCommand({
      owner: undefined,
      command: "echo first",
      cwd: "/workspace",
      env: { CI: "1" },
    });

    expect(
      manager.interruptTerminal({
        owner: undefined,
        terminalId: first.terminal_id,
      }),
    ).toBe(true);

    const second = await manager.executeCommand({
      owner: undefined,
      command: "echo second",
      cwd: "/workspace",
      terminal_id: first.terminal_id,
      env: { CI: "1" },
    });

    expect(second.terminal_id).toBe(first.terminal_id);
  });

  it("does not reuse a send_text fallback terminal while the prior command may still be running", async () => {
    const manager = new TerminalManager();

    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockResolvedValue(false);

    const first = await manager.executeCommand({
      owner: undefined,
      command: "long-running-command",
      cwd: "/workspace",
    });

    const second = await manager.executeCommand({
      owner: undefined,
      command: "another-command",
      cwd: "/workspace",
    });

    expect(first.execution_mode).toBe("send_text");
    expect(second.execution_mode).toBe("send_text");
    expect(first.terminal_id).not.toBe(second.terminal_id);

    const firstState = manager.getBackgroundState({
      owner: undefined,
      terminalId: first.terminal_id,
    });
    expect(firstState).toMatchObject({
      is_running: true,
      output_captured: false,
      exit_code: null,
    });
  });

  it("releases a send_text fallback reservation and deferred cleanup when interrupted", async () => {
    const manager = new TerminalManager();
    const onCommandFinalizationDeferred = vi.fn();
    const onCommandFinalized = vi.fn();

    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockResolvedValue(false);

    const first = await manager.executeCommand({
      owner: undefined,
      command: "long-running-command",
      cwd: "/workspace",
      onCommandFinalizationDeferred,
      onCommandFinalized,
    });

    expect(onCommandFinalizationDeferred).toHaveBeenCalledTimes(1);
    expect(onCommandFinalized).not.toHaveBeenCalled();
    const firstState = manager.getBackgroundState({
      owner: undefined,
      terminalId: first.terminal_id,
    });
    expect(firstState?.is_running).toBe(true);

    expect(
      manager.interruptTerminal({
        owner: undefined,
        terminalId: first.terminal_id,
      }),
    ).toBe(true);
    expect(onCommandFinalized).toHaveBeenCalledTimes(1);

    const releasedState = manager.getBackgroundState({
      owner: undefined,
      terminalId: first.terminal_id,
    });
    expect(releasedState).toMatchObject({
      is_running: false,
      output_captured: false,
      exit_code: null,
    });

    const second = await manager.executeCommand({
      owner: undefined,
      command: "after-interrupt",
      cwd: "/workspace",
      terminal_id: first.terminal_id,
    });

    expect(second.terminal_id).toBe(first.terminal_id);
  });

  it("prunes managed terminals that are no longer open before listing", () => {
    const manager = new TerminalManager();
    const retainedTerminal = {
      name: "AgentLink",
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
    } satisfies MockVscodeTerminal;
    const closedTerminal = {
      name: "AgentLink",
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
    } satisfies MockVscodeTerminal;

    (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
      {
        id: "term_open",
        name: "AgentLink",
        cwd: "/workspace",
        busy: false,
        backgroundRunning: false,
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundExitCode: null,
        backgroundOutputCaptured: false,
        backgroundDisposables: [],
        terminal: retainedTerminal,
      },
      {
        id: "term_closed",
        name: "AgentLink",
        cwd: "/workspace",
        busy: false,
        backgroundRunning: false,
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundExitCode: null,
        backgroundOutputCaptured: false,
        backgroundDisposables: [],
        terminal: closedTerminal,
      },
    ];
    (vscode.window as unknown as MockVscodeWindow).terminals = [
      retainedTerminal,
    ];

    expect(manager.listTerminals({ owner: undefined })).toEqual([
      { id: "term_open", name: "AgentLink", busy: false },
    ]);
    expect(
      manager.getRecentlyClosedTerminals({ owner: undefined }),
    ).toHaveLength(1);
    expect(
      manager.getRecentlyClosedTerminals({ owner: undefined })[0]?.id,
    ).toBe("term_closed");
  });

  it("retains bounded output and status after a managed terminal closes", () => {
    const manager = new TerminalManager();
    const terminal = {
      name: "AgentLink",
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
    } satisfies MockVscodeTerminal;
    const oversized = `${"x".repeat(45 * 1024)}\nfinal output`;
    const managed = {
      id: "term_closed_output",
      name: "AgentLink",
      cwd: "/workspace",
      busy: false,
      backgroundRunning: false,
      lastCommandEndedAt: 0,
      outputBuffer: oversized,
      backgroundExitCode: 9,
      backgroundOutputCaptured: true,
      backgroundDisposables: [],
      terminal,
    } satisfies MockManagedTerminal;
    (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
      managed,
    ];

    manager.closeTerminals({ owner: undefined });

    expect(
      manager.getBackgroundState({ owner: undefined, terminalId: managed.id }),
    ).toMatchObject({
      is_running: false,
      state: "completed",
      exit_code: 9,
      output_captured: true,
    });
    const snapshot = manager.getBackgroundState({
      owner: undefined,
      terminalId: managed.id,
    })!;
    expect(snapshot.output).toContain("final output");
    expect(snapshot.output.length).toBeLessThanOrEqual(40 * 1024);
  });

  it("does not re-adopt terminals while VS Code still reports pending disposal", () => {
    const manager = new TerminalManager();
    const terminal = {
      name: "AgentLink",
      shellIntegration: {
        cwd: { fsPath: "/workspace" },
        executeCommand: vi.fn(),
      },
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
    } satisfies MockVscodeTerminal;
    (vscode.window as unknown as MockVscodeWindow).terminals = [terminal];
    (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
      {
        id: "term_pending_close",
        name: "AgentLink",
        cwd: "/workspace",
        busy: false,
        backgroundRunning: false,
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundExitCode: 0,
        backgroundOutputCaptured: true,
        backgroundDisposables: [],
        terminal,
      },
    ];

    expect(manager.closeTerminals({ owner: undefined })).toEqual({ closed: 1 });
    expect(manager.listTerminals({ owner: undefined })).toEqual([]);
  });

  it("reports a never-run managed terminal as completed rather than unknown", () => {
    const manager = new TerminalManager();
    const terminal = {
      name: "AgentLink",
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
    } satisfies MockVscodeTerminal;
    (manager as unknown as { terminals: MockManagedTerminal[] }).terminals = [
      {
        id: "term_idle",
        name: "AgentLink",
        cwd: "/workspace",
        busy: false,
        backgroundRunning: false,
        backgroundState: "completed",
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundExitCode: null,
        backgroundOutputCaptured: false,
        backgroundDisposables: [],
        terminal,
      },
    ];

    expect(
      manager.getBackgroundState({ owner: undefined, terminalId: "term_idle" }),
    ).toMatchObject({
      is_running: false,
      state: "completed",
      exit_code: null,
    });
  });

  it("adopts currently open AgentLink terminals before listing", () => {
    const agentTerminal = {
      name: "AgentLink",
      shellIntegration: {
        cwd: { fsPath: "/workspace" },
        executeCommand: vi.fn(),
      },
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
    } satisfies MockVscodeTerminal;
    (vscode.window as unknown as MockVscodeWindow).terminals = [agentTerminal];

    const manager = new TerminalManager();

    expect(manager.listTerminals({ owner: undefined })).toEqual([
      {
        id: expect.stringMatching(/^term_/),
        name: "AgentLink",
        busy: false,
        stale: true,
      },
    ]);
  });

  it("does not adopt non-AgentLink open terminals", () => {
    const userTerminal = {
      name: "zsh",
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
    } satisfies MockVscodeTerminal;
    (vscode.window as unknown as MockVscodeWindow).terminals = [userTerminal];

    const manager = new TerminalManager();

    expect(manager.listTerminals({ owner: undefined })).toEqual([]);
  });

  it("rejects terminal_id reuse for adopted stale terminals", async () => {
    const staleTerminal = {
      name: "AgentLink",
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
    } satisfies MockVscodeTerminal;
    (vscode.window as unknown as MockVscodeWindow).terminals = [staleTerminal];

    const manager = new TerminalManager();
    const stale = manager.listTerminals({ owner: undefined })[0];
    expect(stale).toMatchObject({ name: "AgentLink", stale: true });

    await expect(
      manager.executeCommand({
        owner: undefined,
        command: "echo should-not-run",
        cwd: "/workspace",
        terminal_id: stale?.id,
      }),
    ).rejects.toThrow(/adopted after extension reload/);
  });
});
