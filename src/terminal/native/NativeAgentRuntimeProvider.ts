import type { NodePtyModule, NodePtyProcess } from "../nodePtyFactory.js";
import type {
  SandboxCommandDisposable,
  SandboxCommandEvent,
  SandboxCommandExit,
  SandboxCommandProcess,
  SandboxCommandReady,
} from "../sandbox/SandboxRuntimeProvider.js";

import type { ResolvedHostShellProfile } from "../shellProfileResolver.js";
import type { SandboxCommandIdentity } from "../sandbox/sandboxHelperProtocol.js";
import type { TerminalDimensions } from "../../core/terminalProtocol.js";
import { createShellIntegrationParser } from "../shellIntegration.js";

const PROMPT_IDLE_READY_DELAY_MS = 25;

export interface NativeAgentShellLaunch {
  profile: ResolvedHostShellProfile;
  shell: "bash" | "zsh";
  nonce: string;
  cleanup(): Promise<void>;
}

export interface NativeAgentChannelRequest {
  channelId: string;
  launch: NativeAgentShellLaunch;
  dimensions: TerminalDimensions;
  onData(data: string): void;
  onCwd(cwd: string): void;
  onClosed(): void;
}

export interface NativeAgentCommandRequest extends SandboxCommandIdentity {
  command: string;
  /** Run inside a shell subshell so mutations cannot leak to later commands. */
  isolateShellState?: boolean;
  /** Fires at the shell command-end marker, before prompt rendering completes. */
  onShellCommandEnd?: () => void;
}

export interface NativeAgentPreparedCommand {
  process: SandboxCommandProcess;
  start(): void;
}

export interface NativeAgentRuntimeProvider {
  hasChannel(channelId: string): boolean;
  prepareChannel(request: NativeAgentChannelRequest): Promise<void>;
  createCommand(request: NativeAgentCommandRequest): NativeAgentPreparedCommand;
  write(channelId: string, data: string): boolean;
  resize(channelId: string, dimensions: TerminalDimensions): boolean;
  interrupt(channelId: string): boolean;
  closeChannel(channelId: string): boolean;
  dispose(): void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class PersistentNativeCommandProcess implements SandboxCommandProcess {
  readonly identity: SandboxCommandIdentity;
  readonly ready: Promise<SandboxCommandReady>;
  readonly completion: Promise<SandboxCommandExit>;

  private readonly readyDeferred = deferred<SandboxCommandReady>();
  private readonly completionDeferred = deferred<SandboxCommandExit>();
  private readonly listeners = new Set<(event: SandboxCommandEvent) => void>();
  private readonly pendingEvents: SandboxCommandEvent[] = [];
  private deliveryReady = false;
  private completionPending = false;
  private state: "prepared" | "running" | "completed" = "prepared";
  private disposed = false;

  constructor(
    private readonly channel: PersistentNativeChannel,
    identity: SandboxCommandIdentity,
    readonly command: string,
    private readonly onShellCommandEnd?: () => void,
  ) {
    this.identity = { ...identity };
    this.ready = this.readyDeferred.promise;
    this.completion = this.completionDeferred.promise;
  }

  onEvent(
    listener: (event: SandboxCommandEvent) => void,
  ): SandboxCommandDisposable {
    if (this.disposed) return { dispose() {} };
    this.listeners.add(listener);
    for (const event of this.pendingEvents.splice(0)) listener(event);
    return { dispose: () => this.listeners.delete(listener) };
  }

  start(): void {
    if (this.state !== "prepared" || this.disposed) {
      throw new Error("Native Agent command is no longer prepared");
    }
    this.state = "running";
  }

  markReady(pid: number): void {
    if (this.state !== "running" || this.disposed) return;
    this.readyDeferred.resolve({ pid, pgid: pid, backend: "native-pty" });
    queueMicrotask(() => {
      if (this.disposed || this.state !== "running") return;
      this.enableDelivery();
    });
  }

  emit(event: SandboxCommandEvent): void {
    if (this.state !== "running" || this.disposed) return;
    if (!this.deliveryReady || this.listeners.size === 0) {
      this.pendingEvents.push(event);
      return;
    }
    for (const listener of this.listeners) listener(event);
  }

  markShellCommandEnd(): void {
    if (this.state !== "running" || this.disposed) return;
    this.onShellCommandEnd?.();
  }

  complete(exit: SandboxCommandExit): void {
    if (this.state === "completed" || this.completionPending) return;
    if (this.state === "running" && !this.deliveryReady) {
      this.completionPending = true;
      queueMicrotask(() => {
        this.completionPending = false;
        this.enableDelivery();
        this.complete(exit);
      });
      return;
    }
    this.state = "completed";
    this.readyDeferred.resolve({
      pid: this.channel.pid,
      pgid: this.channel.pid,
      backend: "native-pty",
    });
    this.completionDeferred.resolve(exit);
  }

  private enableDelivery(): void {
    if (this.deliveryReady) return;
    this.deliveryReady = true;
    for (const event of this.pendingEvents.splice(0)) {
      for (const listener of this.listeners) listener(event);
    }
  }

  write(data: string): boolean {
    return this.state === "running" && !this.disposed
      ? this.channel.write(data)
      : false;
  }

  resize(dimensions: TerminalDimensions): boolean {
    return !this.disposed && this.channel.resize(dimensions);
  }

  interrupt(): boolean {
    return this.state === "running" && !this.disposed
      ? this.channel.interrupt()
      : false;
  }

  terminate(): boolean {
    // Terminate only the active command. Closing the persistent PTY here would
    // destroy intentional named/explicit terminal state and race command-end
    // finalization against the channel-close callback.
    return this.state === "running" && !this.disposed
      ? this.channel.interrupt()
      : false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.pendingEvents.length = 0;
    this.channel.abandon(this);
    this.complete({ timedOut: false });
  }
}

class PersistentNativeChannel {
  readonly pid: number;
  readonly ready: Promise<void>;

