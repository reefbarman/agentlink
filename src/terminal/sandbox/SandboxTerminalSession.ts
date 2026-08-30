import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { SandboxViolation } from "../../core/sandboxPolicy.js";
import {
  isValidTerminalDimensions,
  type TerminalDimensions,
} from "@agentlink/protocol/terminal";
import { Utf8TailBuffer } from "../Utf8TailBuffer.js";
import type {
  SandboxCommandDisposable,
  SandboxCommandEvent,
  SandboxCommandExit,
  SandboxCommandProcess,
  SandboxCommandReady,
} from "./SandboxRuntimeProvider.js";

const DEFAULT_MAX_REPLAY_BYTES = 1024 * 1024;
const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 10 * 1024 * 1024;
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
  maxCommandOutputBytes?: number;
  outputSpoolRoot?: string;
  maxCommands?: number;
  now?: () => number;
  isAllowedCwd?: (cwd: string) => boolean;
  onListenerError?: (error: unknown) => void;
}

export interface SandboxTerminalCommandOutput {
  output: string;
  complete: boolean;
  finalized: boolean;
  /** Bytes observed when this snapshot was created; the value can grow until finalized. */
  totalBytes: number;
  retainedBytes: number;
  droppedBytes: number;
}

export interface SandboxTerminalCommandOutputLease {
  metadata(): Omit<SandboxTerminalCommandOutput, "output">;
  read(): SandboxTerminalCommandOutput;
  dispose(): void;
}

