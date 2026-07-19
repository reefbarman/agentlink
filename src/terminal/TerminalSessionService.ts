import { Buffer } from "node:buffer";

import {
  isValidTerminalDimensions,
  type HostTerminalEvent,
  type HostTerminalTab,
  type TerminalDimensions,
} from "../core/terminalProtocol.js";
import type { ResolvedHostShellProfile } from "./shellProfileResolver.js";

const DEFAULT_MAX_OUTPUT_BUFFER_BYTES = 1024 * 1024;

export interface HostPtyDisposable {
  dispose(): void;
}

export interface HostPtyExitEvent {
  exitCode: number;
  signal?: number;
}

export interface HostPty {
  /** The factory must preserve UTF-8 characters split across native read chunks. */
  onData(listener: (data: string) => void): HostPtyDisposable;
  onExit(listener: (event: HostPtyExitEvent) => void): HostPtyDisposable;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(): void;
  pause(): void;
  resume(): void;
}

export interface HostPtySpawnOptions {
  shellPath: string;
  shellArgs: string[];
  cwd: string;
  environment: Record<string, string>;
  dimensions: TerminalDimensions;
}

export interface HostPtyFactory {
  spawn(options: HostPtySpawnOptions): HostPty;
}

export interface HostTerminalLaunchOptions {
  requestId: string;
  title: string;
  profile: ResolvedHostShellProfile;
  dimensions: TerminalDimensions;
}

export interface HostTerminalOutputSnapshot {
  data: string;
  byteLength: number;
  droppedBytes: number;
  paused: boolean;
}

export interface TerminalSessionServiceOptions {
  ptyFactory: HostPtyFactory;
  maxOutputBufferBytes?: number;
  createTerminalId?: () => string;
  onListenerError?: (error: unknown) => void;
}

export type HostTerminalEventListener = (
  event: HostTerminalEvent,
) => boolean | void;

interface ManagedHostTerminal {
  pty: HostPty;
  tab: HostTerminalTab;
  output: string;
  outputBytes: number;
  droppedBytes: number;
  outputPaused: boolean;
  dataSubscription?: HostPtyDisposable;
  exitSubscription?: HostPtyDisposable;
}

function cloneTab(tab: HostTerminalTab): HostTerminalTab {
  return { ...tab, dimensions: { ...tab.dimensions } };
}

function retainUtf8Tail(
  current: string,
  appended: string,
  maxBytes: number,
): { data: string; byteLength: number; droppedBytes: number } {
  const previousBytes = Buffer.byteLength(current, "utf8");
  const appendedBytes = Buffer.byteLength(appended, "utf8");
  const combined = Buffer.from(current + appended, "utf8");
  if (combined.byteLength <= maxBytes) {
    return {
      data: current + appended,
      byteLength: combined.byteLength,
      droppedBytes: 0,
    };
  }

  let start = combined.byteLength - maxBytes;
  while (start < combined.byteLength && (combined[start] & 0xc0) === 0x80) {
    start += 1;
  }
  const data = combined.subarray(start).toString("utf8");
  const byteLength = Buffer.byteLength(data, "utf8");
  return {
    data,
    byteLength,
    droppedBytes: previousBytes + appendedBytes - byteLength,
  };
}

export class TerminalSessionService implements HostPtyDisposable {
  private readonly ptyFactory: HostPtyFactory;
  private readonly maxOutputBufferBytes: number;
  private readonly createTerminalId: () => string;
  private readonly onListenerError?: (error: unknown) => void;
  private readonly sessions = new Map<string, ManagedHostTerminal>();
  private readonly listeners = new Set<HostTerminalEventListener>();
  private nextTerminalNumber = 1;
  private disposed = false;

  constructor(options: TerminalSessionServiceOptions) {
    const maxOutputBufferBytes =
      options.maxOutputBufferBytes ?? DEFAULT_MAX_OUTPUT_BUFFER_BYTES;
    if (
      !Number.isSafeInteger(maxOutputBufferBytes) ||
      maxOutputBufferBytes <= 0
    ) {
      throw new Error("maxOutputBufferBytes must be a positive safe integer");
    }
    this.ptyFactory = options.ptyFactory;
    this.maxOutputBufferBytes = maxOutputBufferBytes;
    this.createTerminalId =
      options.createTerminalId ??
      (() => `host-terminal-${this.nextTerminalNumber++}`);
    this.onListenerError = options.onListenerError;
  }

