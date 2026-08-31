import {
  sameTerminalOwnerScope,
  type ClosedTerminalSnapshot,
  type ConfinementPreparingTerminalProvider,
  type PreparedTerminalExecution,
  type TerminalBackgroundState,
  type TerminalCloseResult,
  type TerminalCommandResult,
  type TerminalExecuteOptions,
  type TerminalExecutionOwner,
  type TerminalInteractivePromptDetection,
  type TerminalMetadata,
  type TerminalRecentlyClosedRequest,
  type TerminalRetainedOutput,
  type TerminalRetainedOutputLease,
  type TerminalRetainedOutputMetadata,
  type TerminalTargetRequest,
  type TerminalListRequest,
  type TerminalCloseRequest,
} from "../../core/capabilities/terminal.js";
import type { SandboxPolicy } from "../../core/sandboxPolicy.js";
import type { TerminalDimensions } from "@agentlink/protocol/terminal";
import type {
  ManagedNetworkRequest,
  SandboxExecutionMetadata,
  TerminalExecutionSecuritySummary,
} from "@agentlink/protocol/terminal-security";
import {
  clearInteractivePromptWatchdog,
  createInteractivePromptWatchdog,
  INTERACTIVE_PROMPT_GRACE_MS,
  observeInteractivePrompt,
  type InteractivePromptWatchdog,
} from "../interactivePromptWatchdog.js";
import {
  cleanTerminalOutput,
  cleanTerminalRawOutput,
} from "../../util/ansi.js";
import type {
  SandboxCommandIdentity,
  SandboxHelperLaunchRequest,
} from "./sandboxHelperProtocol.js";
import {
  SandboxPreCommandLaunchError,
  SandboxStructuralProtectionError,
  type SandboxCommandProcess,
  type SandboxRuntimeProvider,
} from "./SandboxRuntimeProvider.js";
import {
  SandboxTerminalSession,
  type SandboxCommandOrigin,
  type SandboxTerminalCommandOutput,
  type SandboxTerminalCommandOutputLease,
  type SandboxTerminalSessionEvent,
  type SandboxTerminalSessionSnapshot,
} from "./SandboxTerminalSession.js";
import { verifyTerminalInlineFiles } from "../inlineFileIntegrity.js";
import { TerminalAdmissionQueue } from "../terminalAdmissionQueue.js";

const DEFAULT_DIMENSIONS: TerminalDimensions = { columns: 80, rows: 24 };
const DEFAULT_RECENTLY_CLOSED_LIMIT = 20;
const DEFAULT_SANDBOX_TITLE = "Agent command";
const MAX_IMPLICIT_CHANNELS_PER_OWNER = 4;
const MAX_DETACHED_IMPLICIT_CHANNELS_PER_OWNER = 8;
const MAX_IMPLICIT_ADMISSION_WAITERS_PER_OWNER = 16;
const IMPLICIT_ADMISSION_TIMEOUT_MS = 30_000;
const EXHAUSTED_COMMAND_LABEL_LIMIT = 60;
export const SANDBOX_INTERACTIVE_PROMPT_GRACE_MS = INTERACTIVE_PROMPT_GRACE_MS;

export interface ActiveSandboxLaunch {
  helperRequest: SandboxHelperLaunchRequest;
  metadata: SandboxExecutionMetadata;
  assertLaunchValid?: () => void;
}

export interface PreparedSandboxLaunch {
  identity: SandboxCommandIdentity;
  /** Detached token-free preview; mutating it cannot affect the captured launch policy. */
  policy: SandboxPolicy;
  bindingDigest: string;
  metadata: SandboxExecutionMetadata;
  activate(): ActiveSandboxLaunch;
  finalize(): void;
}

