import * as vscode from "vscode";

import { cleanTerminalOutput } from "../util/ansi.js";

let terminalIconPath: vscode.Uri | undefined;

/**
 * Escape `!` characters that would trigger shell history expansion.
 * History expansion occurs in unquoted and double-quoted contexts but NOT
 * inside single quotes. Walks the string tracking quote state and replaces
 * unprotected `!` with `\!`.
 */
export function escapeHistoryExpansion(command: string): string {
  if (!command.includes("!")) return command;
  let result = "";
  let inSingle = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const prev = i > 0 ? command[i - 1] : "";
    if (ch === "'" && prev !== "\\") {
      inSingle = !inSingle;
      result += ch;
    } else if (ch === "!" && !inSingle && prev !== "\\") {
      result += "\\!";
    } else {
      result += ch;
    }
  }
  return result;
}

export function initializeTerminalManager(
  extensionUri: vscode.Uri,
  log?: (message: string) => void,
): void {
  terminalIconPath = vscode.Uri.joinPath(
    extensionUri,
    "media",
    "claude-terminal.svg",
  );
  if (log) {
    getTerminalManager().log = log;
  }
}

interface ManagedTerminal {
  id: string;
  terminal: vscode.Terminal;
  name: string;
  cwd: string;
  busy: boolean;
  /** Accumulated output from the current shell integration execution */
  outputBuffer: string;
  /** True while a background command is actively running */
  backgroundRunning: boolean;
  /** Exit code of the completed background command (null while running or if unknown) */
  backgroundExitCode: number | null;
  /** Whether output was captured for the background command */
  backgroundOutputCaptured: boolean;
  /** Disposables for background listeners (stream reader, exit listener) */
  backgroundDisposables: vscode.Disposable[];
}

export interface CommandResult {
  exit_code: number | null;
  output: string;
  cwd: string;
  output_captured: boolean;
  terminal_id: string;
  output_file?: string;
  total_lines?: number;
  lines_shown?: number;
  command?: string;
  command_modified?: boolean;
  original_command?: string;
  follow_up?: string;
}

export interface ExecuteOptions {
  command: string;
  cwd: string;
  terminal_id?: string;
  terminal_name?: string;
  /** Split the new terminal alongside this terminal (by id or name) */
  split_from?: string;
  background?: boolean;
  timeout?: number;
  /** Called once the terminal is resolved, before execution begins */
  onTerminalAssigned?: (terminalId: string) => void;
}

const SHELL_INTEGRATION_TIMEOUT = 5000; // 5 seconds
const SHELL_INTEGRATION_POLL_INTERVAL = 100; // 100ms

let nextTerminalId = 1;

export class TerminalManager {
  private terminals: ManagedTerminal[] = [];
  private disposables: vscode.Disposable[] = [];
  log?: (message: string) => void;

  constructor() {
    // Clean up terminals that get closed
    this.disposables.push(
      vscode.window.onDidCloseTerminal((closedTerminal) => {
        const closing = this.terminals.filter(
          (t) => t.terminal === closedTerminal,
        );
        for (const managed of closing) {
          for (const d of managed.backgroundDisposables) d.dispose();
          managed.backgroundDisposables = [];
        }
        this.terminals = this.terminals.filter(
          (t) => t.terminal !== closedTerminal,
        );
      }),
    );
  }

  async executeCommand(options: ExecuteOptions): Promise<CommandResult> {
    // Escape ! characters to prevent shell history expansion in
    // interactive terminals (zsh/bash treat ! specially in double quotes).
    const command =
      process.platform !== "win32"
        ? escapeHistoryExpansion(options.command)
        : options.command;

    const managed = await this.resolveTerminal(options);
    managed.busy = true;
    options.onTerminalAssigned?.(managed.id);

    try {
      // Show the terminal so the user can see it
      managed.terminal.show(true); // preserveFocus = true

      // Wait for shell integration
      const hasShellIntegration = await this.waitForShellIntegration(
        managed.terminal,
      );

      if (options.background) {
        return this.executeBackground(
          managed,
          command,
          options.cwd,
          hasShellIntegration,
        );
      }

      if (hasShellIntegration) {
        return await this.executeWithShellIntegration(
          managed,
          command,
          options.cwd,
          options.timeout,
        );
      } else {
        return this.executeWithSendText(managed, command, options.cwd);
      }
    } finally {
      managed.busy = false;
    }
  }

