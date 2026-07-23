import {
  type ClosedTerminalSnapshot,
  type ConfinementPreparingTerminalProvider,
  type ManagedNetworkRequest,
  type PreparedTerminalExecution,
  type TerminalBackgroundState,
  type TerminalCloseResult,
  type TerminalCommandResult,
  type TerminalExecutionSecuritySummary,
  type TerminalExecuteOptions,
  type TerminalInteractivePromptDetection,
  type TerminalMetadata,
  type TerminalRetainedOutput,
  type TerminalRetainedOutputLease,
  type TerminalRetainedOutputMetadata,
} from "../../core/capabilities/terminal.js";
import type {
  SandboxExecutionMetadata,
  SandboxLaunchAuthorization,
} from "../../core/sandboxPolicy.js";
import type { TerminalDimensions } from "../../core/terminalProtocol.js";
import {
  detectInteractivePrompt,
  INTERACTIVE_PROMPT_MAX_INPUT_CHARS,
} from "../interactivePromptDetector.js";
import {
  cleanTerminalOutput,
  cleanTerminalRawOutput,
} from "../../util/ansi.js";
import type { SandboxHelperLaunchRequest } from "./sandboxHelperProtocol.js";
import type {
  SandboxCommandProcess,
  SandboxRuntimeProvider,
} from "./SandboxRuntimeProvider.js";
import {
  SandboxTerminalSession,
  type SandboxCommandOrigin,
  type SandboxTerminalCommandOutput,
  type SandboxTerminalCommandOutputLease,
  type SandboxTerminalSessionEvent,
  type SandboxTerminalSessionSnapshot,
} from "./SandboxTerminalSession.js";

const DEFAULT_DIMENSIONS: TerminalDimensions = { columns: 80, rows: 24 };
const DEFAULT_RECENTLY_CLOSED_LIMIT = 20;
const DEFAULT_SANDBOX_TITLE = "Agent command";
export const SANDBOX_INTERACTIVE_PROMPT_GRACE_MS = 1_500;

export interface AuthorizedSandboxLaunch {
  authorization: SandboxLaunchAuthorization;
  helperRequest: SandboxHelperLaunchRequest;
  metadata: SandboxExecutionMetadata;
  assertLaunchValid?: () => void;
  finalize?: () => void;
}

export interface SandboxLaunchAuthorizer {
  authorize(input: {
    options: TerminalExecuteOptions;
    channelId: string;
    commandId: string;
    generation: number;
    dimensions: TerminalDimensions;
  }): Promise<AuthorizedSandboxLaunch>;
}

export interface SandboxTerminalChannelEvent {
  event: SandboxTerminalSessionEvent;
  snapshot: SandboxTerminalSessionSnapshot;
}

export interface SandboxTerminalCoordinatorOptions {
  runtime: SandboxRuntimeProvider;
  authorizer: SandboxLaunchAuthorizer;
  initialCwd: string;
  dimensions?: TerminalDimensions;
  createChannelId?: () => string;
  createCommandId?: () => string;
  now?: () => number;
  isAllowedCwd?: (cwd: string) => boolean;
  onChannelChanged?: (snapshot: SandboxTerminalSessionSnapshot) => void;
  log?: (message: string) => void;
}

