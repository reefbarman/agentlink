import * as vscode from "vscode";

import {
  sameTerminalOwnerScope,
  type ClosedTerminalSnapshot,
  type TerminalBackgroundState,
  type TerminalCloseRequest,
  type TerminalCommandResult,
  type TerminalExecuteOptions,
  type TerminalExecutionOwner,
  type TerminalLifecycleState,
  type TerminalListRequest,
  type TerminalOutputRequest,
  type TerminalRecentlyClosedRequest,
  type TerminalTargetRequest,
} from "../core/capabilities/terminal.js";
import { cleanTerminalOutput, cleanTerminalRawOutput } from "../util/ansi.js";
import {
  createTerminalMarkerTracker,
  findAndStripTerminalMarker,
  registerTerminalCompletionListeners,
} from "./terminalCompletion.js";

import { buildAgentExecutionEnv } from "../process/agentExecutionPolicy.js";

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

export function shouldEscapeHistoryExpansion(
  platform: NodeJS.Platform,
  shellPath?: string,
): boolean {
  if (platform !== "win32") return true;
  if (!shellPath) return false;
  const normalized = shellPath.toLowerCase();
  return /(^|[\\/])(bash|zsh)(\.exe)?$/.test(normalized);
}

export function initializeTerminalManager(
  extensionUri: vscode.Uri,
  log?: (message: string) => void,
): void {
  terminalIconPath = vscode.Uri.joinPath(
    extensionUri,
    "media",
    "agentlink-terminal.svg",
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
  owner?: TerminalExecutionOwner;
  busy: boolean;
  envKey?: string;
  implicit?: boolean;
  stale?: boolean;
  /** Timestamp when the last foreground command completed — used for reuse cooldown */
  lastCommandEndedAt: number;
  /** Accumulated raw output from the current shell integration execution */
  outputBuffer: string;
  /** True while a background command is actively running */
  backgroundRunning: boolean;
  /** Exit code of the completed background command (null while running or if unknown) */
  backgroundExitCode: number | null;
  /** Whether output was captured for the background command */
  backgroundOutputCaptured: boolean;
  /** Durable lifecycle classification for the latest background-capable command. */
  backgroundState?: TerminalLifecycleState;
  /** Disposables for background listeners (stream reader, exit listener) */
  backgroundDisposables: vscode.Disposable[];
  /** Resolves the active foreground execution into background mode. */
  detachForeground?: () => void;
  /** Cleanup owned by a command that outlived its foreground tool call. */
  deferredCommandFinalizer?: () => void;
}

export interface ManagedTerminalMetadataEvent {
  id: string;
  name: string;
  cwd?: string;
  busy: boolean;
  stale?: boolean;
}

export interface ManagedTerminalCommandEvent {
  terminalId: string;
  commandId: string;
  command: string;
  timestamp: number;
  captureLevel:
    | "full-agent-managed"
    | "shell-integration-output"
    | "command-sent-only";
}

export interface ManagedTerminalDataEvent {
  terminalId: string;
  commandId?: string;
  text: string;
  timestamp: number;
}

export interface ManagedTerminalCommandEndEvent {
  terminalId: string;
  commandId: string;
  timestamp: number;
  exitCode: number | null;
}

export interface ManagedTerminalEvents {
  open: ManagedTerminalMetadataEvent;
  close: ManagedTerminalMetadataEvent;
  state: ManagedTerminalMetadataEvent;
  commandStart: ManagedTerminalCommandEvent;
  data: ManagedTerminalDataEvent;
  commandEnd: ManagedTerminalCommandEndEvent;
}

type ManagedTerminalEventName = keyof ManagedTerminalEvents;
type ManagedTerminalListener<T extends ManagedTerminalEventName> = (
  event: ManagedTerminalEvents[T],
) => void;

export type CommandResult = TerminalCommandResult;
export type ExecuteOptions = TerminalExecuteOptions;

const SHELL_INTEGRATION_TIMEOUT = 15000; // 15 seconds (WSL2 / heavy shell configs can be slow)
const UNKNOWN_MARKER_EXIT_GRACE_MS = 500;

let nextTerminalId = 1;

export class TerminalManager {
  private terminals: ManagedTerminal[] = [];
  private disposables: vscode.Disposable[] = [];
  private recentlyClosed: ClosedTerminalSnapshot[] = [];
  /** Terminal objects requested for disposal but still visible in vscode.window.terminals. */
  private readonly pendingDisposals = new Set<vscode.Terminal>();
  private readonly eventListeners = new Map<
    ManagedTerminalEventName,
    Set<ManagedTerminalListener<ManagedTerminalEventName>>
  >();
  log?: (message: string) => void;

  /**
   * Rolling window of startup latencies (ms from executeCommand call to
   * onDidStartTerminalShellExecution firing). Used to understand typical
   * shell integration overhead so we can tune fallback timeouts.
   */
  private startupLatencies: number[] = [];
  private static readonly MAX_LATENCY_SAMPLES = 50;

  /**
   * Minimum ms between finishing one command and starting another on the
   * same terminal.  Prevents shell integration event loss caused by sending
   * a new command before the shell has fully processed the previous
   * command's OSC 633 completion sequences.
   */
  private static readonly REUSE_COOLDOWN_MS = 500;
  private static readonly MAX_RECENTLY_CLOSED = 20;
  private static readonly MAX_CLOSED_OUTPUT_CHARS = 40 * 1024;

  onTerminalEvent<T extends ManagedTerminalEventName>(
    eventName: T,
    listener: ManagedTerminalListener<T>,
  ): vscode.Disposable {
    const listeners = this.eventListeners.get(eventName) ?? new Set();
    listeners.add(
      listener as ManagedTerminalListener<ManagedTerminalEventName>,
    );
    this.eventListeners.set(eventName, listeners);
    return {
      dispose: () => {
        listeners.delete(
          listener as ManagedTerminalListener<ManagedTerminalEventName>,
        );
      },
    };
  }

  private emitTerminalEvent<T extends ManagedTerminalEventName>(
    eventName: T,
    event: ManagedTerminalEvents[T],
  ): void {
    const listeners = this.eventListeners.get(eventName);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }

  getManagedTerminalMetadataForTerminal(
    terminal: vscode.Terminal,
  ): ManagedTerminalMetadataEvent | undefined {
    this.syncTerminalRegistry();
    const managed = this.terminals.find(
      (candidate) => candidate.terminal === terminal,
    );
    return managed ? this.terminalMetadataEvent(managed) : undefined;
  }

  private terminalMetadataEvent(
    managed: ManagedTerminal,
  ): ManagedTerminalMetadataEvent {
    return {
      id: managed.id,
      name: managed.name,
      ...(managed.cwd && { cwd: managed.cwd }),
      busy: managed.busy || managed.backgroundRunning,
      ...(managed.stale && { stale: true }),
    };
  }

  private buildEnvKey(env?: Record<string, string>): string | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    const entries = Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([k, v]) => `${k}=${v}`).join("\n");
  }

  private matchesOwner(
    owner: TerminalExecutionOwner | undefined,
    requestedOwner: TerminalExecutionOwner | undefined,
  ): boolean {
    return (
      requestedOwner === undefined ||
      sameTerminalOwnerScope(owner, requestedOwner)
    );
  }

  private refreshOwner(
    terminal: ManagedTerminal,
    owner: TerminalExecutionOwner | undefined,
  ): void {
    terminal.owner = owner ? Object.freeze({ ...owner }) : undefined;
  }

  private findOwnedTerminal(
    terminalId: string,
    owner: TerminalExecutionOwner | undefined,
  ): ManagedTerminal | undefined {
    return this.terminals.find(
      (terminal) =>
        terminal.id === terminalId && this.matchesOwner(terminal.owner, owner),
    );
  }

  private getOpenVscodeTerminals(): vscode.Terminal[] | undefined {
    const maybeWindow =
      "window" in vscode
        ? (
            vscode as unknown as {
              window?: { terminals?: Iterable<vscode.Terminal> };
            }
          ).window
        : undefined;
    const terminals = maybeWindow?.terminals;
    if (!terminals || typeof terminals[Symbol.iterator] !== "function") {
      return undefined;
    }
    return [...terminals];
  }

  private adoptExistingAgentLinkTerminals(
    openTerminals = this.getOpenVscodeTerminals(),
  ): void {
    if (!openTerminals) return;

    for (const terminal of openTerminals) {
      if (
        terminal.name !== "AgentLink" ||
        this.pendingDisposals.has(terminal)
      ) {
        continue;
      }
      if (this.terminals.some((managed) => managed.terminal === terminal))
        continue;
      const cwd = terminal.shellIntegration?.cwd?.fsPath ?? "";
      const managed: ManagedTerminal = {
        id: `term_${nextTerminalId++}`,
        terminal,
        name: terminal.name,
        cwd,
        implicit: false,
        busy: false,
        stale: true,
        lastCommandEndedAt: 0,
        outputBuffer: "",
        backgroundRunning: false,
        backgroundExitCode: null,
        backgroundOutputCaptured: false,
        backgroundState: "completed",
        backgroundDisposables: [],
      };
      this.terminals.push(managed);
      this.emitTerminalEvent("open", this.terminalMetadataEvent(managed));
    }
  }

  private disposeBackgroundTracking(managed: ManagedTerminal): void {
    for (const disposable of managed.backgroundDisposables) {
      disposable.dispose();
    }
    managed.backgroundDisposables = [];
  }

  private stopTrackingManagedTerminal(managed: ManagedTerminal): void {
    this.disposeBackgroundTracking(managed);
    if (managed.backgroundRunning) {
      managed.backgroundRunning = false;
      managed.backgroundState = "unknown_termination";
    }
    this.rememberClosedTerminal(managed);
    this.finalizeDeferredCommand(managed);
    this.emitTerminalEvent("close", this.terminalMetadataEvent(managed));
  }

  private deferCommandFinalization(
    managed: ManagedTerminal,
    options: ExecuteOptions,
  ): void {
    if (!options.onCommandFinalized || managed.deferredCommandFinalizer) return;
    let finalized = false;
    managed.deferredCommandFinalizer = () => {
      if (finalized) return;
      finalized = true;
      try {
        options.onCommandFinalized?.();
      } catch (error) {
        this.log?.(`[terminal-cleanup] Deferred finalizer failed: ${error}`);
      }
    };
    options.onCommandFinalizationDeferred?.();
  }

  private finalizeDeferredCommand(managed: ManagedTerminal): void {
    const finalize = managed.deferredCommandFinalizer;
    managed.deferredCommandFinalizer = undefined;
    finalize?.();
  }

  private finishBackgroundCommand(
    managed: ManagedTerminal,
    commandId: string,
    options?: { normalizeOutput?: boolean },
  ): boolean {
    if (!managed.backgroundRunning) return false;
    managed.backgroundRunning = false;
    const actualCwd = managed.terminal.shellIntegration?.cwd?.fsPath;
    if (actualCwd) managed.cwd = actualCwd;
    managed.lastCommandEndedAt = Date.now();
    if (options?.normalizeOutput) {
      managed.outputBuffer = cleanTerminalRawOutput(managed.outputBuffer);
    }
    managed.backgroundState =
      managed.backgroundExitCode === null ? "unknown_termination" : "completed";
    this.emitTerminalEvent("commandEnd", {
      terminalId: managed.id,
      commandId,
      timestamp: managed.lastCommandEndedAt,
      exitCode: managed.backgroundExitCode,
    });
    this.disposeBackgroundTracking(managed);
    this.finalizeDeferredCommand(managed);
    return true;
  }

  private syncTerminalRegistry(): void {
    const openTerminals = this.getOpenVscodeTerminals();
    if (!openTerminals) return;

    const openSet = new Set(openTerminals);
    for (const terminal of this.pendingDisposals) {
      if (!openSet.has(terminal)) this.pendingDisposals.delete(terminal);
    }
    const retained: ManagedTerminal[] = [];

    for (const managed of this.terminals) {
      const terminal = managed.terminal as vscode.Terminal | undefined;
      if (!terminal || openSet.has(terminal)) {
        retained.push(managed);
      } else {
        this.stopTrackingManagedTerminal(managed);
      }
    }

    this.terminals = retained;
    this.adoptExistingAgentLinkTerminals(openTerminals);
  }

  /** Wait until the terminal's reuse cooldown has elapsed. */
  private async waitForCooldown(managed: ManagedTerminal): Promise<void> {
    const remaining =
      TerminalManager.REUSE_COOLDOWN_MS -
      (Date.now() - managed.lastCommandEndedAt);
    if (remaining > 0) {
      this.log?.(
        `[cooldown] waiting ${remaining}ms for terminal ${managed.id} to be ready`,
      );
      await new Promise((r) => setTimeout(r, remaining));
    }
  }

  /** Record a startup latency sample and log the rolling stats. */
  private recordStartupLatency(latencyMs: number): void {
    // Skip extreme outliers (from cancelled/stuck commands with stale listeners)
    if (latencyMs > 30_000) return;
    this.startupLatencies.push(latencyMs);
    if (this.startupLatencies.length > TerminalManager.MAX_LATENCY_SAMPLES) {
      this.startupLatencies.shift();
    }
    const sorted = [...this.startupLatencies].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    this.log?.(
      `[startup-latency] sample=${latencyMs}ms n=${sorted.length} ` +
        `min=${min}ms median=${median}ms p95=${p95}ms max=${max}ms`,
    );
  }

  constructor() {
    this.adoptExistingAgentLinkTerminals();

    // Clean up terminals that get closed
    this.disposables.push(
      vscode.window.onDidCloseTerminal((closedTerminal) => {
        if (!this.getOpenVscodeTerminals()?.includes(closedTerminal)) {
          this.pendingDisposals.delete(closedTerminal);
        }
        const closing = this.terminals.filter(
          (t) => t.terminal === closedTerminal,
        );
        for (const managed of closing) {
          this.stopTrackingManagedTerminal(managed);
        }
        this.terminals = this.terminals.filter(
          (t) => t.terminal !== closedTerminal,
        );
      }),
    );
  }

  async executeCommand(options: ExecuteOptions): Promise<CommandResult> {
    // Escape ! characters only for shells that perform history expansion.
    // On Windows this primarily means Git Bash/zsh; native PowerShell/cmd
    // treat `\!` literally and should not be rewritten.
    const command = shouldEscapeHistoryExpansion(
      process.platform,
      vscode.env?.shell,
    )
      ? escapeHistoryExpansion(options.command)
      : options.command;

    const managed = await this.resolveTerminal(options);

    let resolveDetach!: () => void;
    const detachPromise = new Promise<void>((resolve) => {
      resolveDetach = resolve;
    });
    const detachForeground = () => resolveDetach();
    if (!options.background) {
      managed.detachForeground = detachForeground;
    }
    options.onTerminalAssigned?.(managed.id);

    try {
      // Show the terminal so the user can see it
      managed.terminal.show(true); // preserveFocus = true

      // Wait for shell integration, unless the user asks to continue in the
      // background first. In that case start immediately using the best mode
      // currently available instead of keeping the agent blocked.
      const shellReadinessController = new AbortController();
      const readiness = await Promise.race([
        this.waitForShellIntegration(
          managed.terminal,
          shellReadinessController.signal,
        ).then(
          (hasShellIntegration) =>
            ({ kind: "ready", hasShellIntegration }) as const,
        ),
        ...(!options.background
          ? [detachPromise.then(() => ({ kind: "detach" }) as const)]
          : []),
      ]);

      if (readiness.kind === "detach") {
        shellReadinessController.abort();
        this.deferCommandFinalization(managed, options);
        const result = this.executeBackground(
          managed,
          command,
          !!managed.terminal.shellIntegration,
        );
        return { ...result, backgrounded: true, is_running: true };
      }

      if (options.background) {
        this.deferCommandFinalization(managed, options);
        return this.executeBackground(
          managed,
          command,
          readiness.hasShellIntegration,
        );
      }

      if (readiness.hasShellIntegration) {
        return await this.executeWithShellIntegration(
          managed,
          command,
          options.timeout,
          detachPromise,
          detachForeground,
          options,
        );
      } else {
        this.deferCommandFinalization(managed, options);
        return this.executeWithSendText(managed, command);
      }
    } catch (error) {
      this.finalizeDeferredCommand(managed);
      throw error;
    } finally {
      if (managed.detachForeground === detachForeground) {
        managed.detachForeground = undefined;
      }
      managed.lastCommandEndedAt = Date.now();
      managed.busy = false;
      this.emitTerminalEvent("state", this.terminalMetadataEvent(managed));
    }
  }

  private async resolveTerminal(
    options: ExecuteOptions,
  ): Promise<ManagedTerminal> {
    this.syncTerminalRegistry();
    const {
      cwd,
      owner,
      terminal_id,
      terminal_name,
      terminal_creation_name,
      split_from,
    } = options;
    const envKey = this.buildEnvKey(options.env);

    // If terminal_id is specified, find that specific terminal
    if (terminal_id) {
      const targeted = this.terminals.find(
        (terminal) => terminal.id === terminal_id,
      );
      if (targeted && !sameTerminalOwnerScope(targeted.owner, owner)) {
        throw new Error(`Terminal not found: ${terminal_id}`);
      }
      const existing = targeted;
      if (existing) {
        if (existing.stale) {
          throw new Error(
            `Terminal ${terminal_id} was adopted after extension reload and needs a fresh AgentLink environment. Close it or use a new terminal.`,
          );
        }
        if (existing.envKey !== envKey) {
          throw new Error(
            `Terminal ${terminal_id} was created with a different env set. Use a different terminal_id/terminal_name or omit env to reuse.`,
          );
        }
        if (existing.busy || existing.backgroundRunning) {
          throw new Error(
            `Terminal ${terminal_id} is busy. Wait for the current command to finish or use get_terminal_output/kill for background commands.`,
          );
        }
        this.refreshOwner(existing, owner);
        existing.busy = true;
        try {
          await this.waitForCooldown(existing);
          return existing;
        } catch (err) {
          existing.busy = false;
          throw err;
        }
      }
      throw new Error(`Terminal not found: ${terminal_id}`);
    }

    // If terminal_name is specified, find or create by name
    if (terminal_name) {
      const existing = this.terminals.find(
        (terminal) =>
          terminal.name === terminal_name &&
          sameTerminalOwnerScope(terminal.owner, owner),
      );
      if (existing) {
        if (existing.stale) {
          throw new Error(
            `Terminal ${terminal_name} was adopted after extension reload and needs a fresh AgentLink environment. Close it or use a different terminal_name.`,
          );
        }
        if (existing.envKey !== envKey) {
          throw new Error(
            `Terminal ${terminal_name} was created with a different env set. Use a different terminal_name or omit env to reuse.`,
          );
        }
        if (existing.busy || existing.backgroundRunning) {
          throw new Error(
            `Terminal ${terminal_name} is busy. Wait for the current command to finish or use get_terminal_output/kill for background commands.`,
          );
        }
        this.refreshOwner(existing, owner);
        existing.busy = true;
        try {
          await this.waitForCooldown(existing);
          return existing;
        } catch (err) {
          existing.busy = false;
          throw err;
        }
      }
      // Create with the specified name, optionally split from a parent
      const managed = this.createTerminal(
        cwd,
        terminal_name,
        options.env,
        owner,
      );
      managed.busy = true;
      try {
        if (split_from) {
          await this.splitTerminalBeside(managed, split_from, owner);
        }
        return managed;
      } catch (err) {
        managed.busy = false;
        throw err;
      }
    }

    // Default: only reuse an idle unnamed terminal when its tracked cwd still
    // matches the requested cwd. If cwd differs, create a fresh terminal so the
    // command runs from the requested directory instead of inheriting stale state.
    const cwdMatch = this.terminals.find(
      (t) =>
        !t.busy &&
        !t.backgroundRunning &&
        !t.stale &&
        t.implicit === true &&
        sameTerminalOwnerScope(t.owner, owner) &&
        t.cwd === cwd &&
        t.envKey === envKey,
    );
    if (cwdMatch) {
      this.refreshOwner(cwdMatch, owner);
      cwdMatch.busy = true;
      try {
        await this.waitForCooldown(cwdMatch);
        return cwdMatch;
      } catch (err) {
        cwdMatch.busy = false;
        throw err;
      }
    }

    const managed = this.createTerminal(
      cwd,
      terminal_creation_name ?? "AgentLink",
      options.env,
      owner,
      true,
    );
    managed.busy = true;
    try {
      if (split_from) {
        await this.splitTerminalBeside(managed, split_from, owner);
      }
      return managed;
    } catch (err) {
      managed.busy = false;
      throw err;
    }
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
    owner: TerminalExecutionOwner | undefined,
  ): Promise<void> {
    const parent =
      this.terminals.find(
        (terminal) =>
          terminal.id === splitFrom &&
          sameTerminalOwnerScope(terminal.owner, owner),
      ) ??
      this.terminals.find(
        (terminal) =>
          terminal.name === splitFrom &&
          sameTerminalOwnerScope(terminal.owner, owner),
      );
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

    // Listen for the new terminal that the split command will create.
    // Split terminals inherit the parent shell environment, so this path must
    // only be used with AgentLink-managed parent terminals that were created
    // with buildAgentExecutionEnv().
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

  private createTerminal(
    cwd: string,
    name: string,
    extraEnv: Record<string, string> | undefined,
    owner: TerminalExecutionOwner | undefined,
    implicit = false,
  ): ManagedTerminal {
    const terminal = vscode.window.createTerminal({
      name,
      cwd,
      iconPath: terminalIconPath ?? new vscode.ThemeIcon("terminal"),
      env: buildAgentExecutionEnv({ extraEnv }),
    });

    const id = `term_${nextTerminalId++}`;
    const managed: ManagedTerminal = {
      id,
      terminal,
      name,
      cwd,
      ...(owner ? { owner: Object.freeze({ ...owner }) } : {}),
      envKey: this.buildEnvKey(extraEnv),
      implicit,
      busy: false,
      lastCommandEndedAt: 0,
      outputBuffer: "",
      backgroundRunning: false,
      backgroundExitCode: null,
      backgroundOutputCaptured: false,
      backgroundState: "completed",
      backgroundDisposables: [],
    };
    this.terminals.push(managed);
    this.emitTerminalEvent("open", this.terminalMetadataEvent(managed));
    return managed;
  }

  private async waitForShellIntegration(
    terminal: vscode.Terminal,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (terminal.shellIntegration) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      let resolved = false;
      const done = (result: boolean) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        clearInterval(poll);
        disposable.dispose();
        signal?.removeEventListener("abort", onAbort);
        if (!result) {
          this.log?.(
            `[waitForShellIntegration] TIMEOUT after ${SHELL_INTEGRATION_TIMEOUT}ms`,
          );
        }
        resolve(result);
      };

      const timeout = setTimeout(() => done(false), SHELL_INTEGRATION_TIMEOUT);

      // Primary: VS Code event fires when shell integration activates
      const disposable = vscode.window.onDidChangeTerminalShellIntegration(
        (e) => {
          if (e.terminal === terminal) {
            done(true);
          }
        },
      );

      // Fallback: poll the property in case the event is missed
      const poll = setInterval(() => {
        if (terminal.shellIntegration) {
          done(true);
        }
      }, 200);
      const onAbort = () => done(false);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async executeWithShellIntegration(
    managed: ManagedTerminal,
    command: string,
    timeout: number | undefined,
    detachPromise: Promise<void>,
    detachForeground: () => void,
    options: ExecuteOptions,
  ): Promise<CommandResult> {
    const terminal = managed.terminal;
    const shellIntegration = terminal.shellIntegration!;
    let timedOut = false;
    let detached = false;
    const disposables: vscode.Disposable[] = [];

    // Reset the output buffer for this execution
    managed.outputBuffer = "";

    // --- Diagnostic state tracking ---
    const execTag = `${managed.id}:${Date.now()}`;
    const startTime = Date.now();
    const diag = {
      startEventFired: false,
      endEventFired: false,
      terminalClosed: false,
      streamChunks: 0,
      streamBytes: 0,
      streamDone: false,
      markerInStream: false,
      markerByPoll: false,
      raceResolved: false,
      raceWinner: "",
      lastActivityAt: startTime,
    };

    const logDiag = (event: string) => {
      const elapsed = Date.now() - startTime;
      this.log?.(
        `[exec:${execTag}] ${event} (+${elapsed}ms) | ` +
          `start=${diag.startEventFired} end=${diag.endEventFired} closed=${diag.terminalClosed} ` +
          `chunks=${diag.streamChunks} bytes=${diag.streamBytes} ` +
          `stream_done=${diag.streamDone} ` +
          `marker_stream=${diag.markerInStream} marker_poll=${diag.markerByPoll} ` +
          `buf=${managed.outputBuffer.length} race=${diag.raceResolved}` +
          (diag.raceWinner ? ` winner=${diag.raceWinner}` : ""),
      );
      diag.lastActivityAt = Date.now();
    };

    logDiag(`EXEC_START cmd="${command.slice(0, 120)}"`);

    // --- Stall detector ---
    // Periodically logs complete state when no progress has been made.
    // Does NOT cancel or resolve anything — purely diagnostic.
    const STALL_CHECK_MS = 10_000;
    const stallCheck = setInterval(() => {
      if (diag.raceResolved) return;
      const sinceActivity = Date.now() - diag.lastActivityAt;
      if (sinceActivity >= STALL_CHECK_MS) {
        const elapsed = Date.now() - startTime;
        const latencyStats =
          this.startupLatencies.length > 0
            ? `samples=${this.startupLatencies.length} last=${this.startupLatencies[this.startupLatencies.length - 1]}ms`
            : "no_samples";
        this.log?.(
          `[exec:${execTag}] STALL_WARNING no activity for ${sinceActivity}ms (total ${elapsed}ms) | ` +
            `start=${diag.startEventFired} end=${diag.endEventFired} closed=${diag.terminalClosed} ` +
            `chunks=${diag.streamChunks} bytes=${diag.streamBytes} ` +
            `stream_done=${diag.streamDone} ` +
            `marker_stream=${diag.markerInStream} marker_poll=${diag.markerByPoll} ` +
            `buf=${managed.outputBuffer.length} ` +
            `shellIntegration=${!!terminal.shellIntegration} ` +
            `timeout=${timeout ?? "none"} ` +
            `startup_latency={${latencyStats}} ` +
            `cmd="${command.slice(0, 120)}"`,
        );
      }
    }, STALL_CHECK_MS);
    disposables.push({ dispose: () => clearInterval(stallCheck) });

    // --- Primary: shell integration events ---
    let execution: vscode.TerminalShellExecution | undefined;
    const exitCodePromise = new Promise<number | undefined>((resolve) => {
      disposables.push(
        vscode.window.onDidEndTerminalShellExecution((e) => {
          if (execution && e.execution === execution) {
            diag.endEventFired = true;
            logDiag(`END_EVENT exitCode=${e.exitCode}`);
            resolve(e.exitCode);
          }
        }),
      );

      // Terminal closed while command is running — exit event will never fire
      disposables.push(
        vscode.window.onDidCloseTerminal((t) => {
          if (t === terminal) {
            diag.terminalClosed = true;
            logDiag("TERMINAL_CLOSED");
            resolve(undefined);
          }
        }),
      );

      // Always listen for the start event (for diagnostics), and set up
      // timeout only when configured. Defers timeout until the shell
      // actually starts executing the command, so terminal startup /
      // shell queue delays don't eat into the user-specified timeout.
      disposables.push(
        vscode.window.onDidStartTerminalShellExecution((e) => {
          if (execution && e.execution === execution) {
            diag.startEventFired = true;
            this.recordStartupLatency(Date.now() - executeCalledAt);
            logDiag("START_EVENT");

            if (timeout !== undefined) {
              // Clear the catch-all — the precise deferred timer takes over
              if (catchAllTimer) {
                clearTimeout(catchAllTimer);
                catchAllTimer = undefined;
              }
              const timer = setTimeout(() => {
                timedOut = true;
                logDiag("TIMEOUT_FIRED");
                resolve(undefined);
              }, timeout);
              disposables.push({ dispose: () => clearTimeout(timer) });
            }
          }
        }),
      );

      // Catch-all timeout: prevent infinite hang if the start event
      // never fires (shell integration race on rapid terminal reuse).
      // Only active when the user specified a timeout — they explicitly
      // want a time limit. Uses timeout + startup grace so the deferred
      // timer still gets priority in the normal case.
      let catchAllTimer: ReturnType<typeof setTimeout> | undefined;
      if (timeout !== undefined) {
        const STARTUP_GRACE_MS = 15_000;
        catchAllTimer = setTimeout(() => {
          if (!diag.raceResolved) {
            timedOut = true;
            logDiag("CATCH_ALL_TIMEOUT");
            resolve(undefined);
          }
        }, timeout + STARTUP_GRACE_MS);
        disposables.push({
          dispose: () => {
            if (catchAllTimer) clearTimeout(catchAllTimer);
          },
        });
      }
    });

    // Execute the command — record timestamp so we can measure startup latency
    const executeCalledAt = Date.now();
    const commandId = `${managed.id}:${executeCalledAt}`;
    logDiag("CALLING_EXECUTE_COMMAND");
    execution = shellIntegration.executeCommand(command);
    this.emitTerminalEvent("commandStart", {
      terminalId: managed.id,
      commandId,
      command,
      timestamp: executeCalledAt,
      captureLevel: "full-agent-managed",
    });
    logDiag("EXECUTE_COMMAND_RETURNED");

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
    let markerExitCode: number | undefined;
    const streamMarkerPromise = new Promise<number | undefined>((resolve) => {
      resolveStreamMarker = (code) => {
        if (streamMarkerResolved) return;
        streamMarkerResolved = true;
        resolve(code);
      };
    });

    // Track how far we've scanned so we don't re-check old data
    let lastMarkerCheckPos = 0;

    const checkForMarker = (source: "stream" | "poll"): boolean => {
      const result = findAndStripTerminalMarker(
        managed.outputBuffer,
        lastMarkerCheckPos,
      );
      if (result) {
        if (source === "stream") {
          diag.markerInStream = true;
        } else {
          diag.markerByPoll = true;
        }
        managed.outputBuffer = result.stripped;
        logDiag(
          `MARKER_FOUND source=${source} marker=${result.source} exitCode=${result.exitCode ?? "none"}`,
        );
        markerExitCode = result.exitCode ?? undefined;
        resolveStreamMarker!(markerExitCode);
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
        checkForMarker("poll");
      }
    }, MARKER_POLL_MS);

    const streamDone = (async () => {
      for await (const data of stream) {
        diag.streamChunks++;
        diag.streamBytes += data.length;
        if (diag.streamChunks === 1) {
          logDiag(`STREAM_FIRST_DATA len=${data.length}`);
        }
        diag.lastActivityAt = Date.now();
        managed.outputBuffer += data;
        this.emitTerminalEvent("data", {
          terminalId: managed.id,
          commandId,
          text: data,
          timestamp: diag.lastActivityAt,
        });
        if (!detached && checkForMarker("stream")) break;
      }
      diag.streamDone = true;
      logDiag("STREAM_COMPLETED");
    })();

    const raceResult = await Promise.race([
      streamDone.then(() => ({ kind: "stream" }) as const),
      exitCodePromise.then((exitCode) => ({ kind: "exit", exitCode }) as const),
      streamMarkerPromise.then(
        (exitCode) => ({ kind: "marker", exitCode }) as const,
      ),
      detachPromise.then(() => ({ kind: "detach" }) as const),
    ]);

    if (raceResult.kind === "detach") {
      detached = true;
      diag.raceResolved = true;
      diag.raceWinner = "detach";
      logDiag("RACE_RESOLVED");
      this.deferCommandFinalization(managed, options);
      this.transitionToBackground(managed, commandId, execution, "detached");
      clearInterval(markerPoll);
      for (const d of disposables) d.dispose();

      const actualCwd = shellIntegration.cwd?.fsPath;
      if (actualCwd) {
        managed.cwd = actualCwd;
      }
      const output = cleanTerminalOutput(managed.outputBuffer);
      const rawOutput = cleanTerminalRawOutput(managed.outputBuffer);
      const message = `Command continues in the background. Use get_terminal_output with terminal_id "${managed.id}" to check on progress.`;
      return {
        exit_code: null,
        output: output ? `${output}\n[${message}]` : `[${message}]`,
        ...(rawOutput && { terminal_raw_output: rawOutput }),
        ...(actualCwd && { cwd: actualCwd }),
        output_captured: true,
        terminal_id: managed.id,
        terminal_name: managed.name,
        execution_mode: "shell_integration",
        command_sent: true,
        backgrounded: true,
        is_running: true,
      };
    }

    if (managed.detachForeground === detachForeground) {
      managed.detachForeground = undefined;
    }

    // If the race resolved but we have no output yet, the stream may
    // still be delivering data (observed when exit event fires ~100ms
    // before stream data arrives on rapidly-reused terminals). Wait
    // briefly for it rather than returning empty output.
    if (managed.outputBuffer.length === 0 && !diag.streamDone) {
      const OUTPUT_GRACE_MS = 300;
      logDiag(`OUTPUT_GRACE waiting ${OUTPUT_GRACE_MS}ms for stream data`);
      await Promise.race([
        streamDone,
        new Promise((r) => setTimeout(r, OUTPUT_GRACE_MS)),
      ]);
    }

    diag.raceResolved = true;
    // Determine which promise won the race
    if (diag.streamDone) diag.raceWinner = "stream";
    else if (diag.endEventFired || diag.terminalClosed || timedOut)
      diag.raceWinner = diag.endEventFired
        ? "exitEvent"
        : diag.terminalClosed
          ? "terminalClosed"
          : "timeout";
    else if (diag.markerInStream || diag.markerByPoll)
      diag.raceWinner = "marker";
    else diag.raceWinner = "unknown";
    logDiag("RACE_RESOLVED");

    clearInterval(markerPoll);

    // Strip any remaining completion marker from output (safety net)
    const leftover = findAndStripTerminalMarker(managed.outputBuffer, 0);
    if (leftover) {
      managed.outputBuffer = leftover.stripped;
    }

    const rawOutput = cleanTerminalRawOutput(managed.outputBuffer);
    const cleanOutput = cleanTerminalOutput(managed.outputBuffer);

    // Bounded wait for exit code: if the promise hasn't resolved yet (e.g.
    // stream finished but exit event is delayed), give it a short grace
    // period rather than blocking forever.
    const EXIT_CODE_GRACE_MS = 5_000;
    const exitCode =
      markerExitCode ??
      (await Promise.race([
        exitCodePromise,
        streamMarkerPromise.then((code) =>
          code !== undefined
            ? code
            : Promise.race([
                exitCodePromise,
                new Promise<undefined>((resolve) =>
                  setTimeout(resolve, UNKNOWN_MARKER_EXIT_GRACE_MS),
                ),
              ]),
        ),
        new Promise<undefined>((r) =>
          setTimeout(() => r(undefined), EXIT_CODE_GRACE_MS),
        ),
      ]));

    logDiag(`EXIT_CODE=${exitCode ?? "null"}`);
    if (!timedOut) {
      this.emitTerminalEvent("commandEnd", {
        terminalId: managed.id,
        commandId,
        timestamp: Date.now(),
        exitCode: exitCode ?? null,
      });
    }

    // Clean up all listeners
    for (const d of disposables) d.dispose();

    // Read the terminal's actual cwd after execution (reflects cd, etc.)
    const actualCwd = shellIntegration.cwd?.fsPath;
    if (actualCwd) {
      managed.cwd = actualCwd;
    }

    managed.backgroundExitCode = exitCode ?? null;
    managed.backgroundOutputCaptured = true;
    managed.backgroundState =
      timedOut || exitCode === undefined ? "unknown_termination" : "completed";

    const result: CommandResult = {
      exit_code: managed.backgroundExitCode,
      output: cleanOutput,
      ...(rawOutput && { terminal_raw_output: rawOutput }),
      ...(actualCwd && { cwd: actualCwd }),
      output_captured: true,
      terminal_id: managed.id,
      terminal_name: managed.name,
      execution_mode: "shell_integration",
      command_sent: true,
    };

    if (timedOut) {
      this.deferCommandFinalization(managed, options);
      this.transitionToBackground(managed, commandId, execution, "timed_out");
      result.timed_out = true;
      const timeoutMessage = `[Timed out after ${timeout! / 1000}s — command may still be running. Use get_terminal_output with terminal_id "${managed.id}" to check on progress, or add kill: true to stop it.]`;
      result.output += `\n${timeoutMessage}`;
      if (result.terminal_raw_output !== undefined) {
        result.terminal_raw_output += `\r\n${timeoutMessage}`;
      }
    }

    logDiag("RETURNING_RESULT");
    return result;
  }

  private executeWithSendText(
    managed: ManagedTerminal,
    command: string,
  ): CommandResult {
    // Without shell integration we cannot tell when a foreground command ends,
    // so treat the terminal as background-running to prevent immediate reuse by
    // another execute_command call on the same managed terminal.
    this.disposeBackgroundTracking(managed);
    managed.outputBuffer = "";
    managed.backgroundRunning = true;
    managed.backgroundOutputCaptured = false;
    managed.backgroundExitCode = null;
    managed.backgroundState = "detached";
    const timestamp = Date.now();
    const commandId = `${managed.id}:${timestamp}`;

    const finalize = () => {
      this.finishBackgroundCommand(managed, commandId);
    };

    const exitDisposable = vscode.window.onDidEndTerminalShellExecution((e) => {
      if (e.terminal === managed.terminal) {
        managed.backgroundExitCode = e.exitCode ?? null;
        finalize();
      }
    });

    const closeDisposable = vscode.window.onDidCloseTerminal((t) => {
      if (t === managed.terminal) {
        finalize();
      }
    });

    managed.backgroundDisposables.push(exitDisposable, closeDisposable);
    this.emitTerminalEvent("commandStart", {
      terminalId: managed.id,
      commandId,
      command,
      timestamp,
      captureLevel: "command-sent-only",
    });
    managed.terminal.sendText(command, true);

    return {
      exit_code: null,
      output:
        "Command was sent to the terminal, but output capture is unavailable because shell integration is not active.",
      output_captured: false,
      terminal_id: managed.id,
      terminal_name: managed.name,
      execution_mode: "send_text",
      command_sent: true,
      verification_hint:
        `The command may still be running or may have already finished in terminal_id "${managed.id}". ` +
        "Do not re-run it just to verify. Inspect the visible terminal, or use get_terminal_output/kill with this terminal_id. The terminal stays reserved until it is explicitly interrupted, shell integration later reports completion, or the terminal is closed.",
    };
  }

  /**
   * Transition a foreground command that timed out into background state,
   * so get_terminal_output can retrieve its output and detect completion.
   * The stream async generator from executeWithShellIntegration continues
   * pumping data into managed.outputBuffer independently.
   */
  private transitionToBackground(
    managed: ManagedTerminal,
    commandId: string,
    execution: vscode.TerminalShellExecution,
    state: "detached" | "timed_out",
  ): void {
    // Clean up any stale background state
    this.disposeBackgroundTracking(managed);

    managed.backgroundRunning = true;
    managed.backgroundOutputCaptured = true;
    managed.backgroundExitCode = null;
    managed.backgroundState = state;

    const execTag = `timeout-bg:${managed.id}:${Date.now()}`;
    const logBg = (event: string) => {
      this.log?.(
        `[${execTag}] ${event} | running=${managed.backgroundRunning} buf=${managed.outputBuffer.length}`,
      );
    };

    logBg("TRANSITION_TO_BACKGROUND");

    // Helper to finalize background state
    const finalize = (source: string) => {
      if (!managed.backgroundRunning) return;
      this.finishBackgroundCommand(managed, commandId, {
        normalizeOutput: true,
      });
      logBg(
        `FINALIZED source=${source} exit_code=${managed.backgroundExitCode}`,
      );
    };
    let unknownMarkerTimer: ReturnType<typeof setTimeout> | undefined;
    const deferUnknownMarkerCompletion = () => {
      if (unknownMarkerTimer) return;
      unknownMarkerTimer = setTimeout(() => {
        unknownMarkerTimer = undefined;
        finalize("unknownMarkerGraceExpired");
      }, UNKNOWN_MARKER_EXIT_GRACE_MS);
      managed.backgroundDisposables.push({
        dispose: () => {
          if (unknownMarkerTimer) clearTimeout(unknownMarkerTimer);
          unknownMarkerTimer = undefined;
        },
      });
    };

    const completionListeners = registerTerminalCompletionListeners({
      terminal: managed.terminal,
      getExecution: () => execution,
      subscribeEnd: (listener) =>
        vscode.window.onDidEndTerminalShellExecution(listener),
      subscribeClose: (listener) => vscode.window.onDidCloseTerminal(listener),
      onEnd: (exitCode) => {
        logBg(`END_EVENT exitCode=${exitCode}`);
        managed.backgroundExitCode = exitCode ?? null;
        finalize("exitEvent");
      },
      onClose: () => {
        logBg("TERMINAL_CLOSED");
        finalize("terminalClosed");
      },
    });
    const markerTracker = createTerminalMarkerTracker({
      getBuffer: () => managed.outputBuffer,
      setBuffer: (buffer) => {
        managed.outputBuffer = buffer;
      },
      isActive: () => managed.backgroundRunning,
      onMarker: (marker) => {
        logBg(
          `MARKER_FOUND marker=${marker.source} exitCode=${marker.exitCode ?? "none"}`,
        );
        if (marker.exitCode === null) {
          deferUnknownMarkerCompletion();
        } else {
          managed.backgroundExitCode = marker.exitCode;
          finalize("marker");
        }
      },
    });
    managed.backgroundDisposables.push(...completionListeners, markerTracker);
  }

  private executeBackground(
    managed: ManagedTerminal,
    command: string,
    _hasShellIntegration: boolean,
  ): CommandResult {
    // Clean up any previous background state
    this.disposeBackgroundTracking(managed);
    managed.backgroundRunning = true;
    managed.backgroundExitCode = null;
    managed.backgroundState = "detached";
    managed.outputBuffer = "";

    const execTag = `bg:${managed.id}:${Date.now()}`;
    const commandId = execTag;
    const startTime = Date.now();
    const logBg = (event: string) => {
      const elapsed = Date.now() - startTime;
      this.log?.(
        `[${execTag}] ${event} (+${elapsed}ms) | ` +
          `running=${managed.backgroundRunning} captured=${managed.backgroundOutputCaptured} ` +
          `buf=${managed.outputBuffer.length}`,
      );
    };

    // Helper to clean up background state and dispose listeners
    const finalize = (source: string) => {
      if (!managed.backgroundRunning) return;
      this.finishBackgroundCommand(managed, execTag, {
        normalizeOutput: true,
      });
      logBg(
        `FINALIZED source=${source} exit_code=${managed.backgroundExitCode}`,
      );
    };
    let unknownMarkerTimer: ReturnType<typeof setTimeout> | undefined;
    const deferUnknownMarkerCompletion = () => {
      if (unknownMarkerTimer) return;
      unknownMarkerTimer = setTimeout(() => {
        unknownMarkerTimer = undefined;
        finalize("unknownMarkerGraceExpired");
      }, UNKNOWN_MARKER_EXIT_GRACE_MS);
      managed.backgroundDisposables.push({
        dispose: () => {
          if (unknownMarkerTimer) clearTimeout(unknownMarkerTimer);
          unknownMarkerTimer = undefined;
        },
      });
    };

    // --- Register listeners BEFORE executing (prevents race for fast commands) ---

    const shellIntegration = managed.terminal.shellIntegration;
    let execution: vscode.TerminalShellExecution | undefined;

    const completionListeners = registerTerminalCompletionListeners({
      terminal: managed.terminal,
      getExecution: () => execution,
      allowTerminalFallback: !shellIntegration,
      subscribeEnd: (listener) =>
        vscode.window.onDidEndTerminalShellExecution(listener),
      subscribeClose: (listener) => vscode.window.onDidCloseTerminal(listener),
      onEnd: (exitCode) => {
        logBg(`END_EVENT exitCode=${exitCode}`);
        managed.backgroundExitCode = exitCode ?? null;
        // If we used sendText but shell integration picked up the execution,
        // retroactively mark output as captured since the stream may have data
        if (
          !managed.backgroundOutputCaptured &&
          managed.outputBuffer.length > 0
        ) {
          managed.backgroundOutputCaptured = true;
        }
        finalize("exitEvent");
      },
      onClose: () => {
        logBg("TERMINAL_CLOSED");
        finalize("terminalClosed");
      },
    });
    const markerTracker = createTerminalMarkerTracker({
      getBuffer: () => managed.outputBuffer,
      setBuffer: (buffer) => {
        managed.outputBuffer = buffer;
      },
      isActive: () => managed.backgroundRunning,
      onMarker: (marker) => {
        logBg(
          `MARKER_FOUND marker=${marker.source} exitCode=${marker.exitCode ?? "none"}`,
        );
        if (marker.exitCode === null) {
          deferUnknownMarkerCompletion();
        } else {
          managed.backgroundExitCode = marker.exitCode;
          finalize("marker");
        }
      },
    });
    managed.backgroundDisposables.push(...completionListeners, markerTracker);

    if (shellIntegration) {
      managed.backgroundOutputCaptured = true;
      logBg(`EXEC_START cmd="${command.slice(0, 120)}" mode=shellIntegration`);

      execution = shellIntegration.executeCommand(command);
      this.emitTerminalEvent("commandStart", {
        terminalId: managed.id,
        commandId,
        command,
        timestamp: startTime,
        captureLevel: "full-agent-managed",
      });
      const stream = execution.read();

      // Read stream asynchronously — don't await, let it run in background
      const streamDone = (async () => {
        let chunks = 0;
        for await (const data of stream) {
          chunks++;
          if (chunks === 1) logBg(`STREAM_FIRST_DATA len=${data.length}`);
          managed.outputBuffer += data;
          this.emitTerminalEvent("data", {
            terminalId: managed.id,
            commandId,
            text: data,
            timestamp: Date.now(),
          });
          if (markerTracker.check()) break;
        }
        logBg(`STREAM_DONE chunks=${chunks}`);
      })();

      // Catch stream errors (terminal may close mid-read)
      streamDone.catch((err) => {
        logBg(`STREAM_ERROR ${err?.message ?? err}`);
        finalize("streamError");
      });
    } else {
      // sendText fallback — shell integration not available
      managed.backgroundOutputCaptured = false;
      logBg(`EXEC_START cmd="${command.slice(0, 120)}" mode=sendText`);
      this.emitTerminalEvent("commandStart", {
        terminalId: managed.id,
        commandId,
        command,
        timestamp: startTime,
        captureLevel: "command-sent-only",
      });
      managed.terminal.sendText(command, true);
      // Note: exit/close listeners are already registered above.
      // If shell integration activates after sendText, the exit listener
      // will still fire and finalize the state properly.
    }

    return {
      exit_code: null,
      output: `Background command started in terminal "${managed.name}". Use terminal_id "${managed.id}" with get_terminal_output to check on progress.`,
      output_captured: false,
      terminal_id: managed.id,
      terminal_name: managed.name,
      execution_mode: shellIntegration ? "shell_integration" : "send_text",
      command_sent: true,
      ...(shellIntegration
        ? {}
        : {
            verification_hint:
              `Background command was started in terminal_id "${managed.id}", but shell integration was not active so live output capture is unavailable. ` +
              "Use the visible terminal to verify progress rather than re-running the command.",
          }),
    };
  }

  /**
   * Close managed terminals. Returns the count of terminals closed.
   * If names are specified, only closes terminals with matching names.
   * Otherwise closes all managed terminals.
   * Returns the count of closed terminals and any names that weren't found.
   */
  closeTerminals(request: TerminalCloseRequest): {
    closed: number;
    not_found?: string[];
  } {
    const { owner, names } = request;
    const owned = this.terminals.filter((terminal) =>
      this.matchesOwner(terminal.owner, owner),
    );
    const toClose = names
      ? owned.filter(
          (terminal) =>
            names.includes(terminal.id) || names.includes(terminal.name),
        )
      : owned;

    const closedIds = new Set(toClose.map((t) => t.id));
    this.terminals = this.terminals.filter((t) => !closedIds.has(t.id));
    for (const managed of toClose) {
      this.pendingDisposals.add(managed.terminal);
      if (managed.backgroundRunning) {
        managed.backgroundRunning = false;
        managed.backgroundState = "unknown_termination";
      }
      this.rememberClosedTerminal(managed);
      managed.terminal.dispose();
      this.disposeBackgroundTracking(managed);
      this.finalizeDeferredCommand(managed);
    }

    // Report any requested names that weren't found
    const closedTargets = new Set(
      toClose.flatMap((terminal) => [terminal.id, terminal.name]),
    );
    const notFound = names?.filter((name) => !closedTargets.has(name));

    return {
      closed: toClose.length,
      ...(notFound && notFound.length > 0 && { not_found: notFound }),
    };
  }

  /**
   * Get accumulated output from a busy or background terminal.
   * Returns undefined if the terminal is not found.
   */
  getCurrentOutput(request: TerminalOutputRequest): string | undefined {
    const managed = this.findOwnedTerminal(request.terminalId, request.owner);
    if (!managed) return undefined;
    if (
      !request.force &&
      !managed.busy &&
      !managed.backgroundRunning &&
      !managed.backgroundOutputCaptured
    )
      return undefined;
    return cleanTerminalOutput(managed.outputBuffer);
  }

  /** Reveal and focus a managed terminal by ID. */
  revealTerminal(request: TerminalTargetRequest): boolean {
    const managed = this.findOwnedTerminal(request.terminalId, request.owner);
    if (!managed) return false;
    managed.terminal.show(false);
    return true;
  }

  /**
   * Get the background execution state of a terminal.
   * Returns undefined if the terminal is not found.
   */
  getBackgroundState(
    request: TerminalTargetRequest,
  ): TerminalBackgroundState | undefined {
    const managed = this.findOwnedTerminal(request.terminalId, request.owner);
    if (managed) {
      return {
        is_running: managed.backgroundRunning,
        state: managed.backgroundRunning
          ? (managed.backgroundState ?? "running")
          : managed.backgroundExitCode !== null
            ? "completed"
            : (managed.backgroundState ?? "unknown_termination"),
        exit_code: managed.backgroundExitCode,
        output: cleanTerminalOutput(managed.outputBuffer),
        output_captured: managed.backgroundOutputCaptured,
        ...(managed.backgroundOutputCaptured && {
          terminal_raw_output: cleanTerminalRawOutput(managed.outputBuffer),
        }),
      };
    }
    const closed = this.recentlyClosed.find(
      (snapshot) =>
        snapshot.id === request.terminalId &&
        this.matchesOwner(snapshot.owner, request.owner),
    );
    return closed ? { ...closed } : undefined;
  }

  /**
   * Stop waiting for a foreground command while leaving it running and tracked.
   * Returns false when the terminal has no detachable foreground execution.
   */
  detachTerminal(request: TerminalTargetRequest): boolean {
    const managed = this.findOwnedTerminal(request.terminalId, request.owner);
    if (!managed?.detachForeground) return false;
    const detach = managed.detachForeground;
    managed.detachForeground = undefined;
    detach();
    return true;
  }

  /**
   * Send Ctrl+C (SIGINT) to a managed terminal to interrupt the running process.
   * Returns true if the terminal was found and interrupted.
   */
  interruptTerminal(request: TerminalTargetRequest): boolean {
    const managed = this.findOwnedTerminal(request.terminalId, request.owner);
    if (!managed) return false;
    managed.terminal.sendText("\x03", false);
    if (managed.backgroundRunning && !managed.backgroundOutputCaptured) {
      managed.backgroundRunning = false;
      managed.backgroundState = "unknown_termination";
      managed.lastCommandEndedAt = Date.now();
      this.disposeBackgroundTracking(managed);
      this.finalizeDeferredCommand(managed);
    }
    return true;
  }

  /**
   * List all managed terminals with their current state.
   */
  listTerminals(request: TerminalListRequest): Array<{
    id: string;
    name: string;
    busy: boolean;
    stale?: boolean;
    owner?: TerminalExecutionOwner;
  }> {
    this.syncTerminalRegistry();

    return this.terminals
      .filter((terminal) => this.matchesOwner(terminal.owner, request.owner))
      .map((terminal) => ({
        id: terminal.id,
        name: terminal.name,
        busy: terminal.busy || terminal.backgroundRunning,
        ...(terminal.stale && { stale: true }),
        ...(terminal.owner ? { owner: { ...terminal.owner } } : {}),
      }));
  }

  getRecentlyClosedTerminals(
    request: TerminalRecentlyClosedRequest,
  ): ClosedTerminalSnapshot[] {
    const limit = request.limit ?? 5;
    return this.recentlyClosed
      .filter((terminal) => this.matchesOwner(terminal.owner, request.owner))
      .slice(0, Math.max(0, limit));
  }

  private rememberClosedTerminal(managed: ManagedTerminal): void {
    const bound = (value: string): string =>
      value.slice(-TerminalManager.MAX_CLOSED_OUTPUT_CHARS);
    const outputCaptured = managed.backgroundOutputCaptured;
    const exitCode = managed.backgroundExitCode;
    this.recentlyClosed = this.recentlyClosed.filter(
      (snapshot) => snapshot.id !== managed.id,
    );
    this.recentlyClosed.unshift({
      id: managed.id,
      name: managed.name,
      closedAt: Date.now(),
      ...(managed.owner ? { owner: { ...managed.owner } } : {}),
      is_running: false,
      state:
        exitCode !== null
          ? "completed"
          : (managed.backgroundState ?? "unknown_termination"),
      exit_code: exitCode,
      output: outputCaptured
        ? bound(cleanTerminalOutput(managed.outputBuffer))
        : "",
      output_captured: outputCaptured,
      ...(outputCaptured && {
        terminal_raw_output: bound(
          cleanTerminalRawOutput(managed.outputBuffer),
        ),
      }),
    });
    if (this.recentlyClosed.length > TerminalManager.MAX_RECENTLY_CLOSED) {
      this.recentlyClosed = this.recentlyClosed.slice(
        0,
        TerminalManager.MAX_RECENTLY_CLOSED,
      );
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.pendingDisposals.clear();
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