  private async resolveTerminal(
    options: ExecuteOptions,
  ): Promise<ManagedTerminal> {
    const { cwd, terminal_id, terminal_name, split_from } = options;

    // If terminal_id is specified, find that specific terminal
    if (terminal_id) {
      const existing = this.terminals.find((t) => t.id === terminal_id);
      if (existing) {
        return existing;
      }
      // If not found, fall through to creation
    }

    // If terminal_name is specified, find or create by name
    if (terminal_name) {
      const existing = this.terminals.find(
        (t) => t.name === terminal_name && !t.busy && !t.backgroundRunning,
      );
      if (existing) {
        return existing;
      }
      // Create with the specified name, optionally split from a parent
      const managed = this.createTerminal(cwd, terminal_name);
      if (split_from) {
        await this.splitTerminalBeside(managed, split_from);
      }
      return managed;
    }

    // Default: reuse any idle default terminal.
    // Prefer one with matching cwd, but fall back to any idle one
    // (the stored cwd is just the creation cwd — after commands run it may differ).
    const idleDefaults = this.terminals.filter(
      (t) => !t.busy && !t.backgroundRunning && t.name === "Native Claude",
    );
    const cwdMatch = idleDefaults.find((t) => t.cwd === cwd);
    if (cwdMatch) {
      return cwdMatch;
    }
    if (idleDefaults.length > 0) {
      return idleDefaults[0];
    }

    const managed = this.createTerminal(cwd, "Native Claude");
    if (split_from) {
      await this.splitTerminalBeside(managed, split_from);
    }
    return managed;
  }

  /**
   * Split the parent terminal and replace the child's vscode.Terminal reference
   * with the newly created split terminal. Works around a VS Code bug (#205254)
   * where `createTerminal({ location: { parentTerminal } })` is silently ignored
   * when the parent was created in a previous async operation.
   */
  private async splitTerminalBeside(
    child: ManagedTerminal,
    splitFrom: string,
  ): Promise<void> {
    const parent =
      this.terminals.find((t) => t.id === splitFrom) ??
      this.terminals.find((t) => t.name === splitFrom);
    if (!parent) {
      this.log?.(
        `split_from "${splitFrom}" not found in ${this.terminals.length} terminals: [${this.terminals.map((t) => `${t.name}(${t.id})`).join(", ")}]`,
      );
      return;
    }

    this.log?.(`split_from: splitting beside "${parent.name}" (${parent.id})`);

    // Dispose the child terminal we just created — we'll replace it with
    // the split terminal that VS Code creates from the parent.
    // Detach the old terminal reference first so onDidCloseTerminal doesn't
    // remove the managed object from this.terminals during the swap.
    const oldTerminal = child.terminal;
    child.terminal = undefined as unknown as vscode.Terminal;
    oldTerminal.dispose();

    // Focus the parent terminal so the split command acts on it
    parent.terminal.show(false);
    // Small delay to ensure the parent terminal is focused
    await new Promise((r) => setTimeout(r, 150));

    // Listen for the new terminal that the split command will create
    const splitTerminal = await new Promise<vscode.Terminal>((resolve) => {
      const disposable = vscode.window.onDidOpenTerminal((t) => {
        disposable.dispose();
        resolve(t);
      });
      vscode.commands.executeCommand("workbench.action.terminal.split");
    });

    // Rename the split terminal to the requested name
    splitTerminal.show(false);
    await new Promise((r) => setTimeout(r, 50));
    await vscode.commands.executeCommand(
      "workbench.action.terminal.renameWithArg",
      { name: child.name },
    );

    // Replace the terminal reference on the managed object
    child.terminal = splitTerminal;

    this.log?.(
      `split_from: created split terminal "${child.name}" (${child.id})`,
    );
  }