interface ManagedSandboxChannel {
  session: SandboxTerminalSession;
  active?: {
    commandId: string;
    generation: number;
    process: SandboxCommandProcess;
    metadata: SandboxExecutionMetadata;
    finalizer?: () => void;
    networkAbortController: AbortController;
    onManagedNetworkRequest?: TerminalExecuteOptions["onManagedNetworkRequest"];
    networkContext: Pick<
      ManagedNetworkRequest,
      "sessionId" | "terminalId" | "command" | "cwd" | "reason"
    > & {
      auditId?: string;
    };
    interactivePromptWatchdog?: {
      outputTail: string;
      timer?: ReturnType<typeof setTimeout>;
    };
  };
  latestMetadata?: SandboxExecutionMetadata;
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

export class SandboxTerminalCoordinator implements ConfinementPreparingTerminalProvider {
  private readonly runtime: SandboxRuntimeProvider;
  private readonly authorizer: SandboxLaunchAuthorizer;
  private readonly initialCwd: string;
  private readonly dimensions: TerminalDimensions;
  private readonly createChannelId: () => string;
  private readonly createCommandId: () => string;
  private readonly now: () => number;
  private readonly isAllowedCwd: (cwd: string) => boolean;
  private readonly onChannelChanged?: (
    snapshot: SandboxTerminalSessionSnapshot,
  ) => void;
  private readonly channels = new Map<string, ManagedSandboxChannel>();
  private readonly recentlyClosed: ClosedTerminalSnapshot[] = [];
  private readonly recentlyClosedOutput = new Map<
    string,
    SandboxTerminalCommandOutputLease
  >();
  private readonly channelListeners = new Set<
    (update: SandboxTerminalChannelEvent) => void
  >();
  private readonly disposeListeners = new Set<() => void>();
  private readonly channelReservations = new Map<string, symbol>();
  private nextChannelNumber = 1;
  private nextCommandNumber = 1;
  private disposed = false;
  log?: (message: string) => void;

  constructor(options: SandboxTerminalCoordinatorOptions) {
    this.runtime = options.runtime;
    this.authorizer = options.authorizer;
    this.initialCwd = options.initialCwd;
    this.dimensions = { ...(options.dimensions ?? DEFAULT_DIMENSIONS) };
    this.createChannelId =
      options.createChannelId ?? (() => `sandbox-${this.nextChannelNumber++}`);
    this.createCommandId =
      options.createCommandId ?? (() => `command-${this.nextCommandNumber++}`);
    this.now = options.now ?? Date.now;
    this.isAllowedCwd = options.isAllowedCwd ?? (() => true);
    this.onChannelChanged = options.onChannelChanged;
    this.log = options.log;
  }

  async prepareConfinementExecution(
    options: TerminalExecuteOptions,
    security: TerminalExecutionSecuritySummary,
  ): Promise<PreparedTerminalExecution> {
    this.assertActive();
    const descriptor = this.snapshotOptions(options);
    const reservation = Symbol("sandbox-preparation");
    const prepared = await this.prepareAuthorizedLaunch(
      descriptor,
      reservation,
    );
    let state: "prepared" | "consumed" | "disposed" = "prepared";
    const preparedSecurity: TerminalExecutionSecuritySummary = Object.freeze({
      ...security,
      ...(security.sandbox
        ? {
            sandbox: Object.freeze({
              ...security.sandbox,
              policyVersion: prepared.authorized.metadata.policyVersion,
              profileId: prepared.authorized.metadata.profileId,
              backend: prepared.authorized.metadata.backend as "seatbelt",
              capabilities: Object.freeze({
                ...prepared.authorized.metadata.capabilities,
                warnings: Object.freeze([
                  ...prepared.authorized.metadata.capabilities.warnings,
                ]) as unknown as string[],
              }),
              ...(prepared.authorized.metadata.grant
                ? {
                    grant: Object.freeze({
                      ...prepared.authorized.metadata.grant,
                    }),
                  }
                : {}),
              ...(prepared.authorized.metadata.capabilityRequest
                ? {
                    capabilityRequest: Object.freeze({
                      ...prepared.authorized.metadata.capabilityRequest,
                    }),
                  }
                : {}),
              ...(prepared.authorized.metadata.environmentPolicy
                ? {
                    environmentPolicy: Object.freeze({
                      ...prepared.authorized.metadata.environmentPolicy,
                      exclude: Object.freeze([
                        ...prepared.authorized.metadata.environmentPolicy
                          .exclude,
                      ]) as unknown as string[],
                      setKeys: Object.freeze([
                        ...prepared.authorized.metadata.environmentPolicy
                          .setKeys,
                      ]) as unknown as string[],
                      includeOnly: Object.freeze([
                        ...prepared.authorized.metadata.environmentPolicy
                          .includeOnly,
                      ]) as unknown as string[],
                    }),
                  }
                : {}),
            }),
          }
        : {}),
    });

    return {
      security: preparedSecurity,
      execute: async () => {
        if (state !== "prepared") {
          throw new Error("Prepared sandbox execution is no longer available");
        }
        if (
          this.channelReservations.get(prepared.before.channelId) !==
          reservation
        ) {
          state = "disposed";
          prepared.authorized.finalize?.();
          throw new Error("Prepared sandbox terminal reservation is stale");
        }
        const current = prepared.channel.session.snapshot();
        if (
          current.status === "launching" ||
          current.status === "running" ||
          current.status === "closed" ||
          current.nextGeneration !== prepared.before.nextGeneration
        ) {
          state = "disposed";
          this.channelReservations.delete(prepared.before.channelId);
          prepared.authorized.finalize?.();
          throw new Error("Prepared sandbox terminal target changed");
        }
        prepared.authorized.assertLaunchValid?.();
        state = "consumed";
        this.channelReservations.delete(prepared.before.channelId);
        const result = await this.executeAuthorized(
          descriptor,
          prepared,
          preparedSecurity,
        );
        return { ...result, security: preparedSecurity };
      },
      dispose: () => {
        if (state !== "prepared") return;
        state = "disposed";
        if (
          this.channelReservations.get(prepared.before.channelId) ===
          reservation
        ) {
          this.channelReservations.delete(prepared.before.channelId);
        }
        prepared.authorized.finalize?.();
      },
    };
  }