export interface SandboxLaunchAuthorizer {
  authorize(input: {
    options: TerminalExecuteOptions;
    channelId: string;
    commandId: string;
    generation: number;
    dimensions: TerminalDimensions;
  }): Promise<PreparedSandboxLaunch>;
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
  owner?: TerminalExecutionOwner;
  envKey?: string;
  implicit: boolean;
  lastUsedAt: number;
  active?: {
    commandId: string;
    generation: number;
    process: SandboxCommandProcess;
    metadata: SandboxExecutionMetadata;
    finalizer?: () => void;
    networkAbortController: AbortController;
    networkReviewPendingCount: number;
    pauseTimeoutForNetworkReview?: () => void;
    resumeTimeoutAfterNetworkReview?: () => void;
    onManagedNetworkRequest?: TerminalExecuteOptions["onManagedNetworkRequest"];
    networkContext: Pick<
      ManagedNetworkRequest,
      "sessionId" | "terminalId" | "command" | "cwd" | "reason"
    > & {
      auditId?: string;
    };
    interactivePromptWatchdog?: InteractivePromptWatchdog;
    detachForeground?: () => void;
    background: boolean;
    /** Implicit channel released from the foreground pool while this command runs. */
    detachedFromPool: boolean;
  };
  latestMetadata?: SandboxExecutionMetadata;
  latestTermination?: {
    commandId: string;
    reason: "interactive_prompt";
    detection: TerminalInteractivePromptDetection;
  };
}