  private createTerminal(cwd: string, name: string): ManagedTerminal {
    const terminal = vscode.window.createTerminal({
      name,
      cwd,
      iconPath: terminalIconPath ?? new vscode.ThemeIcon("terminal"),
      env: {
        // Disable pagers so commands like `git log` don't become interactive
        PAGER: process.platform === "win32" ? "" : "cat",
        GIT_PAGER: process.platform === "win32" ? "" : "cat",
        // Prevent git from prompting for credentials interactively
        GIT_TERMINAL_PROMPT: "0",
        // Disable VTE to prevent prompt command interference
        VTE_VERSION: "0",
        // Clear ZSH EOL mark to prevent output artifacts
        PROMPT_EOL_MARK: "",
        // Auto-answer npm/npx prompts with yes
        npm_config_yes: "true",
        // Prevent apt/dpkg from prompting for configuration
        DEBIAN_FRONTEND: "noninteractive",
        // Disable man pager
        MANPAGER: process.platform === "win32" ? "" : "cat",
        // Disable systemd pager
        SYSTEMD_PAGER: "",
      },
    });

    const id = `term_${nextTerminalId++}`;
    const managed: ManagedTerminal = {
      id,
      terminal,
      name,
      cwd,
      busy: false,
      outputBuffer: "",
      backgroundRunning: false,
      backgroundExitCode: null,
      backgroundOutputCaptured: false,
      backgroundDisposables: [],
    };
    this.terminals.push(managed);
    return managed;
  }

  private async waitForShellIntegration(
    terminal: vscode.Terminal,
  ): Promise<boolean> {
    if (terminal.shellIntegration) {
      return true;
    }

    const elapsed = { ms: 0 };
    while (elapsed.ms < SHELL_INTEGRATION_TIMEOUT) {
      await new Promise((r) => setTimeout(r, SHELL_INTEGRATION_POLL_INTERVAL));
      elapsed.ms += SHELL_INTEGRATION_POLL_INTERVAL;
      if (terminal.shellIntegration) {
        return true;
      }
    }

    return false;
  }

  private async executeWithShellIntegration(
    managed: ManagedTerminal,
    command: string,
    cwd: string,
    timeout?: number,
  ): Promise<CommandResult> {
    const terminal = managed.terminal;
    const shellIntegration = terminal.shellIntegration!;
    let timedOut = false;
    const disposables: vscode.Disposable[] = [];

    // Reset the output buffer for this execution
    managed.outputBuffer = "";

    // --- Primary: shell integration events ---
    const exitCodePromise = new Promise<number | undefined>((resolve) => {
      disposables.push(
        vscode.window.onDidEndTerminalShellExecution((e) => {
          if (e.terminal === terminal) {
            resolve(e.exitCode);
          }
        }),
      );

      // Terminal closed while command is running — exit event will never fire
      disposables.push(
        vscode.window.onDidCloseTerminal((t) => {
          if (t === terminal) {
            resolve(undefined);
          }
        }),
      );

      // Defer timeout until the shell actually starts executing the command.
      // This prevents terminal startup / shell queue delays from eating into
      // the user-specified timeout.
      if (timeout !== undefined) {
        disposables.push(
          vscode.window.onDidStartTerminalShellExecution((e) => {
            if (e.terminal === terminal) {
              const timer = setTimeout(() => {
                timedOut = true;
                resolve(undefined);
              }, timeout);
              disposables.push({ dispose: () => clearTimeout(timer) });
            }
          }),
        );
      }
    });

    // Execute the command
    const execution = shellIntegration.executeCommand(command);

    // Collect output from the stream (stored on managed terminal for external access)
    const stream = execution.read();

    // Race stream reading against exit code / marker / timeout.
    // The stream's async iterator can hang even after the command finishes
    // (VS Code shell integration quirk), so we must not block on it alone.
    // The marker fallback catches cases where the event is dropped but the
    // shell did send the OSC 633;D completion sequence.
    //
    // We check for the 633;D marker both inside the stream loop (fast path)
    // and via independent polling (catches markers the stream loop misses,
    // e.g. if the stream hangs after yielding the marker data).
    let resolveStreamMarker: ((code: number | undefined) => void) | undefined;
    let streamMarkerResolved = false;
    const streamMarkerPromise = new Promise<number | undefined>((resolve) => {
      resolveStreamMarker = (code) => {
        if (streamMarkerResolved) return;
        streamMarkerResolved = true;
        resolve(code);
      };
    });

    const MARKER_RE = /\x1b\]633;D(?:;(\d+))?(?:\x07|\x1b\\)/;

    // Track how far we've scanned so we don't re-check old data
    let lastMarkerCheckPos = 0;

    const checkForMarker = (): boolean => {
      // Search from last checked position (with overlap for split markers)
      const searchFrom = Math.max(0, lastMarkerCheckPos - 20);
      const region = managed.outputBuffer.slice(searchFrom);
      const match = region.match(MARKER_RE);
      if (match) {
        resolveStreamMarker!(
          match[1] !== undefined ? parseInt(match[1], 10) : undefined,
        );
        return true;
      }
      lastMarkerCheckPos = managed.outputBuffer.length;
      return false;
    };

