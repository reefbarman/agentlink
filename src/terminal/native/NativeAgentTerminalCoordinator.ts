import {
  sameTerminalOwnerScope,
  type ClosedTerminalSnapshot,
  NativePreparingTerminalProvider,
  PreparedTerminalExecution,
  TerminalBackgroundState,
  TerminalCloseResult,
  TerminalCommandResult,
  TerminalExecuteOptions,
  TerminalExecutionOwner,
  TerminalInteractivePromptDetection,
  TerminalMetadata,
  TerminalOutputRequest,
  TerminalRecentlyClosedRequest,
  TerminalRetainedOutput,
  TerminalRetainedOutputLease,
  TerminalRetainedOutputMetadata,
  TerminalTargetRequest,
  TerminalListRequest,
  TerminalCloseRequest,
} from "../../core/capabilities/terminal.js";
import type { TerminalDimensions } from "@agentlink/protocol/terminal";
import type { TerminalExecutionSecuritySummary } from "@agentlink/protocol/terminal-security";
import { buildAgentExecutionEnv } from "../../process/agentExecutionPolicy.js";
import {
  cleanTerminalOutput,
  cleanTerminalRawOutput,
} from "../../util/ansi.js";
import type { NodePtyModuleLoader } from "../deferredNodePtyLoader.js";
import {
  clearInteractivePromptWatchdog,
  createInteractivePromptWatchdog,
  observeInteractivePrompt,
  type InteractivePromptWatchdog,
} from "../interactivePromptWatchdog.js";
import { TerminalAdmissionQueue } from "../terminalAdmissionQueue.js";
import type { MaterializedHostShellBootstrap } from "../hostShellBootstrap.js";
import type { SandboxCommandProcess } from "../sandbox/SandboxRuntimeProvider.js";
import {
  SandboxTerminalSession,
  type SandboxTerminalCommandOutput,
  type SandboxTerminalCommandOutputLease,
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
const MAX_IMPLICIT_CHANNELS_PER_OWNER = 4;
const MAX_DETACHED_IMPLICIT_CHANNELS_PER_OWNER = 8;
const MAX_IMPLICIT_ADMISSION_WAITERS_PER_OWNER = 16;
const IMPLICIT_ADMISSION_TIMEOUT_MS = 30_000;
const EXHAUSTED_COMMAND_LABEL_LIMIT = 60;

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
  owner?: TerminalExecutionOwner;
  envKey?: string;
  implicit: boolean;
  lastUsedAt: number;
  active?: {
    commandId: string;
    process: SandboxCommandProcess;
    finalizer?: () => void;
    interactivePromptWatchdog?: InteractivePromptWatchdog;
    detachForeground?: () => void;
    background: boolean;
    /** Implicit channel released from the foreground pool while this command runs. */
    detachedFromPool: boolean;
  };
  latestTermination?: {
    commandId: string;
    reason: "interactive_prompt";
    detection: TerminalInteractivePromptDetection;
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

function ownerScopeKey(owner: TerminalExecutionOwner | undefined): string {
  return owner ? `${owner.scopeId}\0${owner.generation}` : "ownerless";
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

function describeBlockingChannels(
  channels: Array<{ session: SandboxTerminalSession }>,
): string {
  if (channels.length === 0) return "concurrent commands";
  return channels
    .map(({ session }) => {
      const snapshot = session.snapshot();
      const running =
        snapshot.status === "launching" || snapshot.status === "running";
      const command = snapshot.commands.at(-1)?.command;
      if (!running || !command) return snapshot.channelId;
      const singleLine = command.replace(/\s+/g, " ").trim();
      const label =
        singleLine.length > EXHAUSTED_COMMAND_LABEL_LIMIT
          ? `${singleLine.slice(0, EXHAUSTED_COMMAND_LABEL_LIMIT - 3)}...`
          : singleLine;
      return `${snapshot.channelId} (running \`${label}\`)`;
    })
    .join(", ");
}

export class NativeAgentTerminalCoordinator implements NativePreparingTerminalProvider {
  private readonly dimensions: TerminalDimensions;
  private readonly createChannelId: () => string;
  private readonly createCommandId: () => string;
  private readonly now: () => number;
  private readonly runtime: NativeAgentRuntimeProvider;
  private readonly channels = new Map<string, ManagedNativeChannel>();
  private readonly recentlyClosed: ClosedTerminalSnapshot[] = [];
  private readonly recentlyClosedOutput = new Map<
    string,
    SandboxTerminalCommandOutputLease
  >();
  private readonly channelListeners = new Set<
    (update: NativeAgentTerminalChannelEvent) => void
  >();
  private readonly rawDataListeners = new Set<
    (update: NativeAgentTerminalRawDataEvent) => void
  >();
  private readonly disposeListeners = new Set<() => void>();
  private readonly reservations = new Map<string, symbol>();
  private readonly admissions = new TerminalAdmissionQueue();
  private nextChannelNumber = 1;
  private nextCommandNumber = 1;
  private disposed = false;
  private retired = false;
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
    const reservation = Symbol("native-agent-preparation");
    const resolved = this.resolveChannel(descriptor, reservation);
    const channel = resolved instanceof Promise ? await resolved : resolved;
    const before = channel.session.snapshot();
    if (
      before.status === "launching" ||
      before.status === "running" ||
      (this.reservations.has(before.channelId) &&
        this.reservations.get(before.channelId) !== reservation)
    ) {
      throw new Error(`Native Agent terminal ${before.channelId} is busy`);
    }
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
          this.notifyAdmission(channel.owner);
          throw new Error("Prepared Native Agent terminal target changed");
        }
        state = "consumed";
        try {
          const result = await this.executeOnChannel(
            descriptor,
            channel,
            before,
            reservation,
          );
          return { ...result, security };
        } finally {
          if (this.reservations.get(before.channelId) === reservation) {
            this.reservations.delete(before.channelId);
            this.notifyAdmission(channel.owner);
          }
        }
      },
      dispose: () => {
        if (state !== "prepared") return;
        state = "disposed";
        if (this.reservations.get(before.channelId) === reservation) {
          this.reservations.delete(before.channelId);
          this.notifyAdmission(channel.owner);
        }
      },
    };
  }

  async executeCommand(
    options: TerminalExecuteOptions,
  ): Promise<TerminalCommandResult> {
    const descriptor = snapshotOptions(options);
    const reservation = Symbol("native-agent-execution");
    const resolved = this.resolveChannel(descriptor, reservation);
    const channel = resolved instanceof Promise ? await resolved : resolved;
    const before = channel.session.snapshot();
    if (
      before.status === "launching" ||
      before.status === "running" ||
      (this.reservations.has(before.channelId) &&
        this.reservations.get(before.channelId) !== reservation)
    ) {
      throw new Error(`Native Agent terminal ${before.channelId} is busy`);
    }
    this.reservations.set(before.channelId, reservation);
    try {
      return await this.executeOnChannel(
        descriptor,
        channel,
        before,
        reservation,
      );
    } finally {
      if (this.reservations.get(before.channelId) === reservation) {
        this.reservations.delete(before.channelId);
        this.notifyAdmission(channel.owner);
      }
    }
  }

  getBackgroundState(
    request: TerminalTargetRequest,
  ): TerminalBackgroundState | undefined {
    const channel = this.ownedChannel(request.terminalId, request.owner);
    return channel
      ? this.backgroundStateFromSnapshot(
          channel.session.snapshot(),
          false,
          channel.latestTermination,
        )
      : undefined;
  }

  getCurrentOutput(request: TerminalOutputRequest): string | undefined {
    // Native output is already held in the in-memory session; there is no
    // external shell-integration buffer to flush when force is requested.
    const snapshot = this.ownedChannel(
      request.terminalId,
      request.owner,
    )?.session.snapshot();
    return snapshot
      ? cleanTerminalOutput(snapshot.commands.at(-1)?.output ?? "")
      : undefined;
  }

  getRetainedOutput(
    request: TerminalTargetRequest,
  ): TerminalRetainedOutput | undefined {
    const channel = this.ownedChannel(request.terminalId, request.owner);
    if (channel) {
      const commandId = channel.session.snapshot().commands.at(-1)?.commandId;
      return commandId
        ? this.retainedOutput(channel.session.getCommandOutput(commandId))
        : undefined;
    }
    return this.retainedOutput(
      this.ownedClosedTerminal(request.terminalId, request.owner)
        ? this.recentlyClosedOutput.get(request.terminalId)?.read()
        : undefined,
    );
  }

  detachRetainedOutput(
    request: TerminalTargetRequest,
  ): TerminalRetainedOutputLease | undefined {
    if (!this.ownedClosedTerminal(request.terminalId, request.owner)) {
      return undefined;
    }
    const lease = this.recentlyClosedOutput.get(request.terminalId);
    if (!lease) return undefined;
    this.recentlyClosedOutput.delete(request.terminalId);
    return this.retainedOutputLease(lease);
  }

  interruptTerminal(request: TerminalTargetRequest): boolean {
    const channel = this.ownedChannel(request.terminalId, request.owner);
    clearInteractivePromptWatchdog(channel?.active?.interactivePromptWatchdog);
    return channel !== undefined && this.runtime.interrupt(request.terminalId);
  }

  detachTerminal(request: TerminalTargetRequest): boolean {
    const active = this.ownedChannel(request.terminalId, request.owner)?.active;
    if (!active?.detachForeground) return false;
    const detach = active.detachForeground;
    active.detachForeground = undefined;
    detach();
    return true;
  }

  getRecentlyClosedTerminals(
    request: TerminalRecentlyClosedRequest,
  ): ClosedTerminalSnapshot[] {
    return this.recentlyClosed
      .filter((terminal) => this.matchesOwner(terminal.owner, request.owner))
      .slice(0, Math.max(0, request.limit ?? 5))
      .map((item) => ({ ...item }));
  }

  listTerminals(request: TerminalListRequest): TerminalMetadata[] {
    return [...this.channels.values()]
      .filter((channel) => this.matchesOwner(channel.owner, request.owner))
      .map(({ session, owner }) => {
        const snapshot = session.snapshot();
        return {
          id: snapshot.channelId,
          name: snapshot.title,
          busy:
            snapshot.status === "launching" ||
            snapshot.status === "running" ||
            this.reservations.has(snapshot.channelId),
          ...(owner ? { owner: { ...owner } } : {}),
        };
      });
  }

  closeTerminals(request: TerminalCloseRequest): TerminalCloseResult {
    const requested = request.names ? new Set(request.names) : undefined;
    const notFound = requested ? new Set(requested) : undefined;
    let closed = 0;
    for (const [channelId, channel] of this.channels) {
      if (!this.matchesOwner(channel.owner, request.owner)) continue;
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
      const commandId = snapshot.commands.at(-1)?.commandId;
      const outputLease = commandId
        ? channel.session.detachCommandOutput(commandId)
        : undefined;
      channel.session.close();
      this.disableInteractivePromptWatchdog(channel.active);
      channel.active?.finalizer?.();
      this.runtime.closeChannel(channelId);
      this.channels.delete(channelId);
      this.reservations.delete(channelId);
      this.notifyAdmission(channel.owner);
      this.rememberClosed(
        snapshot,
        channel.owner,
        outputLease,
        channel.latestTermination,
      );
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
    const channel = this.channels.get(channelId);
    clearInteractivePromptWatchdog(channel?.active?.interactivePromptWatchdog);
    return channel !== undefined && this.runtime.write(channelId, data);
  }

  resize(channelId: string, dimensions: TerminalDimensions): boolean {
    const channel = this.channels.get(channelId);
    if (!channel || !channel.session.resize(dimensions)) return false;
    return this.runtime.resize(channelId, dimensions);
  }

  retire(): void {
    if (this.retired || this.disposed) return;
    this.retired = true;
    this.admissions.retire();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.retired = true;
    for (const channel of this.channels.values()) {
      channel.session.close();
      this.disableInteractivePromptWatchdog(channel.active);
      channel.active?.finalizer?.();
      this.runtime.closeChannel(channel.session.channelId);
    }
    this.channels.clear();
    this.reservations.clear();
    this.admissions.retire();
    this.channelListeners.clear();
    this.rawDataListeners.clear();
    for (const lease of this.recentlyClosedOutput.values()) lease.dispose();
    this.recentlyClosedOutput.clear();
    this.runtime.dispose();
    for (const listener of this.disposeListeners) listener();
    this.disposeListeners.clear();
  }

  private async executeOnChannel(
    options: TerminalExecuteOptions,
    channel: ManagedNativeChannel,
    before: SandboxTerminalSessionSnapshot,
    reservation: symbol,
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
      if (!this.isReservedTarget(channel, before, reservation)) {
        await bootstrap.cleanup();
        throw new Error("Native Agent terminal target changed during startup");
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
      if (!this.isReservedTarget(channel, before, reservation)) {
        this.runtime.closeChannel(before.channelId);
        throw new Error("Native Agent terminal target changed during startup");
      }
      channel.envKey = envKey;
    }
    if (!this.isReservedTarget(channel, before, reservation)) {
      throw new Error("Native Agent terminal target changed during startup");
    }
    // Untargeted commands may reuse an implicit logical terminal for low startup
    // overhead, but each command runs in a shell subshell so aliases, exports,
    // PATH changes, `cd`, and `exit` cannot mutate the next unrelated command.
    // Explicitly named/targeted terminals retain intentional persistent-shell
    // semantics for user-directed workflows.
    const isolateShellState =
      channel.implicit &&
      options.terminal_id === undefined &&
      options.terminal_name === undefined &&
      options.split_from === undefined;
    const preparedCommand = this.runtime.createCommand({
      channelId: before.channelId,
      commandId,
      generation: before.nextGeneration,
      command: options.command,
      ...(isolateShellState ? { isolateShellState: true } : {}),
      onShellCommandEnd: () => {
        if (channel.active?.commandId === commandId) {
          this.disableInteractivePromptWatchdog(channel.active);
        }
      },
    });
    const process = preparedCommand.process;
    const finalizer = finalizedOnce(options.onCommandFinalized);
    let resolveDetach!: () => void;
    const detachPromise = new Promise<void>((resolve) => {
      resolveDetach = resolve;
    });
    const detachForeground = () => resolveDetach();
    channel.active = {
      commandId,
      process,
      finalizer,
      interactivePromptWatchdog: options.background
        ? undefined
        : createInteractivePromptWatchdog(),
      detachForeground: options.background ? undefined : detachForeground,
      background: options.background === true,
      detachedFromPool: false,
    };
    channel.latestTermination = undefined;
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
      this.disableInteractivePromptWatchdog(channel.active);
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
      this.detachImplicitFromPool(channel);
      options.onCommandFinalizationDeferred?.();
      void completion.catch((error) =>
        this.log?.(
          `[native-agent-terminal] Background command failed: ${error}`,
        ),
      );
      return this.backgroundResult(channel, commandId);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      completion.then(() => "completed" as const),
      detachPromise.then(() => "detached" as const),
      ...(options.timeout !== undefined
        ? [
            new Promise<"timed_out">((resolve) => {
              timer = setTimeout(() => resolve("timed_out"), options.timeout);
              timer.unref();
            }),
          ]
        : []),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
      if (channel.active?.detachForeground === detachForeground) {
        channel.active.detachForeground = undefined;
      }
    });

    if (outcome === "detached" && channel.active?.commandId === commandId) {
      this.disableInteractivePromptWatchdog(channel.active);
      channel.active.background = true;
      this.detachImplicitFromPool(channel);
      options.onCommandFinalizationDeferred?.();
      void completion.catch((error) =>
        this.log?.(
          `[native-agent-terminal] Background command failed: ${error}`,
        ),
      );
      return this.backgroundResult(channel, commandId);
    }

    if (outcome === "detached") await completion;

    if (outcome === "timed_out") {
      this.disableInteractivePromptWatchdog(channel.active);
      const timeoutSnapshot = channel.session.snapshot();
      const timedOutCommand = timeoutSnapshot.commands.find(
        (candidate) => candidate.commandId === commandId,
      );
      if (timedOutCommand?.status === "launching") {
        const retained = channel.session.getCommandOutput(commandId);
        const output = retained?.output ?? timedOutCommand.output;
        const result: TerminalCommandResult = {
          exit_code: null,
          output: cleanTerminalOutput(output),
          terminal_raw_output: cleanTerminalRawOutput(output),
          ...this.outputMetadata(retained),
          output_captured: true,
          terminal_id: timeoutSnapshot.channelId,
          terminal_name: timeoutSnapshot.title,
          cwd: timeoutSnapshot.cwd,
          command: timedOutCommand.command,
          timed_out: true,
          is_running: false,
          execution_mode: "native_pty",
          command_sent: true,
          process_launched: false,
          retry_safe: false,
          failure_stage: "launch",
          output_warning:
            "The command was submitted to the Native Agent terminal, but shell integration never confirmed command start before the timeout. The terminal was closed to avoid leaving an unknown running process.",
        };
        this.closeTerminals({
          owner: channel.owner,
          names: [timeoutSnapshot.channelId],
        });
        return result;
      }
      if (channel.active?.commandId === commandId) {
        channel.active.background = true;
        this.detachImplicitFromPool(channel);
      }
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
    const snapshot = channel.session.snapshot();
    const completed = snapshot.commands.find(
      (candidate) => candidate.commandId === commandId,
    );
    if (!completed) {
      throw new Error(
        "Native Agent command completed without a command record",
      );
    }
    return this.completedResult(
      channel,
      snapshot,
      completed,
      channel.session.getCommandOutput(commandId),
    );
  }

  private isReservedTarget(
    channel: ManagedNativeChannel,
    before: SandboxTerminalSessionSnapshot,
    reservation: symbol,
  ): boolean {
    const current = channel.session.snapshot();
    return (
      this.reservations.get(before.channelId) === reservation &&
      this.channels.get(before.channelId) === channel &&
      current.status === "idle" &&
      current.nextGeneration === before.nextGeneration
    );
  }

  private reuseChannel(
    channel: ManagedNativeChannel,
    owner: TerminalExecutionOwner | undefined,
  ): ManagedNativeChannel {
    channel.owner = owner ? Object.freeze({ ...owner }) : undefined;
    return channel;
  }

  private resolveChannel(
    options: TerminalExecuteOptions,
    reservation?: symbol,
  ): ManagedNativeChannel | Promise<ManagedNativeChannel> {
    if (options.terminal_id) {
      const existing = this.channels.get(options.terminal_id);
      if (!existing || !sameTerminalOwnerScope(existing.owner, options.owner)) {
        throw new Error(
          `Native Agent terminal not found: ${options.terminal_id}`,
        );
      }
      // Explicit selection opts this channel into stateful semantics. Remove a
      // formerly implicit channel from the unnamed pool so later unrelated
      // commands cannot inherit state intentionally added through terminal_id.
      existing.implicit = false;
      return this.reuseChannel(existing, options.owner);
    }
    if (
      options.split_from &&
      !this.ownedChannel(options.split_from, options.owner)
    ) {
      throw new Error(
        `Native Agent split source not found: ${options.split_from}`,
      );
    }
    if (options.terminal_name) {
      const named = [...this.channels.values()].find(
        ({ session, owner }) =>
          session.snapshot().title === options.terminal_name &&
          sameTerminalOwnerScope(owner, options.owner),
      );
      if (named) {
        // Naming an existing pooled channel likewise makes its persistence
        // intentional and excludes it from later unnamed reuse.
        named.implicit = false;
        return this.reuseChannel(named, options.owner);
      }
      return this.createChannel(
        options.terminal_name,
        options.cwd,
        options.owner,
      );
    }
    if (options.split_from) {
      return this.createChannel(
        options.terminal_creation_name ?? DEFAULT_AGENTLINK_TITLE,
        options.cwd,
        options.owner,
      );
    }

    const key = ownerScopeKey(options.owner);
    if (!this.admissions.hasPending(key)) {
      const channel = this.tryResolveImplicitChannel(options);
      if (channel) return channel;
    }
    return this.waitForImplicitAdmission(options, reservation, key);
  }

  private async waitForImplicitAdmission(
    options: TerminalExecuteOptions,
    reservation: symbol | undefined,
    key: string,
  ): Promise<ManagedNativeChannel> {
    this.log?.(
      "[native-agent-terminal] Waiting for implicit terminal admission",
    );
    for (;;) {
      const ticket = await this.admissions.wait({
        key,
        canAdmit: () => this.canResolveImplicitChannel(options),
        timeoutError: () => this.implicitPoolExhaustedError(options),
        signal: options.admissionSignal,
        timeoutMs: IMPLICIT_ADMISSION_TIMEOUT_MS,
        maxWaiters: MAX_IMPLICIT_ADMISSION_WAITERS_PER_OWNER,
      });
      try {
        const channel = this.tryResolveImplicitChannel(options);
        if (channel) {
          if (reservation) {
            this.reservations.set(channel.session.channelId, reservation);
          }
          ticket.consume();
          return channel;
        }
      } finally {
        ticket.release();
      }
    }
  }

  private implicitChannels(owner: TerminalExecutionOwner | undefined) {
    return [...this.channels.values()].filter(
      (channel) =>
        channel.implicit && sameTerminalOwnerScope(channel.owner, owner),
    );
  }

  private pooledImplicitChannels(owner: TerminalExecutionOwner | undefined) {
    return this.implicitChannels(owner).filter(
      (channel) => channel.active?.detachedFromPool !== true,
    );
  }

  private detachedImplicitChannels(owner: TerminalExecutionOwner | undefined) {
    return this.implicitChannels(owner).filter(
      (channel) => channel.active?.detachedFromPool === true,
    );
  }

  private detachImplicitFromPool(channel: ManagedNativeChannel): void {
    if (!channel.implicit || !channel.active) return;
    if (channel.active.detachedFromPool) return;
    if (
      this.detachedImplicitChannels(channel.owner).length >=
      MAX_DETACHED_IMPLICIT_CHANNELS_PER_OWNER
    ) {
      return;
    }
    channel.active.detachedFromPool = true;
    this.notifyAdmission(channel.owner);
  }

  private tryResolveImplicitChannel(
    options: TerminalExecuteOptions,
  ): ManagedNativeChannel | undefined {
    if (
      options.background &&
      this.detachedImplicitChannels(options.owner).length >=
        MAX_DETACHED_IMPLICIT_CHANNELS_PER_OWNER
    ) {
      return undefined;
    }
    const envKey = environmentKey(options.env);
    const pooledChannels = this.pooledImplicitChannels(options.owner);
    const idle = pooledChannels.find(({ session, envKey: current }) => {
      const snapshot = session.snapshot();
      return (
        snapshot.status === "idle" &&
        !this.reservations.has(snapshot.channelId) &&
        snapshot.cwd === options.cwd &&
        (current === undefined || current === envKey)
      );
    });
    if (idle) return this.reuseChannel(idle, options.owner);
    if (pooledChannels.length < MAX_IMPLICIT_CHANNELS_PER_OWNER) {
      return this.createChannel(
        options.terminal_creation_name ?? DEFAULT_AGENTLINK_TITLE,
        options.cwd,
        options.owner,
        true,
      );
    }
    const reclaimable = pooledChannels
      .filter(({ session }) => {
        const snapshot = session.snapshot();
        return (
          snapshot.status === "idle" &&
          !this.reservations.has(snapshot.channelId)
        );
      })
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
    if (!reclaimable) return undefined;
    this.reclaimImplicitChannel(reclaimable);
    return this.createChannel(
      options.terminal_creation_name ?? DEFAULT_AGENTLINK_TITLE,
      options.cwd,
      options.owner,
      true,
    );
  }

  private canResolveImplicitChannel(options: TerminalExecuteOptions): boolean {
    if (
      options.background &&
      this.detachedImplicitChannels(options.owner).length >=
        MAX_DETACHED_IMPLICIT_CHANNELS_PER_OWNER
    ) {
      return false;
    }
    const pooledChannels = this.pooledImplicitChannels(options.owner);
    return (
      pooledChannels.length < MAX_IMPLICIT_CHANNELS_PER_OWNER ||
      pooledChannels.some(({ session }) => {
        const snapshot = session.snapshot();
        return (
          snapshot.status === "idle" &&
          !this.reservations.has(snapshot.channelId)
        );
      })
    );
  }

  private implicitPoolExhaustedError(options: TerminalExecuteOptions): Error {
    if (options.background) {
      const detached = this.detachedImplicitChannels(options.owner);
      if (detached.length >= MAX_DETACHED_IMPLICIT_CHANNELS_PER_OWNER) {
        return new Error(
          `Native Agent background terminal limit reached (${detached.length} background commands running): ${describeBlockingChannels(detached)}. Wait for one to finish or kill it with its terminal_id.`,
        );
      }
    }
    const pooledChannels = this.pooledImplicitChannels(options.owner);
    const blocking = pooledChannels.filter((channel) => {
      const snapshot = channel.session.snapshot();
      return (
        snapshot.status === "launching" ||
        snapshot.status === "running" ||
        this.reservations.has(snapshot.channelId)
      );
    });
    return new Error(
      `Native Agent terminal pool exhausted by ${describeBlockingChannels(blocking.length > 0 ? blocking : pooledChannels)}. Wait for a command to finish or use get_terminal_output/kill with its terminal_id.`,
    );
  }

  private createChannel(
    title: string,
    cwd: string,
    owner: TerminalExecutionOwner | undefined,
    implicit = false,
  ): ManagedNativeChannel {
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
    const channel: ManagedNativeChannel = {
      session,
      ...(owner ? { owner: Object.freeze({ ...owner }) } : {}),
      implicit,
      lastUsedAt: this.now(),
    };
    session.onEvent((event) => {
      if (event.type === "data") {
        this.handleInteractivePromptOutput(channel, event);
      }
      const snapshot = session.snapshot();
      const update: NativeAgentTerminalChannelEvent = { event, snapshot };
      for (const listener of this.channelListeners) listener(update);
    });
    this.channels.set(channelId, channel);
    return channel;
  }

  private reclaimImplicitChannel(channel: ManagedNativeChannel): void {
    const snapshot = channel.session.snapshot();
    const commandId = snapshot.commands.at(-1)?.commandId;
    const outputLease = commandId
      ? channel.session.detachCommandOutput(commandId)
      : undefined;
    channel.session.close();
    this.disableInteractivePromptWatchdog(channel.active);
    channel.active?.finalizer?.();
    channel.active = undefined;
    this.runtime.closeChannel(snapshot.channelId);
    this.channels.delete(snapshot.channelId);
    this.reservations.delete(snapshot.channelId);
    this.notifyAdmission(channel.owner);
    if (commandId) {
      this.rememberClosed(
        snapshot,
        channel.owner,
        outputLease,
        channel.latestTermination,
      );
    }
  }

  private handleRuntimeChannelClosed(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    const snapshot = channel.session.snapshot();
    if (snapshot.status === "closed") return;
    const commandId = snapshot.commands.at(-1)?.commandId;
    const outputLease = commandId
      ? channel.session.detachCommandOutput(commandId)
      : undefined;
    channel.session.close();
    this.disableInteractivePromptWatchdog(channel.active);
    channel.active?.finalizer?.();
    this.channels.delete(channelId);
    this.reservations.delete(channelId);
    this.notifyAdmission(channel.owner);
    this.rememberClosed(
      snapshot,
      channel.owner,
      outputLease,
      channel.latestTermination,
    );
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
      process_launched: command?.readyAt !== undefined,
      retry_safe: command === undefined,
    };
  }

  private completedResult(
    channel: ManagedNativeChannel,
    snapshot: SandboxTerminalSessionSnapshot,
    command: SandboxTerminalSessionSnapshot["commands"][number],
    retained: SandboxTerminalCommandOutput | undefined,
  ): TerminalCommandResult {
    const output = retained?.output ?? command.output;
    return {
      exit_code: command.exitCode ?? null,
      output: cleanTerminalOutput(output),
      terminal_raw_output: cleanTerminalRawOutput(output),
      ...this.outputMetadata(retained),
      output_captured: true,
      terminal_id: snapshot.channelId,
      terminal_name: snapshot.title,
      cwd: snapshot.cwd,
      command: command.command,
      ...(channel.latestTermination?.commandId === command.commandId
        ? {
            termination_reason: channel.latestTermination.reason,
            interactive_prompt: { ...channel.latestTermination.detection },
          }
        : {}),
      is_running: false,
      execution_mode: "native_pty",
      command_sent: true,
      process_launched: command.readyAt !== undefined,
      retry_safe: false,
    };
  }

  private handleInteractivePromptOutput(
    channel: ManagedNativeChannel,
    event: Extract<SandboxTerminalSessionEvent, { type: "data" }>,
  ): void {
    const active = channel.active;
    const watchdog = active?.interactivePromptWatchdog;
    if (!active || !watchdog || active.commandId !== event.commandId) return;

    observeInteractivePrompt(watchdog, event.data, (detection) => {
      if (
        channel.active !== active ||
        active.interactivePromptWatchdog !== watchdog
      ) {
        return;
      }
      channel.latestTermination = {
        commandId: active.commandId,
        reason: "interactive_prompt",
        detection: { ...detection },
      };
      const terminated = active.process.terminate();
      if (!terminated) {
        channel.latestTermination = undefined;
        this.log?.(
          `[native-agent-terminal] Failed to terminate command ${active.commandId} after interactive prompt detection`,
        );
      }
    });
  }

  private disableInteractivePromptWatchdog(
    active: ManagedNativeChannel["active"] | undefined,
  ): void {
    clearInteractivePromptWatchdog(active?.interactivePromptWatchdog);
    if (active) active.interactivePromptWatchdog = undefined;
  }

  private finishActive(channel: ManagedNativeChannel, commandId: string): void {
    if (channel.active?.commandId !== commandId) return;
    this.disableInteractivePromptWatchdog(channel.active);
    channel.active.finalizer?.();
    channel.active = undefined;
    channel.lastUsedAt = this.now();
    this.notifyAdmission(channel.owner);
    if (channel.implicit) this.trimIdleImplicitChannels(channel.owner);
  }

  /**
   * Channels detached from the pool for background commands rejoin it as idle
   * once they finish; reclaim the oldest idle channels so the pool settles
   * back to its cap instead of accumulating idle shells.
   */
  private trimIdleImplicitChannels(
    owner: TerminalExecutionOwner | undefined,
  ): void {
    for (;;) {
      const pooledChannels = this.pooledImplicitChannels(owner);
      if (pooledChannels.length <= MAX_IMPLICIT_CHANNELS_PER_OWNER) return;
      const oldestIdle = pooledChannels
        .filter(({ session }) => {
          const snapshot = session.snapshot();
          return (
            snapshot.status === "idle" &&
            !this.reservations.has(snapshot.channelId)
          );
        })
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!oldestIdle) return;
      this.reclaimImplicitChannel(oldestIdle);
    }
  }

  private notifyAdmission(owner: TerminalExecutionOwner | undefined): void {
    this.admissions.notify(ownerScopeKey(owner));
  }

  private backgroundStateFromSnapshot(
    snapshot: SandboxTerminalSessionSnapshot,
    closed = false,
    termination?: ManagedNativeChannel["latestTermination"],
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
      state:
        termination?.commandId === command.commandId
          ? "interactive_prompt"
          : running
            ? closed
              ? "unknown_termination"
              : "running"
            : command.status === "exited"
              ? command.timedOut
                ? "timed_out"
                : "completed"
              : "unknown_termination",
      exit_code:
        command.status === "exited" ? (command.exitCode ?? null) : null,
      output: cleanTerminalOutput(command.output),
      output_captured: true,
      terminal_raw_output: cleanTerminalRawOutput(command.output),
      ...(termination?.commandId === command.commandId
        ? {
            termination_reason: termination.reason,
            interactive_prompt: { ...termination.detection },
          }
        : {}),
    };
  }

  private retainedOutput(
    retained: SandboxTerminalCommandOutput | undefined,
  ): TerminalRetainedOutput | undefined {
    if (!retained) return undefined;
    return {
      output: cleanTerminalOutput(retained.output),
      complete: retained.complete,
      finalized: retained.finalized,
      total_bytes: retained.totalBytes,
      retained_bytes: retained.retainedBytes,
      dropped_bytes: retained.droppedBytes,
    };
  }

  private retainedOutputMetadata(
    retained: Omit<SandboxTerminalCommandOutput, "output">,
  ): TerminalRetainedOutputMetadata {
    return {
      complete: retained.complete,
      finalized: retained.finalized,
      total_bytes: retained.totalBytes,
      retained_bytes: retained.retainedBytes,
      dropped_bytes: retained.droppedBytes,
    };
  }

  private retainedOutputLease(
    lease: SandboxTerminalCommandOutputLease,
  ): TerminalRetainedOutputLease {
    return {
      metadata: () => this.retainedOutputMetadata(lease.metadata()),
      read: () => this.retainedOutput(lease.read())!,
      dispose: () => lease.dispose(),
    };
  }

  private outputMetadata(
    retained: Omit<SandboxTerminalCommandOutput, "output"> | undefined,
  ): Pick<
    TerminalCommandResult,
    | "output_complete"
    | "output_finalized"
    | "output_total_bytes"
    | "output_retained_bytes"
    | "output_dropped_bytes"
  > {
    return retained
      ? {
          output_complete: retained.complete,
          output_finalized: retained.finalized,
          output_total_bytes: retained.totalBytes,
          output_retained_bytes: retained.retainedBytes,
          output_dropped_bytes: retained.droppedBytes,
        }
      : {};
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

  private ownedChannel(
    terminalId: string,
    owner: TerminalExecutionOwner | undefined,
  ): ManagedNativeChannel | undefined {
    const channel = this.channels.get(terminalId);
    return channel && this.matchesOwner(channel.owner, owner)
      ? channel
      : undefined;
  }

  private ownedClosedTerminal(
    terminalId: string,
    owner: TerminalExecutionOwner | undefined,
  ): ClosedTerminalSnapshot | undefined {
    return this.recentlyClosed.find(
      (terminal) =>
        terminal.id === terminalId && this.matchesOwner(terminal.owner, owner),
    );
  }

  private rememberClosed(
    snapshot: SandboxTerminalSessionSnapshot,
    owner: TerminalExecutionOwner | undefined,
    outputLease?: SandboxTerminalCommandOutputLease,
    termination?: ManagedNativeChannel["latestTermination"],
  ): void {
    if (outputLease)
      this.recentlyClosedOutput.set(snapshot.channelId, outputLease);
    this.recentlyClosed.unshift({
      id: snapshot.channelId,
      name: snapshot.title,
      closedAt: this.now(),
      ...(owner ? { owner: { ...owner } } : {}),
      ...this.backgroundStateFromSnapshot(snapshot, true, termination),
      ...this.outputMetadata(outputLease?.metadata()),
    });
    const removed = this.recentlyClosed.splice(DEFAULT_RECENTLY_CLOSED_LIMIT);
    for (const terminal of removed) {
      this.recentlyClosedOutput.get(terminal.id)?.dispose();
      this.recentlyClosedOutput.delete(terminal.id);
    }
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("Native Agent terminal coordinator is disposed");
    }
    if (this.retired) {
      throw new Error("Native Agent terminal coordinator is retired");
    }
  }
}