interface CommandOutputSpool {
  directory?: string;
  filePath?: string;
  fileDescriptor?: number;
  writtenBytes: number;
  droppedBytes: number;
  failed: boolean;
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
  private readonly maxCommandOutputBytes: number;
  private readonly outputSpoolRoot: string;
  private readonly maxCommands: number;
  private readonly now: () => number;
  private readonly isAllowedCwd: (cwd: string) => boolean;
  private readonly onListenerError?: (error: unknown) => void;
  private readonly listeners = new Set<
    (event: SandboxTerminalSessionEvent) => void
  >();
  private readonly commands: SandboxTerminalCommandRecord[] = [];
  private readonly commandOutputSpools = new Map<string, CommandOutputSpool>();
  private dimensions: TerminalDimensions;
  private cwd: string;
  private readonly replayTail: Utf8TailBuffer;
  private nextGeneration = 1;
  private active:
    | {
        process: SandboxCommandProcess;
        command: SandboxTerminalCommandRecord;
        outputTail: Utf8TailBuffer;
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
    this.maxCommandOutputBytes =
      options.maxCommandOutputBytes ?? DEFAULT_MAX_COMMAND_OUTPUT_BYTES;
    this.outputSpoolRoot = options.outputSpoolRoot ?? os.tmpdir();
    this.maxCommands = options.maxCommands ?? DEFAULT_MAX_COMMANDS;
    if (
      !Number.isSafeInteger(this.maxReplayBytes) ||
      this.maxReplayBytes <= 0
    ) {
      throw new Error("maxReplayBytes must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(this.maxCommandOutputBytes) ||
      this.maxCommandOutputBytes <= 0
    ) {
      throw new Error("maxCommandOutputBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxCommands) || this.maxCommands <= 0) {
      throw new Error("maxCommands must be a positive safe integer");
    }
    this.channelId = options.channelId;
    this.title = options.title;
    this.replayTail = new Utf8TailBuffer(this.maxReplayBytes);
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

    this.cwd = input.cwd;
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
      outputTail: Utf8TailBuffer;
      eventSubscription?: SandboxCommandDisposable;
    } = {
      process: input.process,
      command,
      outputTail: new Utf8TailBuffer(this.maxReplayBytes),
    };
    this.active = active;
    this.commands.push(command);
    this.resetCommandOutputSpools(command.commandId);
    this.commandOutputSpools.set(
      command.commandId,
      this.createCommandOutputSpool(),
    );
    this.replayTail.append(
      `${this.replayTail.isEmpty ? "" : "\r\n"}$ ${input.command}\r\n`,
    );
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

  /**
   * Returns exact spooled output only for the latest command in this logical
   * session. Starting another command releases the previous command's spool.
   */
  getCommandOutput(
    commandId: string,
  ): SandboxTerminalCommandOutput | undefined {
    const command = this.commands.find(
      (candidate) => candidate.commandId === commandId,
    );
    if (!command) return undefined;
    return this.readCommandOutput(
      command,
      this.commandOutputSpools.get(commandId),
    );
  }

  detachCommandOutput(
    commandId: string,
  ): SandboxTerminalCommandOutputLease | undefined {
    const command = this.commands.find(
      (candidate) => candidate.commandId === commandId,
    );
    if (!command) return undefined;
    const spool = this.commandOutputSpools.get(commandId);
    this.commandOutputSpools.delete(commandId);
    if (spool?.fileDescriptor !== undefined) {
      try {
        fs.closeSync(spool.fileDescriptor);
      } catch {
        spool.failed = true;
      }
      spool.fileDescriptor = undefined;
    }
    let disposed = false;
    return {
      metadata: () => this.commandOutputMetadata(command, spool),
      read: () => this.readCommandOutput(command, spool),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.disposeCommandOutputSpool(spool);
      },
    };
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
      replay: this.replayTail.toString(),
      replayBytes: this.replayTail.byteLength,
      droppedReplayBytes: this.replayTail.droppedBytes,
      commands: this.commands.map((command) => {
        this.syncCommandRecord(command);
        return cloneCommand(command);
      }),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const active = this.active;
    this.active = undefined;
    active?.eventSubscription?.dispose();
    active?.process.dispose();
    this.resetCommandOutputSpools();
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
      this.appendCommandOutput(active.command.commandId, event.data);
      active.outputTail.append(event.data);
      this.replayTail.append(event.data);
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

  /**
   * Command records accumulate output in a chunked tail buffer while the
   * command runs; the record's string fields are refreshed lazily at read
   * points instead of on every data chunk.
   */
  private syncCommandRecord(command: SandboxTerminalCommandRecord): void {
    const active = this.active;
    if (active?.command !== command) return;
    command.output = active.outputTail.toString();
    command.outputBytes = active.outputTail.byteLength;
    command.droppedOutputBytes = active.outputTail.droppedBytes;
  }

  private handleExit(
    process: SandboxCommandProcess,
    exit: SandboxCommandExit,
  ): void {
    const active = this.current(process);
    if (!active) return;
    this.syncCommandRecord(active.command);
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
    this.syncCommandRecord(active.command);
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

  private commandOutputMetadata(
    command: SandboxTerminalCommandRecord,
    spool: CommandOutputSpool | undefined,
  ): Omit<SandboxTerminalCommandOutput, "output"> {
    this.syncCommandRecord(command);
    const finalized =
      command.status === "exited" || command.status === "failed";
    const totalBytes = command.outputBytes + command.droppedOutputBytes;
    const spoolComplete =
      spool?.filePath !== undefined &&
      !spool.failed &&
      spool.droppedBytes === 0 &&
      spool.writtenBytes === totalBytes;
    const tailComplete = command.droppedOutputBytes === 0;
    return {
      complete: finalized && (spoolComplete || tailComplete),
      finalized,
      totalBytes,
      retainedBytes: spoolComplete ? spool.writtenBytes : command.outputBytes,
      droppedBytes: spoolComplete ? 0 : command.droppedOutputBytes,
    };
  }

  private readCommandOutput(
    command: SandboxTerminalCommandRecord,
    spool: CommandOutputSpool | undefined,
  ): SandboxTerminalCommandOutput {
    const metadata = this.commandOutputMetadata(command, spool);
    if (
      spool?.filePath &&
      metadata.complete &&
      spool.writtenBytes === metadata.totalBytes
    ) {
      try {
        const raw = fs.readFileSync(spool.filePath);
        const retainedBytes = raw.byteLength;
        if (retainedBytes !== metadata.totalBytes) {
          spool.failed = true;
        } else {
          return {
            output: raw.toString("utf8"),
            ...metadata,
            retainedBytes,
          };
        }
      } catch {
        spool.failed = true;
      }
    }
    return {
      output: command.output,
      ...this.commandOutputMetadata(command, spool),
    };
  }

  private createCommandOutputSpool(): CommandOutputSpool {
    try {
      const directory = fs.mkdtempSync(
        path.join(this.outputSpoolRoot, "agentlink-terminal-output-"),
      );
      const filePath = path.join(directory, "raw-output.txt");
      const fileDescriptor = fs.openSync(filePath, "w", 0o600);
      return {
        directory,
        filePath,
        fileDescriptor,
        writtenBytes: 0,
        droppedBytes: 0,
        failed: false,
      };
    } catch {
      return {
        writtenBytes: 0,
        droppedBytes: 0,
        failed: true,
      };
    }
  }

  private appendCommandOutput(commandId: string, data: string): void {
    const spool = this.commandOutputSpools.get(commandId);
    if (!spool) return;
    const dataBytes = Buffer.byteLength(data, "utf8");
    if (spool.failed || spool.fileDescriptor === undefined) {
      spool.droppedBytes += dataBytes;
      return;
    }
    const remaining = this.maxCommandOutputBytes - spool.writtenBytes;
    if (remaining <= 0) {
      spool.droppedBytes += dataBytes;
      return;
    }
    let retained = data;
    if (dataBytes > remaining) {
      retained = "";
      let retainedBytes = 0;
      for (const character of data) {
        const characterBytes = Buffer.byteLength(character, "utf8");
        if (retainedBytes + characterBytes > remaining) break;
        retained += character;
        retainedBytes += characterBytes;
      }
    }
    const retainedBuffer = Buffer.from(retained, "utf8");
    let offset = 0;
    try {
      while (offset < retainedBuffer.byteLength) {
        const written = fs.writeSync(
          spool.fileDescriptor,
          retainedBuffer,
          offset,
          retainedBuffer.byteLength - offset,
        );
        if (written <= 0)
          throw new Error("output spool write made no progress");
        offset += written;
        spool.writtenBytes += written;
      }
      spool.droppedBytes += dataBytes - retainedBuffer.byteLength;
    } catch {
      spool.failed = true;
      spool.droppedBytes += dataBytes - offset;
    }
  }

  private disposeCommandOutputSpool(
    spool: CommandOutputSpool | undefined,
  ): void {
    if (!spool) return;
    if (spool.fileDescriptor !== undefined) {
      try {
        fs.closeSync(spool.fileDescriptor);
      } catch {
        // Best-effort cleanup of private output spools.
      }
      spool.fileDescriptor = undefined;
    }
    if (spool.directory) {
      try {
        fs.rmSync(spool.directory, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup of private output spools.
      }
    }
  }

  private resetCommandOutputSpools(exceptCommandId?: string): void {
    for (const [commandId, spool] of this.commandOutputSpools) {
      if (commandId === exceptCommandId) continue;
      this.disposeCommandOutputSpool(spool);
      this.commandOutputSpools.delete(commandId);
    }
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
