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
  backgroundRunning: boolean;
  lastCommandEndedAt: number;
  outputBuffer: string;
  backgroundExitCode: number | null;
  backgroundOutputCaptured: boolean;
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
          createTerminal: (cwd: string, name: string) => MockManagedTerminal;
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
      command: "pwd",
      cwd: "/workspace",
    });

    expect(createTerminalSpy).toHaveBeenCalledWith(
      "/workspace",
      "AgentLink",
      undefined,
    );
    expect(result.terminal_id).toBe("term_new");
    expect(existing.terminal.sendText).not.toHaveBeenCalled();
  });

  it("marks a reused terminal busy before awaiting cooldown so concurrent callers cannot race onto it", async () => {
    const manager = new TerminalManager();

    const existing = {
      id: "term_existing",
      name: "AgentLink",
      cwd: "/workspace",
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
          createTerminal: (cwd: string, name: string) => MockManagedTerminal;
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
      command: "echo first",
      cwd: "/workspace",
    });
    await Promise.resolve();

    expect(existing.busy).toBe(true);
    expect(waitForCooldownSpy).toHaveBeenCalledTimes(1);

    const second = manager.executeCommand({
      command: "echo second",
      cwd: "/workspace",
    });
    await Promise.resolve();

    expect(createTerminalSpy).toHaveBeenCalledWith(
      "/workspace",
      "AgentLink",
      undefined,
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
      command: "echo no-capture",
      cwd: "/workspace/no-capture",
    });

    expect(result.output_captured).toBe(false);
    expect(result.execution_mode).toBe("send_text");
    expect(result.command_sent).toBe(true);
    expect(result.verification_hint).toContain("Do not re-run");
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
      command: "npm run dev",
      cwd: "/workspace",
      background: true,
    });

    expect(result.terminal_id).toBe("term_bg_prompt");
    await waitForCondition(
      () =>
        manager.getBackgroundState("term_bg_prompt")?.is_running === false,
    );

    expect(manager.getBackgroundState("term_bg_prompt")).toMatchObject({
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
      command: "echo first",
      cwd: "/workspace",
      env: { CI: "1" },
    });

    const second = await manager.executeCommand({
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
      command: "echo first",
      cwd: "/workspace",
      env: { CI: "1" },
    });

    await expect(
      manager.executeCommand({
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
      command: "echo first",
      cwd: "/workspace",
      env: { CI: "1" },
    });

    expect(manager.interruptTerminal(first.terminal_id)).toBe(true);

    const second = await manager.executeCommand({
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
      command: "long-running-command",
      cwd: "/workspace",
    });

    const second = await manager.executeCommand({
      command: "another-command",
      cwd: "/workspace",
    });

    expect(first.execution_mode).toBe("send_text");
    expect(second.execution_mode).toBe("send_text");
    expect(first.terminal_id).not.toBe(second.terminal_id);

    const firstState = manager.getBackgroundState(first.terminal_id);
    expect(firstState).toMatchObject({
      is_running: true,
      output_captured: false,
      exit_code: null,
    });
  });

  it("releases a send_text fallback reservation when interrupted", async () => {
    const manager = new TerminalManager();

    vi.spyOn(
      manager as unknown as {
        waitForShellIntegration: (terminal: unknown) => Promise<boolean>;
      },
      "waitForShellIntegration",
    ).mockResolvedValue(false);

    const first = await manager.executeCommand({
      command: "long-running-command",
      cwd: "/workspace",
    });

    const firstState = manager.getBackgroundState(first.terminal_id);
    expect(firstState?.is_running).toBe(true);

    expect(manager.interruptTerminal(first.terminal_id)).toBe(true);

    const releasedState = manager.getBackgroundState(first.terminal_id);
    expect(releasedState).toMatchObject({
      is_running: false,
      output_captured: false,
      exit_code: null,
    });

    const second = await manager.executeCommand({
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

    expect(manager.listTerminals()).toEqual([
      { id: "term_open", name: "AgentLink", busy: false },
    ]);
    expect(manager.getRecentlyClosedTerminals()).toHaveLength(1);
    expect(manager.getRecentlyClosedTerminals()[0]?.id).toBe("term_closed");
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

    expect(manager.listTerminals()).toEqual([
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

    expect(manager.listTerminals()).toEqual([]);
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
    const stale = manager.listTerminals()[0];
    expect(stale).toMatchObject({ name: "AgentLink", stale: true });

    await expect(
      manager.executeCommand({
        command: "echo should-not-run",
        cwd: "/workspace",
        terminal_id: stale?.id,
      }),
    ).rejects.toThrow(/adopted after extension reload/);
  });
});