  async executeCommand(
    options: TerminalExecuteOptions,
  ): Promise<TerminalCommandResult> {
    const descriptor = this.snapshotOptions(options);
    const reservation = Symbol("sandbox-execution");
    const prepared = await this.prepareAuthorizedLaunch(
      descriptor,
      reservation,
    );
    try {
      return await this.executeAuthorized(descriptor, prepared);
    } finally {
      if (
        this.channelReservations.get(prepared.before.channelId) === reservation
      ) {
        this.channelReservations.delete(prepared.before.channelId);
      }
    }
  }

  private async executeAuthorized(
    options: TerminalExecuteOptions,
    prepared: {
      channel: ManagedSandboxChannel;
      before: SandboxTerminalSessionSnapshot;
      commandId: string;
      authorized: AuthorizedSandboxLaunch;
    },
    security?: TerminalExecutionSecuritySummary,
  ): Promise<TerminalCommandResult> {
    this.assertActive();
    const { channel, before, commandId, authorized } = prepared;
    const sandboxSessionId = options.sandboxSessionId as string;
    const networkAuditId =
      security?.auditId ?? authorized.metadata.grant?.auditId;
    let process: SandboxCommandProcess;
    try {
      if (
        authorized.helperRequest.network.mode === "public-proxy" &&
        !networkAuditId
      ) {
        throw new Error(
          "Managed sandbox networking requires command audit attribution",
        );
      }
      authorized.assertLaunchValid?.();
      process = this.runtime.launch(authorized.helperRequest);
    } catch (error) {
      authorized.finalize?.();
      throw error;
    }
    const finalizer = finalizedOnce(() => {
      try {
        options.onCommandFinalized?.();
      } finally {
        authorized.finalize?.();
      }
    });
    channel.active = {
      commandId,
      generation: authorized.helperRequest.generation,
      process,
      metadata: authorized.metadata,
      finalizer,
      networkAbortController: new AbortController(),
      onManagedNetworkRequest: options.onManagedNetworkRequest,
      networkContext: {
        sessionId: sandboxSessionId,
        auditId: networkAuditId,
        terminalId: before.channelId,
        command: options.command,
        cwd: options.cwd,
        reason: options.sandboxCapabilityRequest?.unrestrictedPublicNetwork
          ? "Managed public network requested"
          : undefined,
      },
      interactivePromptWatchdog: options.background
        ? undefined
        : { outputTail: "" },
    };
    channel.latestMetadata = authorized.metadata;
    channel.latestTermination = undefined;

    try {
      channel.session.startCommand({
        command: options.command,
        cwd: options.cwd,
        origin: this.originFor(sandboxSessionId),
        process,
      });
    } catch (error) {
      channel.active = undefined;
      process.dispose();
      finalizer?.();
      throw error;
    }
    options.onTerminalAssigned?.(before.channelId);
    const completion = process.completion.then(
      (exit) => {
        this.finishActive(channel, commandId);
        return exit;
      },
      (error) => {
        this.finishActive(channel, commandId);
        throw error;
      },
    );

    if (options.background) {
      options.onCommandFinalizationDeferred?.();
      void completion.catch((error) =>
        this.log?.(`[sandbox-terminal] Background command failed: ${error}`),
      );
      return this.backgroundResult(channel, commandId, authorized.metadata);
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
        this.disableInteractivePromptWatchdog(channel.active);
        channel.active?.networkAbortController.abort();
        options.onCommandFinalizationDeferred?.();
        void completion.catch((error) =>
          this.log?.(`[sandbox-terminal] Timed-out command failed: ${error}`),
        );
        return {
          ...this.backgroundResult(channel, commandId, authorized.metadata),
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
      throw new Error("Sandbox command completed without a command record");
    }
    return this.completedResult(
      channel,
      snapshot,
      completed,
      authorized.metadata,
      channel.session.getCommandOutput(commandId),
    );
  }

  private async prepareAuthorizedLaunch(
    options: TerminalExecuteOptions,
    reservation?: symbol,
  ): Promise<{
    channel: ManagedSandboxChannel;
    before: SandboxTerminalSessionSnapshot;
    commandId: string;
    authorized: AuthorizedSandboxLaunch;
  }> {
    this.assertActive();
    if (!options.sandboxSessionId) {
      throw new Error(
        "Sandbox command requires an owning AgentLink session ID",
      );
    }
    const channel = this.resolveChannel(options);
    const before = channel.session.snapshot();
    if (
      before.status === "launching" ||
      before.status === "running" ||
      this.channelReservations.has(before.channelId)
    ) {
      throw new Error(`Sandbox terminal ${before.channelId} is busy`);
    }
    if (reservation)
      this.channelReservations.set(before.channelId, reservation);
    const commandId = this.createCommandId();
    if (!commandId || commandId.includes("\0")) {
      if (reservation) this.channelReservations.delete(before.channelId);
      throw new Error("createCommandId must return a non-empty ID without NUL");
    }
    let authorized: AuthorizedSandboxLaunch;
    try {
      authorized = await this.authorizer.authorize({
        options,
        channelId: before.channelId,
        commandId,
        generation: before.nextGeneration,
        dimensions: before.dimensions,
      });
    } catch (error) {
      if (
        reservation &&
        this.channelReservations.get(before.channelId) === reservation
      ) {
        this.channelReservations.delete(before.channelId);
      }
      throw error;
    }
    if (
      authorized.helperRequest.channelId !== before.channelId ||
      authorized.helperRequest.commandId !== commandId ||
      authorized.helperRequest.generation !== before.nextGeneration
    ) {
      authorized.finalize?.();
      if (
        reservation &&
        this.channelReservations.get(before.channelId) === reservation
      ) {
        this.channelReservations.delete(before.channelId);
      }
      throw new Error(
        "Sandbox authorizer returned a mismatched command identity",
      );
    }
    return { channel, before, commandId, authorized };
  }

  private snapshotOptions(
    options: TerminalExecuteOptions,
  ): TerminalExecuteOptions {
    return Object.freeze({
      ...options,
      ...(options.env ? { env: Object.freeze({ ...options.env }) } : {}),
      ...(options.sandboxInlineFiles
        ? {
            sandboxInlineFiles: Object.freeze(
              options.sandboxInlineFiles.map((file) =>
                Object.freeze({ ...file }),
              ),
            ),
          }
        : {}),
      ...(options.sandboxCapabilityRequest
        ? {
            sandboxCapabilityRequest: Object.freeze({
              ...options.sandboxCapabilityRequest,
            }),
          }
        : {}),
    });
  }

  getBackgroundState(terminalId: string): TerminalBackgroundState | undefined {
    const channel = this.channels.get(terminalId);
    return channel
      ? this.backgroundStateFromSnapshot(
          channel.session.snapshot(),
          false,
          channel.latestTermination,
        )
      : undefined;
  }

  getRetainedOutput(terminalId: string): TerminalRetainedOutput | undefined {
    const channel = this.channels.get(terminalId);
    if (channel) {
      const commandId = channel.session.snapshot().commands.at(-1)?.commandId;
      return commandId
        ? this.retainedOutput(channel.session.getCommandOutput(commandId))
        : undefined;
    }
    return this.retainedOutput(
      this.recentlyClosedOutput.get(terminalId)?.read(),
    );
  }

  detachRetainedOutput(
    terminalId: string,
  ): TerminalRetainedOutputLease | undefined {
    const lease = this.recentlyClosedOutput.get(terminalId);
    if (!lease) return undefined;
    this.recentlyClosedOutput.delete(terminalId);
    return this.retainedOutputLease(lease);
  }

  interruptTerminal(terminalId: string): boolean {
    const channel = this.channels.get(terminalId);
    this.clearInteractivePromptWatchdog(channel?.active);
    return channel?.session.interrupt() ?? false;
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
      this.clearInteractivePromptWatchdog(channel.active);
      channel.active?.networkAbortController.abort();
      const commandId = snapshot.commands.at(-1)?.commandId;
      const outputLease = commandId
        ? channel.session.detachCommandOutput(commandId)
        : undefined;
      channel.session.close();
      channel.active?.finalizer?.();
      this.channels.delete(channelId);
      this.channelReservations.delete(channelId);
      this.rememberClosed(snapshot, outputLease, channel.latestTermination);
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

  onChannelEvent(listener: (update: SandboxTerminalChannelEvent) => void): {
    dispose(): void;
  } {
    this.assertActive();
    this.channelListeners.add(listener);
    return { dispose: () => this.channelListeners.delete(listener) };
  }

  onDispose(listener: () => void): { dispose(): void } {
    this.assertActive();
    this.disposeListeners.add(listener);
    return { dispose: () => this.disposeListeners.delete(listener) };
  }

  write(channelId: string, data: string): boolean {
    const channel = this.channels.get(channelId);
    this.clearInteractivePromptWatchdog(channel?.active);
    return channel?.session.write(data) ?? false;
  }

  resize(channelId: string, dimensions: TerminalDimensions): boolean {
    return this.channels.get(channelId)?.session.resize(dimensions) ?? false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const channel of this.channels.values()) {
      this.clearInteractivePromptWatchdog(channel.active);
      channel.active?.networkAbortController.abort();
      channel.session.close();
      channel.active?.finalizer?.();
    }
    this.channels.clear();
    this.channelReservations.clear();
    this.channelListeners.clear();
    for (const lease of this.recentlyClosedOutput.values()) lease.dispose();
    this.recentlyClosedOutput.clear();
    this.runtime.dispose();
    for (const listener of this.disposeListeners) listener();
    this.disposeListeners.clear();
  }

  private resolveChannel(
    options: TerminalExecuteOptions,
  ): ManagedSandboxChannel {
    if (options.terminal_id) {
      const existing = this.channels.get(options.terminal_id);
      if (!existing) {
        throw new Error(`Sandbox terminal not found: ${options.terminal_id}`);
      }
      return existing;
    }
    if (options.split_from && !this.channels.has(options.split_from)) {
      throw new Error(`Sandbox split source not found: ${options.split_from}`);
    }
    if (options.terminal_name) {
      const named = [...this.channels.values()].find(
        ({ session }) => session.snapshot().title === options.terminal_name,
      );
      return named ?? this.createChannel(options.terminal_name, options.cwd);
    }
    if (options.split_from) {
      return this.createChannel(DEFAULT_SANDBOX_TITLE, options.cwd);
    }
    const idleDefault = [...this.channels.values()].find(({ session }) => {
      const snapshot = session.snapshot();
      return (
        snapshot.status === "idle" &&
        !this.channelReservations.has(snapshot.channelId)
      );
    });
    return (
      idleDefault ?? this.createChannel(DEFAULT_SANDBOX_TITLE, options.cwd)
    );
  }

  private createChannel(title: string, cwd: string): ManagedSandboxChannel {
    const channelId = this.createChannelId();
    if (
      !channelId ||
      channelId.includes("\0") ||
      this.channels.has(channelId)
    ) {
      throw new Error("createChannelId must return a unique non-empty ID");
    }
    const session = new SandboxTerminalSession({
      channelId,
      title,
      initialCwd: cwd || this.initialCwd,
      dimensions: this.dimensions,
      now: this.now,
      isAllowedCwd: this.isAllowedCwd,
    });
    const channel: ManagedSandboxChannel = { session };
    session.onEvent((event) => {
      if (event.type === "network-request") {
        void this.handleManagedNetworkRequest(channel, event);
      } else if (event.type === "data") {
        this.handleInteractivePromptOutput(channel, event);
      }
      const snapshot = session.snapshot();
      this.onChannelChanged?.(snapshot);
      const update: SandboxTerminalChannelEvent = { event, snapshot };
      for (const listener of this.channelListeners) listener(update);
    });
    this.channels.set(channelId, channel);
    return channel;
  }

  private originFor(sandboxSessionId: string): SandboxCommandOrigin {
    return sandboxSessionId.startsWith("terminal-user:")
      ? "user"
      : sandboxSessionId.startsWith("terminal-ai:")
        ? "ai-staged"
        : "agent";
  }

  private backgroundResult(
    channel: ManagedSandboxChannel,
    commandId: string,
    metadata: SandboxExecutionMetadata,
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
      execution_mode: "sandbox_pty",
      command_sent: command !== undefined,
      process_launched: command?.startedAt !== undefined,
      retry_safe: command === undefined,
      sandbox: metadata,
    };
  }

