import { Buffer } from "node:buffer";

import type { SandboxViolation } from "../../core/sandboxPolicy.js";
import {
  isValidTerminalDimensions,
  type TerminalDimensions,
} from "../../core/terminalProtocol.js";
import type {
  SandboxCommandDisposable,
  SandboxCommandEvent,
  SandboxCommandExit,
  SandboxCommandProcess,
  SandboxCommandReady,
} from "./SandboxRuntimeProvider.js";

const DEFAULT_MAX_REPLAY_BYTES = 1024 * 1024;
const DEFAULT_MAX_COMMANDS = 200;

export type SandboxCommandOrigin = "agent" | "user" | "ai-staged";
export type SandboxCommandStatus =
  | "launching"
  | "running"
  | "exited"
  | "failed";

export interface SandboxTerminalCommandRecord {
  commandId: string;
  generation: number;
  command: string;
  cwd: string;
  origin: SandboxCommandOrigin;
  status: SandboxCommandStatus;
  startedAt: number;
  readyAt?: number;
  finishedAt?: number;
  exitCode?: number;
  signal?: number;
  timedOut?: boolean;
  error?: string;
  output: string;
  outputBytes: number;
  droppedOutputBytes: number;
  violations: SandboxViolation[];
  backend?: string;
  backendVersion?: string;
}

export interface SandboxTerminalSessionSnapshot {
  channelId: string;
  title: string;
  cwd: string;
  dimensions: TerminalDimensions;
  status: "idle" | "launching" | "running" | "closed";
  activeCommandId?: string;
  nextGeneration: number;
  replay: string;
  replayBytes: number;
  droppedReplayBytes: number;
  commands: SandboxTerminalCommandRecord[];
}

export type SandboxTerminalSessionEvent =
  | { type: "command-started"; command: SandboxTerminalCommandRecord }
  | {
      type: "command-ready";
      commandId: string;
      generation: number;
      ready: SandboxCommandReady;
    }
  | {
      type: "data";
      commandId: string;
      generation: number;
      data: string;
    }
  | {
      type: "cwd";
      commandId: string;
      generation: number;
      cwd: string;
    }
  | {
      type: "violation";
      commandId: string;
      generation: number;
      violation: SandboxViolation;
    }
  | {
      type: "network-request";
      commandId: string;
      generation: number;
      request: Extract<
        SandboxCommandEvent,
        { type: "network-request" }
      >["request"];
    }
  | {
      type: "command-exited";
      commandId: string;
      generation: number;
      exit: SandboxCommandExit;
    }
  | {
      type: "command-failed";
      commandId: string;
      generation: number;
      error: string;
    }
  | { type: "resized"; dimensions: TerminalDimensions }
  | { type: "closed" };

export interface SandboxTerminalSessionOptions {
  channelId: string;
  title: string;
  initialCwd: string;
  dimensions: TerminalDimensions;
  maxReplayBytes?: number;
  maxCommands?: number;
  now?: () => number;
  isAllowedCwd?: (cwd: string) => boolean;
  onListenerError?: (error: unknown) => void;
}

function retainUtf8Tail(
  current: string,
  appended: string,
  maxBytes: number,
): { data: string; byteLength: number; droppedBytes: number } {
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
  return {
    data,
    byteLength: Buffer.byteLength(data, "utf8"),
    droppedBytes: combined.byteLength - Buffer.byteLength(data, "utf8"),
  };
}

function cloneCommand(
  command: SandboxTerminalCommandRecord,
): SandboxTerminalCommandRecord {
  return {
    ...command,
    violations: command.violations.map((violation) => ({ ...violation })),
  };
}

export class SandboxTerminalSession {
  private readonly maxReplayBytes: number;
  private readonly maxCommands: number;
  private readonly now: () => number;
  private readonly isAllowedCwd: (cwd: string) => boolean;
  private readonly onListenerError?: (error: unknown) => void;
  private readonly listeners = new Set<
    (event: SandboxTerminalSessionEvent) => void
  >();
  private readonly commands: SandboxTerminalCommandRecord[] = [];
  private dimensions: TerminalDimensions;
  private cwd: string;
  private replay = "";
  private replayBytes = 0;
  private droppedReplayBytes = 0;
  private nextGeneration = 1;
  private active:
    | {
        process: SandboxCommandProcess;
        command: SandboxTerminalCommandRecord;
        eventSubscription?: SandboxCommandDisposable;
      }
    | undefined;
  private closed = false;

  readonly channelId: string;
  readonly title: string;