    // Independent marker polling — runs outside the stream loop so it can
    // detect markers even if the for-await iterator hangs after yielding data.
    const MARKER_POLL_MS = 500;
    const markerPoll = setInterval(() => {
      if (managed.outputBuffer.length > lastMarkerCheckPos) {
        checkForMarker();
      }
    }, MARKER_POLL_MS);

    const streamDone = (async () => {
      for await (const data of stream) {
        managed.outputBuffer += data;
        if (checkForMarker()) break;
      }
    })();

    await Promise.race([streamDone, exitCodePromise, streamMarkerPromise]);

    clearInterval(markerPoll);

    // Strip the completion marker from output (if present)
    const markerIdx = managed.outputBuffer.lastIndexOf("\x1b]633;D");
    if (markerIdx >= 0) {
      managed.outputBuffer = managed.outputBuffer.slice(0, markerIdx);
    }

    // Clean up the output
    managed.outputBuffer = cleanTerminalOutput(managed.outputBuffer);

    // Bounded wait for exit code: if the promise hasn't resolved yet (e.g.
    // stream finished but exit event is delayed), give it a short grace
    // period rather than blocking forever.
    const EXIT_CODE_GRACE_MS = 5_000;
    const exitCode = await Promise.race([
      exitCodePromise,
      streamMarkerPromise,
      new Promise<undefined>((r) =>
        setTimeout(() => r(undefined), EXIT_CODE_GRACE_MS),
      ),
    ]);

    // Clean up all listeners
    for (const d of disposables) d.dispose();

    const result: CommandResult = {
      exit_code: exitCode ?? null,
      output: managed.outputBuffer,
      cwd,
      output_captured: true,
      terminal_id: managed.id,
    };

    if (timedOut) {
      result.output += `\n[Timed out after ${timeout! / 1000}s — command may still be running in terminal]`;
    }