function ownerScopeKey(owner: TerminalExecutionOwner | undefined): string {
  return owner ? `${owner.scopeId}\0${owner.generation}` : "ownerless";
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
  private readonly admissions = new TerminalAdmissionQueue();
  private readonly admissionWaiters = new Map<string, number>();
  private nextChannelNumber = 1;
  private nextCommandNumber = 1;
  private disposed = false;
  private retired = false;
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
              policyVersion: prepared.preparedLaunch.metadata.policyVersion,
              profileId: prepared.preparedLaunch.metadata.profileId,
              backend: prepared.preparedLaunch.metadata.backend as "seatbelt",
              capabilities: Object.freeze({
                ...prepared.preparedLaunch.metadata.capabilities,
                warnings: Object.freeze([
                  ...prepared.preparedLaunch.metadata.capabilities.warnings,
                ]) as unknown as string[],
              }),
              ...(prepared.preparedLaunch.metadata.grantTiming
                ? { grantTiming: prepared.preparedLaunch.metadata.grantTiming }
                : {}),
              ...(prepared.preparedLaunch.metadata.grant
                ? {
                    grant: Object.freeze({
                      ...prepared.preparedLaunch.metadata.grant,
                    }),
                  }
                : {}),
              ...(prepared.preparedLaunch.metadata.capabilityRequest
                ? {
                    capabilityRequest: Object.freeze({
                      ...prepared.preparedLaunch.metadata.capabilityRequest,
                    }),
                  }
                : {}),
              ...(prepared.preparedLaunch.metadata.environmentPolicy
                ? {
                    environmentPolicy: Object.freeze({
                      ...prepared.preparedLaunch.metadata.environmentPolicy,
                      exclude: Object.freeze([
                        ...prepared.preparedLaunch.metadata.environmentPolicy
                          .exclude,
                      ]) as unknown as string[],
                      setKeys: Object.freeze([
                        ...prepared.preparedLaunch.metadata.environmentPolicy
                          .setKeys,
                      ]) as unknown as string[],
                      includeOnly: Object.freeze([
                        ...prepared.preparedLaunch.metadata.environmentPolicy
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
          prepared.preparedLaunch.finalize();
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
          this.clearReservation(prepared.before.channelId, reservation);
          prepared.preparedLaunch.finalize();
          throw new Error("Prepared sandbox terminal target changed");
        }
        if (descriptor.sandboxInlineFiles?.length) {
          try {
            await verifyTerminalInlineFiles(descriptor.sandboxInlineFiles, {
              requireCanonicalPaths: true,
            });
          } catch (error) {
            state = "disposed";
            this.clearReservation(prepared.before.channelId, reservation);
            prepared.preparedLaunch.finalize();
            throw error;
          }
        }
        state = "consumed";
        const execution = this.executeAuthorized(
          descriptor,
          prepared,
          preparedSecurity,
        );
        this.clearReservation(prepared.before.channelId, reservation);
        const result = await execution;
        return { ...result, security: preparedSecurity };
      },
      dispose: () => {
        if (state !== "prepared") return;
        state = "disposed";
        if (
          this.channelReservations.get(prepared.before.channelId) ===
          reservation
        ) {
          this.clearReservation(prepared.before.channelId, reservation);
        }
        prepared.preparedLaunch.finalize();
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
        this.clearReservation(prepared.before.channelId, reservation);
      }
    }
  }

  private async executeAuthorized(
    options: TerminalExecuteOptions,
    prepared: {
      channel: ManagedSandboxChannel;
      before: SandboxTerminalSessionSnapshot;
      commandId: string;
      preparedLaunch: PreparedSandboxLaunch;
    },
    security?: TerminalExecutionSecuritySummary,
  ): Promise<TerminalCommandResult> {
    this.assertActive();
    const { channel, before, commandId, preparedLaunch } = prepared;
    const sandboxSessionId = options.sandboxSessionId as string;
    let activeLaunch: ActiveSandboxLaunch;
    let networkAuditId: string | undefined;
    let process: SandboxCommandProcess;
    try {
      activeLaunch = preparedLaunch.activate();
      networkAuditId =
        security?.auditId ?? activeLaunch.metadata.grant?.auditId;
      if (
        activeLaunch.helperRequest.network.mode === "public-proxy" &&
        !networkAuditId
      ) {
        throw new Error(
          "Managed sandbox networking requires command audit attribution",
        );
      }
      activeLaunch.assertLaunchValid?.();
      process = this.runtime.launch(activeLaunch.helperRequest);
    } catch (error) {
      preparedLaunch.finalize();
      throw error;
    }
    const finalizer = finalizedOnce(() => {
      try {
        options.onCommandFinalized?.();
      } finally {
        preparedLaunch.finalize();
      }
    });
    let resolveDetach!: () => void;
    const detachPromise = new Promise<void>((resolve) => {
      resolveDetach = resolve;
    });
    const detachForeground = () => resolveDetach();
    channel.active = {
      commandId,
      generation: activeLaunch.helperRequest.generation,
      process,
      metadata: activeLaunch.metadata,
      finalizer,
      networkAbortController: new AbortController(),
      networkReviewPendingCount: 0,
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
        : createInteractivePromptWatchdog(),
      detachForeground: options.background ? undefined : detachForeground,
      background: options.background === true,
      detachedFromPool: false,
    };
    channel.latestMetadata = activeLaunch.metadata;
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
      try {
        await process.ready;
      } catch (error) {
        if (
          error instanceof SandboxPreCommandLaunchError ||
          error instanceof SandboxStructuralProtectionError
        ) {
          this.reclaimFailedLaunchChannel(channel);
        }
        void completion.catch((completionError) => {
          if (completionError !== error) {
            this.log?.(
              `[sandbox-terminal] Background launch completion also failed: ${completionError}`,
            );
          }
        });
        throw error;
      }
      this.detachImplicitFromPool(channel);
      options.onCommandFinalizationDeferred?.();
      void completion.catch((error) => {
        this.log?.(`[sandbox-terminal] Background command failed: ${error}`);
      });
      return this.backgroundResult(channel, commandId, activeLaunch.metadata);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeoutStartedAt: number | undefined;
    let timeoutRemaining = options.timeout;
    let resolveTimeout: ((outcome: "timed_out") => void) | undefined;
    const startTimeout = () => {
      if (
        channel.active?.commandId !== commandId ||
        timeoutRemaining === undefined ||
        timer ||
        channel.active.networkReviewPendingCount > 0
      ) {
        return;
      }
      if (timeoutRemaining <= 0) {
        resolveTimeout?.("timed_out");
        return;
      }
      timeoutStartedAt = Date.now();
      timer = setTimeout(() => {
        timer = undefined;
        resolveTimeout?.("timed_out");
      }, timeoutRemaining);
      timer.unref();
    };
    const pauseTimeoutForNetworkReview = () => {
      if (
        !timer ||
        timeoutStartedAt === undefined ||
        timeoutRemaining === undefined
      ) {
        return;
      }
      clearTimeout(timer);
      timer = undefined;
      timeoutRemaining = Math.max(
        0,
        timeoutRemaining - (Date.now() - timeoutStartedAt),
      );
      timeoutStartedAt = undefined;
    };
    const resumeTimeoutAfterNetworkReview = () => {
      startTimeout();
    };
    if (channel.active?.commandId === commandId) {
      channel.active.pauseTimeoutForNetworkReview =
        pauseTimeoutForNetworkReview;
      channel.active.resumeTimeoutAfterNetworkReview =
        resumeTimeoutAfterNetworkReview;
    }
    let outcome: "completed" | "detached" | "timed_out";
    try {
      outcome = await Promise.race([
        completion.then(() => "completed" as const),
        detachPromise.then(() => "detached" as const),
        ...(options.timeout !== undefined
          ? [
              new Promise<"timed_out">((resolve) => {
                resolveTimeout = resolve;
                startTimeout();
              }),
            ]
          : []),
      ]);
    } catch (error) {
      if (
        error instanceof SandboxPreCommandLaunchError ||
        error instanceof SandboxStructuralProtectionError
      ) {
        this.reclaimFailedLaunchChannel(channel);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (channel.active?.commandId === commandId) {
        channel.active.pauseTimeoutForNetworkReview = undefined;
        channel.active.resumeTimeoutAfterNetworkReview = undefined;
      }
      if (channel.active?.detachForeground === detachForeground) {
        channel.active.detachForeground = undefined;
      }
    }

    if (outcome === "detached" && channel.active?.commandId === commandId) {
      this.disableInteractivePromptWatchdog(channel.active);
      channel.active.background = true;
      this.detachImplicitFromPool(channel);
      options.onCommandFinalizationDeferred?.();
      void completion.catch((error) => {
        if (
          error instanceof SandboxPreCommandLaunchError ||
          error instanceof SandboxStructuralProtectionError
        ) {
          this.reclaimFailedLaunchChannel(channel);
        }
        this.log?.(`[sandbox-terminal] Background command failed: ${error}`);
      });
      return this.backgroundResult(channel, commandId, activeLaunch.metadata);
    }

    if (outcome === "detached") await completion;

    if (outcome === "timed_out") {
      this.disableInteractivePromptWatchdog(channel.active);
      if (channel.active?.commandId === commandId) {
        channel.active.background = true;
        this.detachImplicitFromPool(channel);
      }
      channel.active?.networkAbortController.abort();
      options.onCommandFinalizationDeferred?.();
      void completion.catch((error) =>
        this.log?.(`[sandbox-terminal] Timed-out command failed: ${error}`),
      );
      return {
        ...this.backgroundResult(channel, commandId, activeLaunch.metadata),
        timed_out: true,
      };
    }
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
      activeLaunch.metadata,
      channel.session.getCommandOutput(commandId),
    );
  }

  private prepareAuthorizedLaunch(
    options: TerminalExecuteOptions,
    reservation?: symbol,
  ): Promise<{
    channel: ManagedSandboxChannel;
    before: SandboxTerminalSessionSnapshot;
    commandId: string;
    preparedLaunch: PreparedSandboxLaunch;
  }> {
    try {
      this.assertActive();
      if (!options.sandboxSessionId) {
        throw new Error(
          "Sandbox command requires an owning AgentLink session ID",
        );
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const channel = this.resolveChannel(options, reservation);
    if (channel instanceof Promise) {
      return channel.then((resolved) =>
        this.prepareAuthorizedLaunchOnChannel(options, reservation, resolved),
      );
    }
    return this.prepareAuthorizedLaunchOnChannel(options, reservation, channel);
  }

  private async prepareAuthorizedLaunchOnChannel(
    options: TerminalExecuteOptions,
    reservation: symbol | undefined,
    channel: ManagedSandboxChannel,
  ): Promise<{
    channel: ManagedSandboxChannel;
    before: SandboxTerminalSessionSnapshot;
    commandId: string;
    preparedLaunch: PreparedSandboxLaunch;
  }> {
    const before = channel.session.snapshot();
    if (
      before.status === "launching" ||
      before.status === "running" ||
      (this.channelReservations.has(before.channelId) &&
        this.channelReservations.get(before.channelId) !== reservation)
    ) {
      throw new Error(`Sandbox terminal ${before.channelId} is busy`);
    }
    if (reservation && !this.channelReservations.has(before.channelId)) {
      this.reserveChannel(channel, reservation);
    }
    const commandId = this.createCommandId();
    if (!commandId || commandId.includes("\0")) {
      this.clearReservation(before.channelId, reservation);
      throw new Error("createCommandId must return a non-empty ID without NUL");
    }
    let preparedLaunch: PreparedSandboxLaunch;
    try {
      preparedLaunch = await this.authorizer.authorize({
        options,
        channelId: before.channelId,
        commandId,
        generation: before.nextGeneration,
        dimensions: before.dimensions,
      });
    } catch (error) {
      this.clearReservation(before.channelId, reservation);
      throw error;
    }
    if (
      preparedLaunch.identity.channelId !== before.channelId ||
      preparedLaunch.identity.commandId !== commandId ||
      preparedLaunch.identity.generation !== before.nextGeneration
    ) {
      preparedLaunch.finalize();
      this.clearReservation(before.channelId, reservation);
      throw new Error(
        "Sandbox authorizer returned a mismatched command identity",
      );
    }
    const current = channel.session.snapshot();
    if (
      (reservation &&
        this.channelReservations.get(before.channelId) !== reservation) ||
      this.channels.get(before.channelId) !== channel ||
      current.status !== "idle" ||
      current.nextGeneration !== before.nextGeneration
    ) {
      preparedLaunch.finalize();
      this.clearReservation(before.channelId, reservation);
      throw new Error("Sandbox terminal target changed during authorization");
    }
    return { channel, before, commandId, preparedLaunch };
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
    this.clearInteractivePromptWatchdog(channel?.active);
    return channel?.session.interrupt() ?? false;
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
            this.channelReservations.has(snapshot.channelId),
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
      this.clearInteractivePromptWatchdog(channel.active);
      channel.active?.networkAbortController.abort();
      const commandId = snapshot.commands.at(-1)?.commandId;
      const outputLease = commandId
        ? channel.session.detachCommandOutput(commandId)
        : undefined;
      channel.session.close();
      channel.active?.finalizer?.();
      this.clearReservation(channelId);
      this.channels.delete(channelId);
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
      this.clearInteractivePromptWatchdog(channel.active);
      channel.active?.networkAbortController.abort();
      channel.session.close();
      channel.active?.finalizer?.();
    }
    this.channels.clear();
    this.channelReservations.clear();
    this.admissions.retire();
    this.admissionWaiters.clear();
    this.channelListeners.clear();
    for (const lease of this.recentlyClosedOutput.values()) lease.dispose();
    this.recentlyClosedOutput.clear();
    this.runtime.dispose();
    for (const listener of this.disposeListeners) listener();
    this.disposeListeners.clear();
  }

  private reuseChannel(
    channel: ManagedSandboxChannel,
    owner: TerminalExecutionOwner | undefined,
  ): ManagedSandboxChannel {
    channel.owner = owner ? Object.freeze({ ...owner }) : undefined;
    return channel;
  }

  private resolveChannel(
    options: TerminalExecuteOptions,
    reservation: symbol | undefined,
  ): ManagedSandboxChannel | Promise<ManagedSandboxChannel> {
    if (options.terminal_id) {
      const existing = this.channels.get(options.terminal_id);
      if (!existing || !sameTerminalOwnerScope(existing.owner, options.owner)) {
        throw new Error(`Sandbox terminal not found: ${options.terminal_id}`);
      }
      return this.reuseChannel(existing, options.owner);
    }
    if (
      options.split_from &&
      !this.ownedChannel(options.split_from, options.owner)
    ) {
      throw new Error(`Sandbox split source not found: ${options.split_from}`);
    }
    if (options.terminal_name) {
      const named = [...this.channels.values()].find(
        ({ session, owner }) =>
          session.snapshot().title === options.terminal_name &&
          sameTerminalOwnerScope(owner, options.owner),
      );
      return named
        ? this.reuseChannel(named, options.owner)
        : this.createChannel(options.terminal_name, options.cwd, options.owner);
    }
    if (options.split_from) {
      return this.createChannel(
        options.terminal_creation_name ?? DEFAULT_SANDBOX_TITLE,
        options.cwd,
        options.owner,
      );
    }
    return this.resolveImplicitChannel(options, reservation);
  }

  private resolveImplicitChannel(
    options: TerminalExecuteOptions,
    reservation: symbol | undefined,
  ): ManagedSandboxChannel | Promise<ManagedSandboxChannel> {
    const key = ownerScopeKey(options.owner);
    if (!this.admissions.hasPending(key)) {
      const channel = this.tryResolveImplicitChannel(options);
      if (channel) return this.reserveChannel(channel, reservation);
    }
    if (
      (this.admissionWaiters.get(key) ?? 0) >=
      MAX_IMPLICIT_ADMISSION_WAITERS_PER_OWNER
    ) {
      this.log?.(`[sandbox-terminal] Admission queue overflow for ${key}`);
      throw this.implicitPoolExhausted(options);
    }
    return this.waitForImplicitAdmission(options, reservation, key);
  }

  private async waitForImplicitAdmission(
    options: TerminalExecuteOptions,
    reservation: symbol | undefined,
    key: string,
  ): Promise<ManagedSandboxChannel> {
    this.admissionWaiters.set(key, (this.admissionWaiters.get(key) ?? 0) + 1);
    this.log?.(`[sandbox-terminal] Queued implicit admission for ${key}`);
    try {
      for (;;) {
        const ticket = await this.admissions.wait({
          key,
          signal: options.admissionSignal,
          timeoutMs: IMPLICIT_ADMISSION_TIMEOUT_MS,
          maxWaiters: MAX_IMPLICIT_ADMISSION_WAITERS_PER_OWNER,
          canAdmit: () => this.canAdmitImplicit(options),
          timeoutError: () => this.implicitPoolExhausted(options),
        });
        try {
          const channel = this.tryResolveImplicitChannel(options);
          if (channel) {
            this.reserveChannel(channel, reservation);
            ticket.consume();
            this.log?.(
              `[sandbox-terminal] Admitted implicit execution for ${key}`,
            );
            return channel;
          }
        } finally {
          ticket.release();
        }
      }
    } finally {
      const waiting = (this.admissionWaiters.get(key) ?? 1) - 1;
      if (waiting > 0) this.admissionWaiters.set(key, waiting);
      else this.admissionWaiters.delete(key);
    }
  }

  private reserveChannel(
    channel: ManagedSandboxChannel,
    reservation: symbol | undefined,
  ): ManagedSandboxChannel {
    if (reservation) {
      this.channelReservations.set(channel.session.channelId, reservation);
    }
    return channel;
  }

  private tryResolveImplicitChannel(
    options: TerminalExecuteOptions,
  ): ManagedSandboxChannel | undefined {
    if (
      options.background &&
      this.detachedImplicitChannels(options.owner).length >=
        MAX_DETACHED_IMPLICIT_CHANNELS_PER_OWNER
    ) {
      return undefined;
    }
    const envKey = this.environmentKey(options);
    const pooledChannels = this.pooledImplicitChannels(options.owner);
    const idleDefault = pooledChannels.find(({ session, envKey: current }) => {
      const snapshot = session.snapshot();
      return (
        snapshot.status === "idle" &&
        !this.channelReservations.has(snapshot.channelId) &&
        snapshot.cwd === options.cwd &&
        current === envKey
      );
    });
    if (idleDefault) return this.reuseChannel(idleDefault, options.owner);
    if (pooledChannels.length < MAX_IMPLICIT_CHANNELS_PER_OWNER) {
      return this.createChannel(
        options.terminal_creation_name ?? DEFAULT_SANDBOX_TITLE,
        options.cwd,
        options.owner,
        true,
        envKey,
      );
    }
    const reclaimable = pooledChannels
      .filter(({ session }) => {
        const snapshot = session.snapshot();
        return (
          snapshot.status === "idle" &&
          !this.channelReservations.has(snapshot.channelId)
        );
      })
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
    if (!reclaimable) return undefined;
    this.reclaimImplicitChannel(reclaimable);
    return this.createChannel(
      options.terminal_creation_name ?? DEFAULT_SANDBOX_TITLE,
      options.cwd,
      options.owner,
      true,
      envKey,
    );
  }

  private canAdmitImplicit(options: TerminalExecuteOptions): boolean {
    if (
      options.background &&
      this.detachedImplicitChannels(options.owner).length >=
        MAX_DETACHED_IMPLICIT_CHANNELS_PER_OWNER
    ) {
      return false;
    }
    const pooledChannels = this.pooledImplicitChannels(options.owner);
    if (pooledChannels.length < MAX_IMPLICIT_CHANNELS_PER_OWNER) return true;
    return pooledChannels.some(({ session }) => {
      const snapshot = session.snapshot();
      return (
        snapshot.status === "idle" &&
        !this.channelReservations.has(snapshot.channelId)
      );
    });
  }

  private implicitChannels(
    owner: TerminalExecutionOwner | undefined,
  ): ManagedSandboxChannel[] {
    return [...this.channels.values()].filter(
      (channel) =>
        channel.implicit && sameTerminalOwnerScope(channel.owner, owner),
    );
  }

  private pooledImplicitChannels(
    owner: TerminalExecutionOwner | undefined,
  ): ManagedSandboxChannel[] {
    return this.implicitChannels(owner).filter(
      (channel) => channel.active?.detachedFromPool !== true,
    );
  }

  private detachedImplicitChannels(
    owner: TerminalExecutionOwner | undefined,
  ): ManagedSandboxChannel[] {
    return this.implicitChannels(owner).filter(
      (channel) => channel.active?.detachedFromPool === true,
    );
  }

  private detachImplicitFromPool(channel: ManagedSandboxChannel): void {
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

  private environmentKey(options: TerminalExecuteOptions): string {
    return JSON.stringify(
      Object.entries(options.env ?? {}).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  }

  private implicitPoolExhausted(options: TerminalExecuteOptions): Error {
    if (options.background) {
      const detached = this.detachedImplicitChannels(options.owner);
      if (detached.length >= MAX_DETACHED_IMPLICIT_CHANNELS_PER_OWNER) {
        return new Error(
          `Sandbox background terminal limit reached (${detached.length} background commands running): ${describeBlockingChannels(detached)}. Wait for one to finish or kill it with its terminal_id.`,
        );
      }
    }
    const pooledChannels = this.pooledImplicitChannels(options.owner);
    const blocking = pooledChannels.filter((channel) => {
      const snapshot = channel.session.snapshot();
      return (
        snapshot.status === "launching" ||
        snapshot.status === "running" ||
        this.channelReservations.has(snapshot.channelId)
      );
    });
    return new Error(
      `Sandbox terminal pool exhausted by ${describeBlockingChannels(blocking.length > 0 ? blocking : pooledChannels)}. Wait for a command to finish or use get_terminal_output/kill with its terminal_id.`,
    );
  }

  private createChannel(
    title: string,
    cwd: string,
    owner: TerminalExecutionOwner | undefined,
    implicit = false,
    envKey?: string,
  ): ManagedSandboxChannel {
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
    const channel: ManagedSandboxChannel = {
      session,
      ...(owner ? { owner: Object.freeze({ ...owner }) } : {}),
      ...(envKey === undefined ? {} : { envKey }),
      implicit,
      lastUsedAt: this.now(),
    };
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

  private reclaimFailedLaunchChannel(channel: ManagedSandboxChannel): void {
    const snapshot = channel.session.snapshot();
    const commandId = snapshot.commands.at(-1)?.commandId;
    const outputLease = commandId
      ? channel.session.detachCommandOutput(commandId)
      : undefined;
    this.clearInteractivePromptWatchdog(channel.active);
    channel.active?.networkAbortController.abort();
    channel.session.close();
    channel.active?.finalizer?.();
    channel.active = undefined;
    this.clearReservation(snapshot.channelId);
    this.channels.delete(snapshot.channelId);
    if (commandId) this.rememberClosed(snapshot, channel.owner, outputLease);
  }

  private reclaimImplicitChannel(channel: ManagedSandboxChannel): void {
    const snapshot = channel.session.snapshot();
    const commandId = snapshot.commands.at(-1)?.commandId;
    const outputLease = commandId
      ? channel.session.detachCommandOutput(commandId)
      : undefined;
    this.clearInteractivePromptWatchdog(channel.active);
    channel.active?.networkAbortController.abort();
    channel.session.close();
    channel.active?.finalizer?.();
    channel.active = undefined;
    this.clearReservation(snapshot.channelId);
    this.channels.delete(snapshot.channelId);
    if (commandId) this.rememberClosed(snapshot, channel.owner, outputLease);
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
      active.networkAbortController.abort();
      const terminated = active.process.terminate();
      if (!terminated) {
        channel.latestTermination = undefined;
        this.log?.(
          `[sandbox-terminal] Failed to terminate command ${active.commandId} after interactive prompt detection`,
        );
      }
    });
  }

  private clearInteractivePromptWatchdog(
    active: ManagedSandboxChannel["active"] | undefined,
  ): void {
    clearInteractivePromptWatchdog(active?.interactivePromptWatchdog);
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
    active.networkReviewPendingCount += 1;
    if (active.networkReviewPendingCount === 1) {
      active.pauseTimeoutForNetworkReview?.();
    }
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
    } finally {
      active.networkReviewPendingCount = Math.max(
        0,
        active.networkReviewPendingCount - 1,
      );
      if (active.networkReviewPendingCount === 0) {
        active.resumeTimeoutAfterNetworkReview?.();
      }
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
            !this.channelReservations.has(snapshot.channelId)
          );
        })
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!oldestIdle) return;
      this.reclaimImplicitChannel(oldestIdle);
    }
  }

  private clearReservation(channelId: string, expected?: symbol): void {
    const reservation = this.channelReservations.get(channelId);
    if (!reservation || (expected && reservation !== expected)) return;
    this.channelReservations.delete(channelId);
    const channel = this.channels.get(channelId);
    this.notifyAdmission(channel?.owner);
  }

  private notifyAdmission(owner: TerminalExecutionOwner | undefined): void {
    this.admissions.notify(ownerScopeKey(owner));
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
  ): ManagedSandboxChannel | undefined {
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
    termination?: ManagedSandboxChannel["latestTermination"],
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
    if (this.disposed)
      throw new Error("Sandbox terminal coordinator is disposed");
    if (this.retired)
      throw new Error("Sandbox terminal coordinator is retired");
  }
}