  constructor(options: SandboxTerminalSessionOptions) {
    if (!options.channelId || options.channelId.includes("\0")) {
      throw new Error("channelId must be a non-empty string without NUL");
    }
    if (!options.title || options.title.includes("\0")) {
      throw new Error("title must be a non-empty string without NUL");
    }
    if (!options.initialCwd || options.initialCwd.includes("\0")) {
      throw new Error("initialCwd must be a non-empty string without NUL");
    }
    if (!isValidTerminalDimensions(options.dimensions)) {
      throw new Error("Terminal dimensions must be positive integers");
    }
    this.maxReplayBytes = options.maxReplayBytes ?? DEFAULT_MAX_REPLAY_BYTES;
    this.maxCommands = options.maxCommands ?? DEFAULT_MAX_COMMANDS;
    if (
      !Number.isSafeInteger(this.maxReplayBytes) ||
      this.maxReplayBytes <= 0
    ) {
      throw new Error("maxReplayBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxCommands) || this.maxCommands <= 0) {
      throw new Error("maxCommands must be a positive safe integer");
    }
    this.channelId = options.channelId;
    this.title = options.title;
    this.cwd = options.initialCwd;
    this.dimensions = { ...options.dimensions };
    this.now = options.now ?? Date.now;
    this.isAllowedCwd = options.isAllowedCwd ?? (() => true);
    this.onListenerError = options.onListenerError;
  }

  onEvent(
    listener: (event: SandboxTerminalSessionEvent) => void,
  ): SandboxCommandDisposable {
    this.assertOpen();
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  startCommand(input: {
    command: string;
    cwd: string;
    origin: SandboxCommandOrigin;
    process: SandboxCommandProcess;
  }): SandboxTerminalCommandRecord {
    this.assertOpen();
    if (this.active) throw new Error("Sandbox terminal channel is busy");
    if (input.process.identity.channelId !== this.channelId) {
      throw new Error(
        "Sandbox process channel identity does not match session",
      );
    }
    if (input.process.identity.generation !== this.nextGeneration) {
      throw new Error("Sandbox process generation does not match session");
    }
    if (!input.command || input.command.includes("\0")) {
      throw new Error("Sandbox command must be non-empty without NUL");
    }
    if (!this.isAllowedCwd(input.cwd)) {
      throw new Error("Sandbox command cwd is not allowed for this channel");
    }

    const command: SandboxTerminalCommandRecord = {
      commandId: input.process.identity.commandId,
      generation: input.process.identity.generation,
      command: input.command,
      cwd: input.cwd,
      origin: input.origin,
      status: "launching",
      startedAt: this.now(),
      output: "",
      outputBytes: 0,
      droppedOutputBytes: 0,
      violations: [],
    };
    const active: {
      process: SandboxCommandProcess;
      command: SandboxTerminalCommandRecord;
      eventSubscription?: SandboxCommandDisposable;
    } = { process: input.process, command };
    this.active = active;
    this.commands.push(command);
    const replay = retainUtf8Tail(
      this.replay,
      `${this.replay ? "\r\n" : ""}$ ${input.command}\r\n`,
      this.maxReplayBytes,
    );
    this.replay = replay.data;
    this.replayBytes = replay.byteLength;
    this.droppedReplayBytes += replay.droppedBytes;
    this.nextGeneration += 1;
    this.evictCommands();
    this.emit({ type: "command-started", command: cloneCommand(command) });

    void input.process.ready.then(
      (ready) => this.handleReady(input.process, ready),
      (error) => this.handleFailure(input.process, error),
    );
    active.eventSubscription = input.process.onEvent((event) =>
      this.handleProcessEvent(input.process, event),
    );
    void input.process.completion.then(
      (exit) => this.handleExit(input.process, exit),
      (error) => this.handleFailure(input.process, error),
    );
    return cloneCommand(command);
  }

  write(data: string): boolean {
    return this.active?.command.status === "running"
      ? this.active.process.write(data)
      : false;
  }

  synchronizeCwd(cwd: string): boolean {
    if (this.closed || !this.isAllowedCwd(cwd)) return false;
    this.cwd = cwd;
    return true;
  }

  resize(dimensions: TerminalDimensions): boolean {
    if (this.closed || !isValidTerminalDimensions(dimensions)) return false;
    this.dimensions = { ...dimensions };
    const accepted = this.active?.process.resize(dimensions) ?? true;
    this.emit({ type: "resized", dimensions: { ...dimensions } });
    return accepted;
  }

  interrupt(): boolean {
    return this.active?.command.status === "running"
      ? this.active.process.interrupt()
      : false;
  }

  terminate(): boolean {
    return this.active?.process.terminate() ?? false;
  }

  snapshot(): SandboxTerminalSessionSnapshot {
    return {
      channelId: this.channelId,
      title: this.title,
      cwd: this.cwd,
      dimensions: { ...this.dimensions },
      status: this.closed
        ? "closed"
        : this.active?.command.status === "launching"
          ? "launching"
          : this.active?.command.status === "running"
            ? "running"
            : "idle",
      ...(this.active
        ? { activeCommandId: this.active.command.commandId }
        : {}),
      nextGeneration: this.nextGeneration,
      replay: this.replay,
      replayBytes: this.replayBytes,
      droppedReplayBytes: this.droppedReplayBytes,
      commands: this.commands.map(cloneCommand),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const active = this.active;
    this.active = undefined;
    active?.eventSubscription?.dispose();
    active?.process.dispose();
    this.emit({ type: "closed" });
    this.listeners.clear();
  }

  private handleReady(
    process: SandboxCommandProcess,
    ready: SandboxCommandReady,
  ): void {
    const active = this.current(process);
    if (!active || active.command.status !== "launching") return;
    active.command.status = "running";
    active.command.readyAt = this.now();
    active.command.backend = ready.backend;
    active.command.backendVersion = ready.backendVersion;
    this.emit({
      type: "command-ready",
      commandId: active.command.commandId,
      generation: active.command.generation,
      ready,
    });
  }

  private handleProcessEvent(
    process: SandboxCommandProcess,
    event: SandboxCommandEvent,
  ): void {
    const active = this.current(process);
    if (!active) return;
    if (event.type === "network-request") {
      this.emit({
        type: "network-request",
        commandId: active.command.commandId,
        generation: active.command.generation,
        request: {
          ...event.request,
          dnsAnswers: event.request.dnsAnswers.map((answer) => ({ ...answer })),
        },
      });
      return;
    }
    if (active.command.status !== "running") return;
    if (event.type === "data") {
      const commandOutput = retainUtf8Tail(
        active.command.output,
        event.data,
        this.maxReplayBytes,
      );
      active.command.output = commandOutput.data;
      active.command.outputBytes = commandOutput.byteLength;
      active.command.droppedOutputBytes += commandOutput.droppedBytes;
      const replay = retainUtf8Tail(
        this.replay,
        event.data,
        this.maxReplayBytes,
      );
      this.replay = replay.data;
      this.replayBytes = replay.byteLength;
      this.droppedReplayBytes += replay.droppedBytes;
      this.emit({
        type: "data",
        commandId: active.command.commandId,
        generation: active.command.generation,
        data: event.data,
      });
      return;
    }
    if (event.type === "cwd") {
      if (!this.isAllowedCwd(event.cwd)) return;
      this.cwd = event.cwd;
      this.emit({
        type: "cwd",
        commandId: active.command.commandId,
        generation: active.command.generation,
        cwd: event.cwd,
      });
      return;
    }
    active.command.violations.push({ ...event.violation });
    this.emit({
      type: "violation",
      commandId: active.command.commandId,
      generation: active.command.generation,
      violation: { ...event.violation },
    });
  }

  private handleExit(
    process: SandboxCommandProcess,
    exit: SandboxCommandExit,
  ): void {
    const active = this.current(process);
    if (!active) return;
    active.command.status = "exited";
    active.command.finishedAt = this.now();
    active.command.exitCode = exit.exitCode;
    active.command.signal = exit.signal;
    active.command.timedOut = exit.timedOut;
    active.eventSubscription?.dispose();
    this.active = undefined;
    this.emit({
      type: "command-exited",
      commandId: active.command.commandId,
      generation: active.command.generation,
      exit,
    });
  }

  private handleFailure(process: SandboxCommandProcess, error: unknown): void {
    const active = this.current(process);
    if (!active) return;
    active.command.status = "failed";
    active.command.finishedAt = this.now();
    active.command.error =
      error instanceof Error ? error.message : String(error);
    active.eventSubscription?.dispose();
    this.active = undefined;
    this.emit({
      type: "command-failed",
      commandId: active.command.commandId,
      generation: active.command.generation,
      error: active.command.error,
    });
  }

  private current(process: SandboxCommandProcess) {
    return this.active?.process === process ? this.active : undefined;
  }

  private evictCommands(): void {
    while (this.commands.length > this.maxCommands) this.commands.shift();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Sandbox terminal session is closed");
  }

  private emit(event: SandboxTerminalSessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError?.(error);
      }
    }
  }
}