    return result;
  }

  private executeWithSendText(
    managed: ManagedTerminal,
    command: string,
    cwd: string,
  ): CommandResult {
    managed.terminal.sendText(command, true);

    return {
      exit_code: null,
      output:
        "Command sent to terminal. Output capture unavailable — shell integration is not active. " +
        "Check VS Code terminal settings to enable shell integration.",
      cwd,
      output_captured: false,
      terminal_id: managed.id,
    };
  }

  private executeBackground(
    managed: ManagedTerminal,
    command: string,
    cwd: string,
    hasShellIntegration: boolean,
  ): CommandResult {
    // Clean up any previous background state
    for (const d of managed.backgroundDisposables) d.dispose();
    managed.backgroundDisposables = [];
    managed.backgroundRunning = true;
    managed.backgroundExitCode = null;
    managed.outputBuffer = "";

    if (hasShellIntegration) {
      managed.backgroundOutputCaptured = true;
      const execution =
        managed.terminal.shellIntegration!.executeCommand(command);
      const stream = execution.read();

      // Read stream asynchronously — don't await, let it run in background
      const streamDone = (async () => {
        for await (const data of stream) {
          managed.outputBuffer += data;
          // Check for OSC 633;D completion marker in stream
          const tail = managed.outputBuffer.slice(-50);
          const match = tail.match(/\x1b\]633;D(?:;(\d+))?(?:\x07|\x1b\\)/);
          if (match) {
            const markerIdx = managed.outputBuffer.lastIndexOf("\x1b]633;D");
            if (markerIdx >= 0)
              managed.outputBuffer = managed.outputBuffer.slice(0, markerIdx);
            managed.backgroundExitCode =
              match[1] !== undefined ? parseInt(match[1], 10) : null;
            managed.backgroundRunning = false;
            managed.outputBuffer = cleanTerminalOutput(managed.outputBuffer);
            for (const d of managed.backgroundDisposables) d.dispose();
            managed.backgroundDisposables = [];
            break;
          }
        }
      })();

      // Listen for shell execution end event as primary completion signal
      const exitDisposable = vscode.window.onDidEndTerminalShellExecution(
        (e) => {
          if (e.terminal === managed.terminal) {
            managed.backgroundExitCode = e.exitCode ?? null;
            managed.backgroundRunning = false;
            managed.outputBuffer = cleanTerminalOutput(managed.outputBuffer);
            for (const d of managed.backgroundDisposables) d.dispose();
            managed.backgroundDisposables = [];
          }
        },
      );

      // Listen for terminal close
      const closeDisposable = vscode.window.onDidCloseTerminal((t) => {
        if (t === managed.terminal) {
          managed.backgroundRunning = false;
          managed.outputBuffer = cleanTerminalOutput(managed.outputBuffer);
          for (const d of managed.backgroundDisposables) d.dispose();
          managed.backgroundDisposables = [];
        }
      });

      managed.backgroundDisposables.push(exitDisposable, closeDisposable);

      // Catch stream errors silently (terminal may close mid-read)
      streamDone.catch(() => {
        managed.backgroundRunning = false;
      });
    } else {
      managed.backgroundOutputCaptured = false;
      managed.terminal.sendText(command, true);
    }

    return {
      exit_code: null,
      output: `Background command started in terminal "${managed.name}". Use terminal_id "${managed.id}" with get_terminal_output to check on progress.`,
      cwd,
      output_captured: false,
      terminal_id: managed.id,
    };
  }

  /**
   * Close managed terminals. Returns the count of terminals closed.
   * If names are specified, only closes terminals with matching names.
   * Otherwise closes all managed terminals.
   * Returns the count of closed terminals and any names that weren't found.
   */
  closeTerminals(names?: string[]): { closed: number; not_found?: string[] } {
    const toClose = names
      ? this.terminals.filter((t) => names.includes(t.name))
      : [...this.terminals];

    for (const managed of toClose) {
      for (const d of managed.backgroundDisposables) d.dispose();
      managed.backgroundDisposables = [];
      managed.terminal.dispose();
    }

    // The onDidCloseTerminal listener will clean up the array,
    // but do it eagerly too for immediate consistency.
    const closedIds = new Set(toClose.map((t) => t.id));
    this.terminals = this.terminals.filter((t) => !closedIds.has(t.id));

    // Report any requested names that weren't found
    const closedNames = new Set(toClose.map((t) => t.name));
    const notFound = names?.filter((n) => !closedNames.has(n));

    return {
      closed: toClose.length,
      ...(notFound && notFound.length > 0 && { not_found: notFound }),
    };
  }

  /**
   * Get accumulated output from a busy or background terminal.
   * Returns undefined if the terminal is not found.
   */
  getCurrentOutput(
    terminalId: string,
    options?: { force?: boolean },
  ): string | undefined {
    const managed = this.terminals.find((t) => t.id === terminalId);
    if (!managed) return undefined;
    if (
      !options?.force &&
      !managed.busy &&
      !managed.backgroundRunning &&
      !managed.backgroundOutputCaptured
    )
      return undefined;
    return cleanTerminalOutput(managed.outputBuffer);
  }

  /**
   * Get the background execution state of a terminal.
   * Returns undefined if the terminal is not found.
   */
  getBackgroundState(terminalId: string):
    | {
        is_running: boolean;
        exit_code: number | null;
        output: string;
        output_captured: boolean;
      }
    | undefined {
    const managed = this.terminals.find((t) => t.id === terminalId);
    if (!managed) return undefined;
    return {
      is_running: managed.backgroundRunning,
      exit_code: managed.backgroundExitCode,
      output: managed.backgroundRunning
        ? cleanTerminalOutput(managed.outputBuffer)
        : managed.outputBuffer,
      output_captured: managed.backgroundOutputCaptured,
    };
  }

  /**
   * Send Ctrl+C (SIGINT) to a managed terminal to interrupt the running process.
   * Returns true if the terminal was found and interrupted.
   */
  interruptTerminal(terminalId: string): boolean {
    const managed = this.terminals.find((t) => t.id === terminalId);
    if (!managed) return false;
    managed.terminal.sendText("\x03", false);
    return true;
  }

  /**
   * List all managed terminals with their current state.
   */
  listTerminals(): Array<{
    id: string;
    name: string;
    busy: boolean;
  }> {
    return this.terminals.map((t) => ({
      id: t.id,
      name: t.name,
      busy: t.busy,
    }));
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    // Don't close terminals — let the user keep them
  }
}

// Singleton instance
let instance: TerminalManager | null = null;

export function getTerminalManager(): TerminalManager {
  if (!instance) {
    instance = new TerminalManager();
  }
  return instance;
}

export function disposeTerminalManager(): void {
  if (instance) {
    instance.dispose();
    instance = null;
  }
}