  private completedResult(
    channel: ManagedSandboxChannel,
    snapshot: SandboxTerminalSessionSnapshot,
    command: SandboxTerminalSessionSnapshot["commands"][number],
    metadata: SandboxExecutionMetadata,
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
      timed_out: command.timedOut,
      ...(channel.latestTermination?.commandId === command.commandId
        ? {
            termination_reason: channel.latestTermination.reason,
            interactive_prompt: { ...channel.latestTermination.detection },
          }
        : {}),
      is_running: false,
      execution_mode: "sandbox_pty",
      command_sent: true,
      process_launched: command.startedAt !== undefined,
      retry_safe: false,
      sandbox: {
        ...metadata,
        violations: command.violations.map((violation) => ({ ...violation })),
      },
    };
  }

  private handleInteractivePromptOutput(
    channel: ManagedSandboxChannel,
    event: Extract<SandboxTerminalSessionEvent, { type: "data" }>,
  ): void {
    const active = channel.active;
    const watchdog = active?.interactivePromptWatchdog;
    if (
      !active ||
      !watchdog ||
      active.commandId !== event.commandId ||
      active.generation !== event.generation
    ) {
      return;
    }
    this.clearInteractivePromptWatchdog(active);
    watchdog.outputTail = `${watchdog.outputTail}${event.data}`.slice(
      -INTERACTIVE_PROMPT_MAX_INPUT_CHARS,
    );
    const detection = detectInteractivePrompt(watchdog.outputTail);
    if (detection?.confidence !== "high") return;

    watchdog.timer = setTimeout(() => {
      if (
        channel.active !== active ||
        active.interactivePromptWatchdog !== watchdog
      ) {
        return;
      }
      watchdog.timer = undefined;
      channel.latestTermination = {
        commandId: active.commandId,
        reason: "interactive_prompt",
        detection: { ...detection },
      };
      active.networkAbortController.abort();
      const terminated = active.process.terminate();
      if (!terminated) {
        channel.latestTermination = undefined;
        this.log?.(
          `[sandbox-terminal] Failed to terminate command ${active.commandId} after interactive prompt detection`,
        );
      }
    }, SANDBOX_INTERACTIVE_PROMPT_GRACE_MS);
    watchdog.timer.unref();
  }

