import type {
  ClosedTerminalSnapshot,
  NativePreparingTerminalProvider,
  PreparedTerminalExecution,
  TerminalBackgroundState,
  TerminalCloseResult,
  TerminalCommandResult,
  TerminalExecutionSecuritySummary,
  TerminalExecuteOptions,
  TerminalMetadata,
} from "../../core/capabilities/terminal.js";
import type { TerminalDimensions } from "../../core/terminalProtocol.js";
import { buildAgentExecutionEnv } from "../../process/agentExecutionPolicy.js";
import {
  cleanTerminalOutput,
  cleanTerminalRawOutput,
} from "../../util/ansi.js";
import type { NodePtyModuleLoader } from "../deferredNodePtyLoader.js";
import type { MaterializedHostShellBootstrap } from "../hostShellBootstrap.js";
import type { SandboxCommandProcess } from "../sandbox/SandboxRuntimeProvider.js";
import {
  SandboxTerminalSession,
  type SandboxTerminalSessionEvent,
  type SandboxTerminalSessionSnapshot,
} from "../sandbox/SandboxTerminalSession.js";
import {
  NodePtyNativeAgentRuntimeProvider,
  type NativeAgentRuntimeProvider,
} from "./NativeAgentRuntimeProvider.js";

const DEFAULT_DIMENSIONS: TerminalDimensions = { columns: 80, rows: 24 };
const DEFAULT_RECENTLY_CLOSED_LIMIT = 20;
const DEFAULT_AGENTLINK_TITLE = "AgentLink";

export interface NativeAgentTerminalChannelEvent {
  event: SandboxTerminalSessionEvent;
  snapshot: SandboxTerminalSessionSnapshot;
}

export interface NativeAgentTerminalRawDataEvent {
  channelId: string;
  data: string;
}

export interface NativeAgentTerminalCoordinatorOptions {
  nodePtyLoader: NodePtyModuleLoader;
  initialCwd: string;
  prepareShell(input: {
    channelId: string;
    cwd: string;
    env: Readonly<Record<string, string>>;
  }): Promise<MaterializedHostShellBootstrap>;
  dimensions?: TerminalDimensions;
  createChannelId?: () => string;
  createCommandId?: () => string;
  createRuntime?: (loader: NodePtyModuleLoader) => NativeAgentRuntimeProvider;
  now?: () => number;
  log?: (message: string) => void;
}

interface ManagedNativeChannel {
  session: SandboxTerminalSession;
  envKey?: string;
  active?: {
    commandId: string;
    process: SandboxCommandProcess;
    finalizer?: () => void;
  };
}

function finalizedOnce(
  callback: (() => void) | undefined,
): (() => void) | undefined {
  if (!callback) return undefined;
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback();
  };
}

function snapshotOptions(
  options: TerminalExecuteOptions,
): TerminalExecuteOptions {
  return Object.freeze({
    ...options,
    ...(options.env ? { env: Object.freeze({ ...options.env }) } : {}),
  });
}

