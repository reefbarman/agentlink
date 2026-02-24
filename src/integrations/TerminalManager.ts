import * as vscode from "vscode";

import { cleanTerminalOutput } from "../util/ansi.js";

let terminalIconPath: vscode.Uri | undefined;

export function initializeTerminalManager(extensionUri: vscode.Uri): void {
  terminalIconPath = vscode.Uri.joinPath(
    extensionUri,
    "media",
    "claude-terminal.svg",
  );
}

interface ManagedTerminal {
  id: string;
  terminal: vscode.Terminal;
  name: string;
  cwd: string;
  busy: boolean;
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
}

export interface ExecuteOptions {
  command: string;
  cwd: string;
  terminal_id?: string;
  terminal_name?: string;
  background?: boolean;
  timeout?: number;
}

const SHELL_INTEGRATION_TIMEOUT = 5000; // 5 seconds
const SHELL_INTEGRATION_POLL_INTERVAL = 100; // 100ms

let nextTerminalId = 1;

export class TerminalManager {
  private terminals: ManagedTerminal[] = [];
  private disposables: vscode.Disposable[] = [];

  constructor() {
    // Clean up terminals that get closed
    this.disposables.push(
      vscode.window.onDidCloseTerminal((closedTerminal) => {
        this.terminals = this.terminals.filter(
          (t) => t.terminal !== closedTerminal,
        );
      }),
    );
  }

  async executeCommand(options: ExecuteOptions): Promise<CommandResult> {
    const managed = this.resolveTerminal(options);
    managed.busy = true;

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
          options.command,
          options.cwd,
          hasShellIntegration,
        );
      }

      if (hasShellIntegration) {
        return await this.executeWithShellIntegration(
          managed,
          options.command,
          options.cwd,
          options.timeout,
        );
      } else {
        return this.executeWithSendText(managed, options.command, options.cwd);
      }
    } finally {
      managed.busy = false;
    }
  }

  private resolveTerminal(options: ExecuteOptions): ManagedTerminal {
    const { cwd, terminal_id, terminal_name } = options;

    // If terminal_id is specified, find that specific terminal
    if (terminal_id) {
      const existing = this.terminals.find((t) => t.id === terminal_id);
      if (existing) {
        return existing;
      }
      // If not found, create a new one with that ID concept (fall through to creation)
    }

    // If terminal_name is specified, find or create by name
    if (terminal_name) {
      const existing = this.terminals.find(
        (t) => t.name === terminal_name && !t.busy,
      );
      if (existing) {
        return existing;
      }
      // Create with the specified name
      return this.createTerminal(cwd, terminal_name);
    }

    // Default: reuse any idle default terminal.
    // Prefer one with matching cwd, but fall back to any idle one
    // (the stored cwd is just the creation cwd — after commands run it may differ).
    const idleDefaults = this.terminals.filter(
      (t) => !t.busy && t.name === "Native Claude",
    );
    const cwdMatch = idleDefaults.find((t) => t.cwd === cwd);
    if (cwdMatch) {
      return cwdMatch;
    }
    if (idleDefaults.length > 0) {
      return idleDefaults[0];
    }

    return this.createTerminal(cwd, "Native Claude");
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
      },
    });

    const id = `term_${nextTerminalId++}`;
    const managed: ManagedTerminal = { id, terminal, name, cwd, busy: false };
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

      if (timeout !== undefined) {
        const timer = setTimeout(() => {
          timedOut = true;
          resolve(undefined);
        }, timeout);
        disposables.push({ dispose: () => clearTimeout(timer) });
      }
    });

    // Execute the command
    const execution = shellIntegration.executeCommand(command);

    // Collect output from the stream
    let output = "";
    const stream = execution.read();

    // Race stream reading against exit code / marker / timeout.
    // The stream's async iterator can hang even after the command finishes
    // (VS Code shell integration quirk), so we must not block on it alone.
    // The marker fallback catches cases where the event is dropped but the
    // shell did send the OSC 633;D completion sequence.
    //
    // We also check for the 633;D marker directly in the stream data itself:
    // if the stream keeps delivering data past the command boundary (the bug),
    // the shell's completion marker will appear in the chunks.
    let resolveStreamMarker: ((code: number | undefined) => void) | undefined;
    const streamMarkerPromise = new Promise<number | undefined>((resolve) => {
      resolveStreamMarker = resolve;
    });

    const MARKER_RE = /\x1b\]633;D(?:;(\d+))?(?:\x07|\x1b\\)/;

    const streamDone = (async () => {
      for await (const data of stream) {
        output += data;
        // Check tail of accumulated output for the completion marker.
        // Using the tail handles markers split across chunks.
        const tail = output.slice(-50);
        const match = tail.match(MARKER_RE);
        if (match) {
          // Truncate output to before the marker (strip prompt/protocol data)
          const markerIdx = output.lastIndexOf("\x1b]633;D");
          if (markerIdx >= 0) output = output.slice(0, markerIdx);
          resolveStreamMarker!(
            match[1] !== undefined ? parseInt(match[1], 10) : undefined,
          );
          break;
        }
      }
    })();

    await Promise.race([streamDone, exitCodePromise, streamMarkerPromise]);

    // Clean up the output
    output = cleanTerminalOutput(output);

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
      output,
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
    // Fire-and-forget: send command to terminal without waiting for completion
    if (hasShellIntegration) {
      managed.terminal.shellIntegration!.executeCommand(command);
    } else {
      managed.terminal.sendText(command, true);
    }

    return {
      exit_code: null,
      output: `Background command started in terminal "${managed.name}". Use terminal_id "${managed.id}" to run further commands in this terminal.`,
      cwd,
      output_captured: false,
      terminal_id: managed.id,
    };
  }

  /**
   * Close managed terminals. Returns the count of terminals closed.
   * If names are specified, only closes terminals with matching names.
   * Otherwise closes all managed terminals.
   */
  closeTerminals(names?: string[]): number {
    const toClose = names
      ? this.terminals.filter((t) => names.includes(t.name))
      : [...this.terminals];

    for (const managed of toClose) {
      managed.terminal.dispose();
    }

    // The onDidCloseTerminal listener will clean up the array,
    // but do it eagerly too for immediate consistency.
    const closedIds = new Set(toClose.map((t) => t.id));
    this.terminals = this.terminals.filter((t) => !closedIds.has(t.id));

    return toClose.length;
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