  private clearInteractivePromptWatchdog(
    active: ManagedSandboxChannel["active"] | undefined,
  ): void {
    const watchdog = active?.interactivePromptWatchdog;
    if (!watchdog?.timer) return;
    clearTimeout(watchdog.timer);
    watchdog.timer = undefined;
  }

  private disableInteractivePromptWatchdog(
    active: ManagedSandboxChannel["active"] | undefined,
  ): void {
    this.clearInteractivePromptWatchdog(active);
    if (active) active.interactivePromptWatchdog = undefined;
  }

  private async handleManagedNetworkRequest(
    channel: ManagedSandboxChannel,
    event: Extract<SandboxTerminalSessionEvent, { type: "network-request" }>,
  ): Promise<void> {
    const active = channel.active;
    if (
      !active ||
      active.commandId !== event.commandId ||
      active.generation !== event.generation
    ) {
      return;
    }
    let decision: "allow-once" | "reject" = "reject";
    try {
      if (
        active.networkContext.auditId &&
        active.onManagedNetworkRequest &&
        !active.networkAbortController.signal.aborted
      ) {
        const networkContext = {
          ...active.networkContext,
          auditId: active.networkContext.auditId,
        };
        decision = await active.onManagedNetworkRequest(
          {
            ...networkContext,
            commandId: event.commandId,
            generation: event.generation,
            ...event.request,
            dnsAnswers: event.request.dnsAnswers.map((answer) => ({
              ...answer,
            })),
          },
          active.networkAbortController.signal,
        );
      }
    } catch (error) {
      this.log?.(`[sandbox-terminal] Network request review failed: ${error}`);
    }
    if (channel.active !== active) return;
    const responded = active.process.respondToNetworkRequest?.(
      event.request.requestId,
      active.networkAbortController.signal.aborted ? "reject" : decision,
    );
    if (responded !== true) {
      active.networkAbortController.abort();
      active.process.terminate();
    }
  }

  private finishActive(
    channel: ManagedSandboxChannel,
    commandId: string,
  ): void {
    if (channel.active?.commandId !== commandId) return;
    this.clearInteractivePromptWatchdog(channel.active);
    channel.active.networkAbortController.abort();
    channel.active.finalizer?.();
    channel.active = undefined;
  }

  private backgroundStateFromSnapshot(
    snapshot: SandboxTerminalSessionSnapshot,
    closed = false,
    termination?: ManagedSandboxChannel["latestTermination"],
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

  private rememberClosed(
    snapshot: SandboxTerminalSessionSnapshot,
    outputLease?: SandboxTerminalCommandOutputLease,
    termination?: ManagedSandboxChannel["latestTermination"],
  ): void {
    if (outputLease)
      this.recentlyClosedOutput.set(snapshot.channelId, outputLease);
    this.recentlyClosed.unshift({
      id: snapshot.channelId,
      name: snapshot.title,
      closedAt: this.now(),
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
    if (this.disposed)
      throw new Error("Sandbox terminal coordinator is disposed");
  }
}