  onEvent(listener: HostTerminalEventListener): HostPtyDisposable {
    this.assertActive();
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  create(options: HostTerminalLaunchOptions): HostTerminalTab {
    this.assertActive();
    if (!isValidTerminalDimensions(options.dimensions)) {
      throw new Error("Terminal dimensions must be positive integers");
    }

    const terminalId = this.createTerminalId();
    if (
      !terminalId ||
      terminalId.includes("\0") ||
      this.sessions.has(terminalId)
    ) {
      throw new Error("createTerminalId must return a unique, non-empty ID");
    }

    let pty: HostPty;
    try {
      pty = this.ptyFactory.spawn({
        shellPath: options.profile.shellPath,
        shellArgs: [...options.profile.shellArgs],
        cwd: options.profile.cwd,
        environment: { ...options.profile.environment },
        dimensions: { ...options.dimensions },
      });
    } catch (error) {
      this.emit({
        type: "host-terminal/error",
        requestId: options.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const tab: HostTerminalTab = {
      id: terminalId,
      title: options.title,
      cwd: options.profile.cwd,
      profileName: options.profile.profileName,
      dimensions: { ...options.dimensions },
      status: "running",
    };
    const managed = {
      pty,
      tab,
      output: "",
      outputBytes: 0,
      droppedBytes: 0,
      outputPaused: false,
    } as ManagedHostTerminal;
    this.sessions.set(terminalId, managed);
    try {
      managed.dataSubscription = pty.onData((data) =>
        this.handleData(managed, data),
      );
      managed.exitSubscription = pty.onExit((event) =>
        this.handleExit(managed, event),
      );
    } catch (error) {
      this.sessions.delete(terminalId);
      managed.dataSubscription?.dispose();
      try {
        pty.kill();
      } catch {
        // The registration error remains the actionable launch failure.
      }
      this.emit({
        type: "host-terminal/error",
        requestId: options.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    this.emit({ type: "host-terminal/opened", terminal: cloneTab(tab) });
    return cloneTab(tab);
  }

  getTerminal(terminalId: string): HostTerminalTab | undefined {
    const tab = this.sessions.get(terminalId)?.tab;
    return tab ? cloneTab(tab) : undefined;
  }

  getTerminals(): HostTerminalTab[] {
    return [...this.sessions.values()].map(({ tab }) => cloneTab(tab));
  }

  getOutput(terminalId: string): HostTerminalOutputSnapshot | undefined {
    const managed = this.sessions.get(terminalId);
    if (!managed) return undefined;
    return {
      data: managed.output,
      byteLength: managed.outputBytes,
      droppedBytes: managed.droppedBytes,
      paused: managed.outputPaused,
    };
  }

  write(terminalId: string, data: string): boolean {
    const managed = this.getRunning(terminalId);
    if (!managed) return false;
    managed.pty.write(data);
    return true;
  }

  resize(terminalId: string, dimensions: TerminalDimensions): boolean {
    const managed = this.getRunning(terminalId);
    if (!managed || !isValidTerminalDimensions(dimensions)) return false;
    managed.pty.resize(dimensions.columns, dimensions.rows);
    managed.tab = { ...managed.tab, dimensions: { ...dimensions } };
    this.emit({
      type: "host-terminal/resized",
      terminalId,
      dimensions: { ...dimensions },
    });
    return true;
  }

  pauseOutput(terminalId: string): boolean {
    const managed = this.getRunning(terminalId);
    if (!managed || managed.outputPaused) return false;
    managed.pty.pause();
    managed.outputPaused = true;
    return true;
  }

  resumeOutput(terminalId: string): boolean {
    const managed = this.getRunning(terminalId);
    if (!managed || !managed.outputPaused) return false;
    managed.pty.resume();
    managed.outputPaused = false;
    return true;
  }

  close(terminalId: string): boolean {
    const managed = this.sessions.get(terminalId);
    if (!managed) return false;
    this.closeManaged(managed);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const managed of this.sessions.values()) {
      this.closeManaged(managed);
    }
    this.listeners.clear();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("TerminalSessionService is disposed");
  }

  private getRunning(terminalId: string): ManagedHostTerminal | undefined {
    if (this.disposed) return undefined;
    const managed = this.sessions.get(terminalId);
    return managed?.tab.status === "running" ? managed : undefined;
  }

  private handleData(managed: ManagedHostTerminal, data: string): void {
    if (
      !this.sessions.has(managed.tab.id) ||
      managed.tab.status !== "running"
    ) {
      return;
    }
    const retained = retainUtf8Tail(
      managed.output,
      data,
      this.maxOutputBufferBytes,
    );
    managed.output = retained.data;
    managed.outputBytes = retained.byteLength;
    managed.droppedBytes += retained.droppedBytes;

    const accepted = this.emit({
      type: "host-terminal/data",
      terminalId: managed.tab.id,
      data,
    });
    if (!accepted && !managed.outputPaused) {
      managed.pty.pause();
      managed.outputPaused = true;
    }
  }

  private handleExit(
    managed: ManagedHostTerminal,
    event: HostPtyExitEvent,
  ): void {
    if (
      !this.sessions.has(managed.tab.id) ||
      managed.tab.status !== "running"
    ) {
      return;
    }
    managed.tab = {
      ...managed.tab,
      status: "exited",
      exitCode: event.exitCode,
      ...(event.signal === undefined ? {} : { signal: event.signal }),
    };
    managed.dataSubscription?.dispose();
    managed.exitSubscription?.dispose();
    this.emit({
      type: "host-terminal/exited",
      terminalId: managed.tab.id,
      exitCode: event.exitCode,
      ...(event.signal === undefined ? {} : { signal: event.signal }),
    });
  }

  private closeManaged(managed: ManagedHostTerminal): void {
    const terminalId = managed.tab.id;
    if (!this.sessions.delete(terminalId)) return;
    managed.dataSubscription?.dispose();
    managed.exitSubscription?.dispose();
    if (managed.tab.status === "running") {
      try {
        managed.pty.kill();
      } catch (error) {
        this.emit({
          type: "host-terminal/error",
          terminalId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.emit({ type: "host-terminal/closed", terminalId });
  }

  private emit(event: HostTerminalEvent): boolean {
    let accepted = true;
    for (const listener of this.listeners) {
      try {
        if (listener(event) === false) accepted = false;
      } catch (error) {
        try {
          this.onListenerError?.(error);
        } catch {
          // Listener failures and their reporters cannot compromise PTY cleanup.
        }
      }
    }
    return accepted;
  }
}