function environmentKey(
  env: Readonly<Record<string, string>> | undefined,
): string {
  return JSON.stringify(
    Object.entries(env ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

export class NativeAgentTerminalCoordinator implements NativePreparingTerminalProvider {
  private readonly dimensions: TerminalDimensions;
  private readonly createChannelId: () => string;
  private readonly createCommandId: () => string;
  private readonly now: () => number;
  private readonly runtime: NativeAgentRuntimeProvider;
  private readonly channels = new Map<string, ManagedNativeChannel>();
  private readonly recentlyClosed: ClosedTerminalSnapshot[] = [];
  private readonly channelListeners = new Set<
    (update: NativeAgentTerminalChannelEvent) => void
  >();
  private readonly rawDataListeners = new Set<
    (update: NativeAgentTerminalRawDataEvent) => void
  >();
  private readonly disposeListeners = new Set<() => void>();
  private readonly reservations = new Map<string, symbol>();
  private nextChannelNumber = 1;
  private nextCommandNumber = 1;
  private disposed = false;
  log?: (message: string) => void;

  constructor(private readonly options: NativeAgentTerminalCoordinatorOptions) {
    this.dimensions = { ...(options.dimensions ?? DEFAULT_DIMENSIONS) };
    this.createChannelId =
      options.createChannelId ??
      (() => `native-agent-${this.nextChannelNumber++}`);
    this.createCommandId =
      options.createCommandId ??
      (() => `native-command-${this.nextCommandNumber++}`);
    this.now = options.now ?? Date.now;
    this.runtime =
      options.createRuntime?.(options.nodePtyLoader) ??
      new NodePtyNativeAgentRuntimeProvider(options.nodePtyLoader.load());
    this.log = options.log;
  }

  async prepareNativeExecution(
    options: TerminalExecuteOptions,
    security: TerminalExecutionSecuritySummary,
  ): Promise<PreparedTerminalExecution> {
    this.assertActive();
    const descriptor = snapshotOptions(options);
    const channel = this.resolveChannel(descriptor);
    const before = channel.session.snapshot();
    if (
      before.status === "launching" ||
      before.status === "running" ||
      this.reservations.has(before.channelId)
    ) {
      throw new Error(`Native Agent terminal ${before.channelId} is busy`);
    }
    const reservation = Symbol("native-agent-preparation");
    this.reservations.set(before.channelId, reservation);
    let state: "prepared" | "consumed" | "disposed" = "prepared";

    return {
      security,
      execute: async () => {
        if (state !== "prepared") {
          throw new Error(
            "Prepared Native Agent execution is no longer available",
          );
        }
        if (this.reservations.get(before.channelId) !== reservation) {
          state = "disposed";
          throw new Error(
            "Prepared Native Agent terminal reservation is stale",
          );
        }
        const current = channel.session.snapshot();
        if (
          current.status === "launching" ||
          current.status === "running" ||
          current.status === "closed" ||
          current.nextGeneration !== before.nextGeneration
        ) {
          state = "disposed";
          this.reservations.delete(before.channelId);
          throw new Error("Prepared Native Agent terminal target changed");
        }
        state = "consumed";
        try {
          const result = await this.executeOnChannel(
            descriptor,
            channel,
            before,
          );
          return { ...result, security };
        } finally {
          if (this.reservations.get(before.channelId) === reservation) {
            this.reservations.delete(before.channelId);
          }
        }
      },
      dispose: () => {
        if (state !== "prepared") return;
        state = "disposed";
        if (this.reservations.get(before.channelId) === reservation) {
          this.reservations.delete(before.channelId);
        }
      },
    };
  }

  async executeCommand(
    options: TerminalExecuteOptions,
  ): Promise<TerminalCommandResult> {
    const descriptor = snapshotOptions(options);
    const channel = this.resolveChannel(descriptor);
    const before = channel.session.snapshot();
    if (
      before.status === "launching" ||
      before.status === "running" ||
      this.reservations.has(before.channelId)
    ) {
      throw new Error(`Native Agent terminal ${before.channelId} is busy`);
    }
    const reservation = Symbol("native-agent-execution");
    this.reservations.set(before.channelId, reservation);
    try {
      return await this.executeOnChannel(descriptor, channel, before);
    } finally {
      if (this.reservations.get(before.channelId) === reservation) {
        this.reservations.delete(before.channelId);
      }
    }
  }

  getBackgroundState(terminalId: string): TerminalBackgroundState | undefined {
    const channel = this.channels.get(terminalId);
    return channel
      ? this.backgroundStateFromSnapshot(channel.session.snapshot())
      : undefined;
  }

  getCurrentOutput(
    terminalId: string,
    _options?: { force?: boolean },
  ): string | undefined {
    // Native output is already held in the in-memory session; there is no
    // external shell-integration buffer to flush when force is requested.
    const snapshot = this.channels.get(terminalId)?.session.snapshot();
    return snapshot
      ? cleanTerminalOutput(snapshot.commands.at(-1)?.output ?? "")
      : undefined;
  }

  interruptTerminal(terminalId: string): boolean {
    return this.runtime.interrupt(terminalId);
  }

  getRecentlyClosedTerminals(limit = 5): ClosedTerminalSnapshot[] {
    return this.recentlyClosed.slice(0, Math.max(0, limit)).map((item) => ({
      ...item,
    }));
  }

  listTerminals(): TerminalMetadata[] {
    return [...this.channels.values()].map(({ session }) => {
      const snapshot = session.snapshot();
      return {
        id: snapshot.channelId,
        name: snapshot.title,
        busy: snapshot.status === "launching" || snapshot.status === "running",
      };
    });
  }

  closeTerminals(names?: string[]): TerminalCloseResult {
    const requested = names ? new Set(names) : undefined;
    const notFound = requested ? new Set(requested) : undefined;
    let closed = 0;
    for (const [channelId, channel] of this.channels) {
      const snapshot = channel.session.snapshot();
      if (
        requested &&
        !requested.has(channelId) &&
        !requested.has(snapshot.title)
      ) {
        continue;
      }
      requested?.delete(channelId);
      requested?.delete(snapshot.title);
      notFound?.delete(channelId);
      notFound?.delete(snapshot.title);
      channel.session.close();
      channel.active?.finalizer?.();
      this.runtime.closeChannel(channelId);
      this.channels.delete(channelId);
      this.reservations.delete(channelId);
      this.rememberClosed(snapshot);
      closed += 1;
    }
    return {
      closed,
      ...(notFound && notFound.size > 0 ? { not_found: [...notFound] } : {}),
    };
  }

  getChannelSnapshot(
    channelId: string,
  ): SandboxTerminalSessionSnapshot | undefined {
    return this.channels.get(channelId)?.session.snapshot();
  }

  onChannelEvent(listener: (update: NativeAgentTerminalChannelEvent) => void): {
    dispose(): void;
  } {
    this.assertActive();
    this.channelListeners.add(listener);
    return { dispose: () => this.channelListeners.delete(listener) };
  }

  onRawData(listener: (update: NativeAgentTerminalRawDataEvent) => void): {
    dispose(): void;
  } {
    this.assertActive();
    this.rawDataListeners.add(listener);
    return { dispose: () => this.rawDataListeners.delete(listener) };
  }

  onDispose(listener: () => void): { dispose(): void } {
    this.assertActive();
    this.disposeListeners.add(listener);
    return { dispose: () => this.disposeListeners.delete(listener) };
  }

  write(channelId: string, data: string): boolean {
    return this.channels.has(channelId) && this.runtime.write(channelId, data);
  }

  resize(channelId: string, dimensions: TerminalDimensions): boolean {
    const channel = this.channels.get(channelId);
    if (!channel || !channel.session.resize(dimensions)) return false;
    return this.runtime.resize(channelId, dimensions);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const channel of this.channels.values()) {
      channel.session.close();
      channel.active?.finalizer?.();
      this.runtime.closeChannel(channel.session.channelId);
    }
    this.channels.clear();
    this.reservations.clear();
    this.channelListeners.clear();
    this.rawDataListeners.clear();
    this.runtime.dispose();
    for (const listener of this.disposeListeners) listener();
    this.disposeListeners.clear();
  }

  private async executeOnChannel(
    options: TerminalExecuteOptions,
    channel: ManagedNativeChannel,
    before: SandboxTerminalSessionSnapshot,
  ): Promise<TerminalCommandResult> {
    this.assertActive();
    const commandId = this.createCommandId();
    if (!commandId || commandId.includes("\0")) {
      throw new Error("createCommandId must return a non-empty ID without NUL");
    }
    const envKey = environmentKey(options.env);
    if (channel.envKey !== undefined && channel.envKey !== envKey) {
      throw new Error(
        `Native Agent terminal ${before.channelId} has an incompatible command environment`,
      );
    }
    if (before.cwd !== options.cwd) {
      throw new Error(
        `Native Agent terminal ${before.channelId} is in ${before.cwd}, not ${options.cwd}`,
      );
    }
    if (!this.runtime.hasChannel(before.channelId)) {
      const bootstrap = await this.options.prepareShell({
        channelId: before.channelId,
        cwd: options.cwd,
        env: {
          ...buildAgentExecutionEnv(),
          ...options.env,
        },
      });
      if (bootstrap.mode !== "integrated") {
        throw new Error(
          "Native Agent requires an integrated interactive bash or zsh profile",
        );
      }
      await this.runtime.prepareChannel({
        channelId: before.channelId,
        launch: {
          profile: bootstrap.profile,
          shell: bootstrap.shell,
          nonce: bootstrap.nonce,
          cleanup: bootstrap.cleanup,
        },
        dimensions: before.dimensions,
        onData: (data) => {
          const update = { channelId: before.channelId, data };
          for (const listener of this.rawDataListeners) listener(update);
        },
        onCwd: (cwd) => {
          if (!channel.session.synchronizeCwd(cwd)) return;
          const update = { channelId: before.channelId, data: "" };
          for (const listener of this.rawDataListeners) listener(update);
        },
        onClosed: () => this.handleRuntimeChannelClosed(before.channelId),
      });
      channel.envKey = envKey;
    }
    const preparedCommand = this.runtime.createCommand({
      channelId: before.channelId,
      commandId,
      generation: before.nextGeneration,
      command: options.command,
    });
    const process = preparedCommand.process;
    const finalizer = finalizedOnce(options.onCommandFinalized);
    channel.active = { commandId, process, finalizer };
    try {
      channel.session.startCommand({
        command: options.command,
        cwd: options.cwd,
        origin: options.sandboxSessionId?.startsWith("terminal-user:")
          ? "user"
          : "agent",
        process,
      });
    } catch (error) {
      channel.active = undefined;
      process.dispose();
      finalizer?.();
      throw error;
    }
    options.onTerminalAssigned?.(before.channelId);
    preparedCommand.start();
    const completion = process.completion.then(
      () => this.finishActive(channel, commandId),
      (error) => {
        this.finishActive(channel, commandId);
        throw error;
      },
    );

    if (options.background) {
      options.onCommandFinalizationDeferred?.();
      void completion.catch((error) =>
        this.log?.(
          `[native-agent-terminal] Background command failed: ${error}`,
        ),
      );
      return this.backgroundResult(channel, commandId);
    }

    if (options.timeout !== undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        completion.then(() => false),
        new Promise<true>((resolve) => {
          timer = setTimeout(() => resolve(true), options.timeout);
          timer.unref();
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (timedOut) {
        options.onCommandFinalizationDeferred?.();
        void completion.catch((error) =>
          this.log?.(
            `[native-agent-terminal] Timed-out command failed: ${error}`,
          ),
        );
        return {
          ...this.backgroundResult(channel, commandId),
          timed_out: true,
        };
      }
    }

    await completion;
    const snapshot = channel.session.snapshot();
    const completed = snapshot.commands.find(
      (candidate) => candidate.commandId === commandId,
    );
    if (!completed) {
      throw new Error(
        "Native Agent command completed without a command record",
      );
    }
    return this.completedResult(snapshot, completed);
  }

  private resolveChannel(
    options: TerminalExecuteOptions,
  ): ManagedNativeChannel {
    if (options.terminal_id) {
      const existing = this.channels.get(options.terminal_id);
      if (!existing) {
        throw new Error(
          `Native Agent terminal not found: ${options.terminal_id}`,
        );
      }
      return existing;
    }
    if (options.split_from && !this.channels.has(options.split_from)) {
      throw new Error(
        `Native Agent split source not found: ${options.split_from}`,
      );
    }
    if (options.terminal_name) {
      const named = [...this.channels.values()].find(
        ({ session }) => session.snapshot().title === options.terminal_name,
      );
      return named ?? this.createChannel(options.terminal_name, options.cwd);
    }
    if (options.split_from) {
      return this.createChannel(DEFAULT_AGENTLINK_TITLE, options.cwd);
    }
    const envKey = environmentKey(options.env);
    const idle = [...this.channels.values()].find(
      ({ session, envKey: current }) => {
        const snapshot = session.snapshot();
        return (
          snapshot.status === "idle" &&
          !this.reservations.has(snapshot.channelId) &&
          snapshot.cwd === options.cwd &&
          (current === undefined || current === envKey)
        );
      },
    );
    return idle ?? this.createChannel(DEFAULT_AGENTLINK_TITLE, options.cwd);
  }

  private createChannel(title: string, cwd: string): ManagedNativeChannel {
    const channelId = this.createChannelId();
    if (
      !channelId ||
      channelId.includes("\0") ||
      !channelId.startsWith("native-agent-") ||
      this.channels.has(channelId)
    ) {
      throw new Error(
        "createChannelId must return a unique native-agent-* ID without NUL",
      );
    }
    const session = new SandboxTerminalSession({
      channelId,
      title,
      initialCwd: cwd || this.options.initialCwd,
      dimensions: this.dimensions,
      now: this.now,
    });
    const channel: ManagedNativeChannel = { session };
    session.onEvent((event) => {
      const snapshot = session.snapshot();
      const update: NativeAgentTerminalChannelEvent = { event, snapshot };
      for (const listener of this.channelListeners) listener(update);
    });
    this.channels.set(channelId, channel);
    return channel;
  }

  private handleRuntimeChannelClosed(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    const snapshot = channel.session.snapshot();
    if (snapshot.status === "closed") return;
    channel.session.close();
    channel.active?.finalizer?.();
    this.channels.delete(channelId);
    this.reservations.delete(channelId);
    this.rememberClosed(snapshot);
  }

  private backgroundResult(
    channel: ManagedNativeChannel,
    commandId: string,
  ): TerminalCommandResult {
    const snapshot = channel.session.snapshot();
    const command = snapshot.commands.find(
      (candidate) => candidate.commandId === commandId,
    );
    return {
      exit_code: null,
      output: cleanTerminalOutput(command?.output ?? ""),
      terminal_raw_output: cleanTerminalRawOutput(command?.output ?? ""),
      output_captured: true,
      terminal_id: snapshot.channelId,
      terminal_name: snapshot.title,
      cwd: snapshot.cwd,
      command: command?.command,
      backgrounded: true,
      is_running:
        command?.status === "launching" || command?.status === "running",
      execution_mode: "native_pty",
      command_sent: command !== undefined,
      process_launched: command?.startedAt !== undefined,
      retry_safe: command === undefined,
    };
  }

  private completedResult(
    snapshot: SandboxTerminalSessionSnapshot,
    command: SandboxTerminalSessionSnapshot["commands"][number],
  ): TerminalCommandResult {
    return {
      exit_code: command.exitCode ?? null,
      output: cleanTerminalOutput(command.output),
      terminal_raw_output: cleanTerminalRawOutput(command.output),
      output_captured: true,
      terminal_id: snapshot.channelId,
      terminal_name: snapshot.title,
      cwd: snapshot.cwd,
      command: command.command,
      is_running: false,
      execution_mode: "native_pty",
      command_sent: true,
      process_launched: command.startedAt !== undefined,
      retry_safe: false,
    };
  }

  private finishActive(channel: ManagedNativeChannel, commandId: string): void {
    if (channel.active?.commandId !== commandId) return;
    channel.active.finalizer?.();
    channel.active = undefined;
  }

  private backgroundStateFromSnapshot(
    snapshot: SandboxTerminalSessionSnapshot,
    closed = false,
  ): TerminalBackgroundState {
    const command = snapshot.commands.at(-1);
    if (!command) {
      return {
        is_running: false,
        state: "completed",
        exit_code: null,
        output: "",
        output_captured: true,
      };
    }
    const running =
      command.status === "launching" || command.status === "running";
    return {
      is_running: !closed && running,
      state: running
        ? closed
          ? "unknown_termination"
          : "running"
        : command.status === "exited"
          ? "completed"
          : "unknown_termination",
      exit_code:
        command.status === "exited" ? (command.exitCode ?? null) : null,
      output: cleanTerminalOutput(command.output),
      output_captured: true,
      terminal_raw_output: cleanTerminalRawOutput(command.output),
    };
  }

  private rememberClosed(snapshot: SandboxTerminalSessionSnapshot): void {
    this.recentlyClosed.unshift({
      id: snapshot.channelId,
      name: snapshot.title,
      closedAt: this.now(),
      ...this.backgroundStateFromSnapshot(snapshot, true),
    });
    this.recentlyClosed.splice(DEFAULT_RECENTLY_CLOSED_LIMIT);
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("Native Agent terminal coordinator is disposed");
    }
  }
}