  private readonly parser;
  private readonly readyDeferred = deferred<void>();
  private readonly subscriptions: SandboxCommandDisposable[] = [];
  private active: PersistentNativeCommandProcess | undefined;
  private pendingExit: SandboxCommandExit | undefined;
  private completionImmediate: ReturnType<typeof setImmediate> | undefined;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private initialPromptStarted = false;
  private promptRendering = false;
  private commandStarted = false;
  private externalCommandRunning = false;
  private closed = false;
  private cleaned = false;

  constructor(
    readonly channelId: string,
    private readonly pty: NodePtyProcess,
    private readonly launch: NativeAgentShellLaunch,
    private readonly onData: (data: string) => void,
    private readonly onCwd: (cwd: string) => void,
    private readonly onClosed: () => void,
    private readonly log?: (message: string) => void,
  ) {
    this.pid = pty.pid ?? 0;
    this.ready = this.readyDeferred.promise;
    this.parser = createShellIntegrationParser(launch.nonce);
    this.subscriptions.push(
      pty.onData((data) => this.handleData(data)),
      pty.onExit((event) => this.handleExit(event)),
    );
  }

  createCommand(
    request: NativeAgentCommandRequest,
  ): NativeAgentPreparedCommand {
    if (this.closed)
      throw new Error(`Native Agent terminal ${this.channelId} is closed`);
    if (this.active || this.externalCommandRunning)
      throw new Error(`Native Agent terminal ${this.channelId} is busy`);
    if (!request.command || request.command.includes("\0")) {
      throw new Error("Native Agent command must be non-empty without NUL");
    }
    const process = new PersistentNativeCommandProcess(
      this,
      request,
      request.command,
      request.onShellCommandEnd,
    );
    this.active = process;
    this.pendingExit = undefined;
    this.commandStarted = false;
    return {
      process,
      start: () => {
        if (this.active !== process) {
          throw new Error("Prepared Native Agent command target changed");
        }
        process.start();
        this.onData(`${request.command}\r\n`);
        const evaluatedCommand = request.isolateShellState
          ? `(\n${request.command}\n)`
          : request.command;
        this.pty.write(`builtin eval ${shellQuote(` ${evaluatedCommand}`)}\r`);
      },
    };
  }

  write(data: string): boolean {
    if (this.closed) return false;
    this.pty.write(data);
    return true;
  }

  resize(dimensions: TerminalDimensions): boolean {
    if (this.closed) return false;
    this.pty.resize(dimensions.columns, dimensions.rows);
    return true;
  }

  interrupt(): boolean {
    return this.write("\x03");
  }

  abandon(process: PersistentNativeCommandProcess): void {
    if (this.active !== process) return;
    this.active = undefined;
    this.pendingExit = undefined;
    this.commandStarted = false;
  }

  close(): boolean {
    if (this.closed) return false;
    this.closed = true;
    try {
      this.pty.kill();
    } catch {
      // The shell may already have exited.
    }
    this.finishClose();
    return true;
  }

  private handleData(data: string): void {
    if (this.closed) return;
    const parsed = this.parser.push(data);
    for (const segment of parsed.segments) {
      if (segment.type === "data") {
        if (!this.active || this.commandStarted) this.onData(segment.data);
        if (
          this.launch.shell === "bash" &&
          !this.active &&
          this.initialPromptStarted &&
          segment.data
        ) {
          this.scheduleReadyAfterPromptIdle();
        }
        if (this.commandStarted && !this.promptRendering) {
          this.active?.emit({ type: "data", data: segment.data });
        }
        continue;
      }
      const event = segment.event;
      if (event.type === "prompt-start") {
        this.promptRendering = true;
        if (this.launch.shell === "bash") {
          this.externalCommandRunning = false;
          this.scheduleReadyAfterPromptIdle();
          if (this.pendingExit) this.completeActive(this.pendingExit);
        }
        this.initialPromptStarted = true;
        continue;
      }
      if (event.type === "prompt-end") {
        this.promptRendering = false;
        if (this.launch.shell === "zsh") {
          this.externalCommandRunning = false;
          this.readyDeferred.resolve();
          if (this.pendingExit) this.completeActive(this.pendingExit);
        }
        continue;
      }
      if (event.type === "command-start") {
        if (!this.active) {
          this.externalCommandRunning = true;
          continue;
        }
        if (this.commandStarted) continue;
        this.commandStarted = true;
        this.active.markReady(this.pid);
        continue;
      }
      if (event.type === "command-end") {
        if (!this.active || !this.commandStarted) continue;
        this.active.markShellCommandEnd();
        this.pendingExit = { exitCode: event.exitCode, timedOut: false };
        this.completionImmediate = setImmediate(() => {
          this.completionImmediate = undefined;
          if (this.pendingExit && this.launch.shell === "bash") {
            this.completeActive(this.pendingExit);
          }
        });
        this.completionImmediate.unref();
        continue;
      }
      if (event.type === "cwd") {
        this.onCwd(event.cwd);
        if (!this.active || !this.commandStarted) {
          this.externalCommandRunning = false;
          continue;
        }
        this.active.emit({
          type: "cwd",
          cwd: event.cwd,
          nonce: this.launch.nonce,
        });
        if (this.pendingExit && this.launch.shell === "bash") {
          if (this.completionImmediate) {
            clearImmediate(this.completionImmediate);
            this.completionImmediate = undefined;
          }
          this.completeActive(this.pendingExit);
        }
      }
    }
  }

  private scheduleReadyAfterPromptIdle(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      this.readyTimer = undefined;
      if (!this.closed) this.readyDeferred.resolve();
    }, PROMPT_IDLE_READY_DELAY_MS);
    this.readyTimer.unref();
  }

  private handleExit(event: { exitCode: number; signal?: number }): void {
    if (this.closed) return;
    this.closed = true;
    this.readyDeferred.reject(
      new Error(
        `Native Agent shell exited before becoming ready (exit ${event.exitCode})`,
      ),
    );
    this.completeActive({
      exitCode: event.exitCode,
      signal: event.signal,
      timedOut: false,
    });
    this.finishClose();
  }

  private completeActive(exit: SandboxCommandExit): void {
    if (this.completionImmediate) {
      clearImmediate(this.completionImmediate);
      this.completionImmediate = undefined;
    }
    const active = this.active;
    this.active = undefined;
    this.pendingExit = undefined;
    this.commandStarted = false;
    active?.complete(exit);
  }

  private finishClose(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
    }
    this.completeActive({ timedOut: false });
    for (const subscription of this.subscriptions.splice(0))
      subscription.dispose();
    this.onClosed();
    if (!this.cleaned) {
      this.cleaned = true;
      void this.launch
        .cleanup()
        .catch((error) =>
          this.log?.(
            `[native-agent-terminal] Bootstrap cleanup failed: ${String(error)}`,
          ),
        );
    }
  }
}

export interface NodePtyNativeAgentRuntimeProviderOptions {
  startupTimeoutMs?: number;
}

export class NodePtyNativeAgentRuntimeProvider implements NativeAgentRuntimeProvider {
  private readonly channels = new Map<string, PersistentNativeChannel>();
  private readonly startupTimeoutMs: number;
  private disposed = false;
  log?: (message: string) => void;

  constructor(
    private readonly nodePty: NodePtyModule,
    options: NodePtyNativeAgentRuntimeProviderOptions = {},
  ) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
    if (
      !Number.isSafeInteger(this.startupTimeoutMs) ||
      this.startupTimeoutMs <= 0
    ) {
      throw new Error("startupTimeoutMs must be a positive safe integer");
    }
  }

  hasChannel(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  async prepareChannel(request: NativeAgentChannelRequest): Promise<void> {
    if (this.disposed) throw new Error("Native Agent runtime is disposed");
    const existing = this.channels.get(request.channelId);
    if (existing) {
      await existing.ready;
      return;
    }
    const pty = this.nodePty.spawn(
      request.launch.profile.shellPath,
      [...request.launch.profile.shellArgs],
      {
        name: "xterm-256color",
        cols: request.dimensions.columns,
        rows: request.dimensions.rows,
        cwd: request.launch.profile.cwd,
        env: { ...request.launch.profile.environment },
        encoding: "utf8",
        handleFlowControl: false,
      },
    );
    let channel!: PersistentNativeChannel;
    channel = new PersistentNativeChannel(
      request.channelId,
      pty,
      request.launch,
      request.onData,
      request.onCwd,
      () => {
        if (this.channels.get(request.channelId) === channel) {
          this.channels.delete(request.channelId);
        }
        request.onClosed();
      },
      this.log,
    );
    this.channels.set(request.channelId, channel);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        channel.ready,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error("Native Agent shell integration startup timed out"),
              ),
            this.startupTimeoutMs,
          );
          timer.unref();
        }),
      ]);
    } catch (error) {
      channel.close();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  createCommand(
    request: NativeAgentCommandRequest,
  ): NativeAgentPreparedCommand {
    if (this.disposed) throw new Error("Native Agent runtime is disposed");
    const channel = this.channels.get(request.channelId);
    if (!channel) {
      throw new Error(
        `Native Agent terminal ${request.channelId} is unavailable`,
      );
    }
    return channel.createCommand(request);
  }

  write(channelId: string, data: string): boolean {
    return this.channels.get(channelId)?.write(data) ?? false;
  }

  resize(channelId: string, dimensions: TerminalDimensions): boolean {
    return this.channels.get(channelId)?.resize(dimensions) ?? false;
  }

  interrupt(channelId: string): boolean {
    return this.channels.get(channelId)?.interrupt() ?? false;
  }

  closeChannel(channelId: string): boolean {
    return this.channels.get(channelId)?.close() ?? false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const channel of this.channels.values()) channel.close();
    this.channels.clear();
  }
}
