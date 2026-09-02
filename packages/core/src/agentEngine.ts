import { randomUUID } from "node:crypto";

import type { HostToolResolver } from "./hostTools.js";
import type { AgentModelReference, AgentPrincipal } from "./modelIdentity.js";
import type {
  CoreModelAuthContext,
  CoreModelRuntime,
  CoreModelUsage,
} from "./modelRuntime.js";
import type {
  AgentSessionRecord,
  AgentSessionRepository,
  AgentSessionRevision,
  AgentSessionSummary,
  ReadAgentSessionResult,
} from "./sessionRepository.js";
import type {
  AgentTurnDurableState,
  AgentTurnEvent,
  AgentTurnRequest,
  AgentTurnResult,
  AgentTurnRunOptions,
  AgentTurnStream,
  PreparedAgentTurnRequest,
} from "./turnContracts.js";
import type {
  AuthorizeToolCall,
  DurableToolInteractionRepository,
  ToolAuthorizationDecision,
  TurnInteractionTokenService,
} from "./turnInteractions.js";
import {
  createHeadlessTurnKernel,
  type HeadlessTurnAuthRequest,
  type HeadlessTurnKernel,
  type HeadlessTurnTool,
} from "./turnKernel.js";
import type { TurnExecutionLimits } from "./turnExecution.js";
import type { AgentTurnLease, AgentTurnLeaseProvider } from "./turnLeases.js";

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_LEASE_RENEW_INTERVAL_MS = 10_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

export interface AgentInstructions {
  readonly identity?: string;
  readonly instructions?: string;
}

export interface ResolveAgentInstructionsRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly session: AgentSessionRecord<TPrincipal>;
  readonly turnId: string;
}

export type ResolveAgentInstructions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> = (
  request: ResolveAgentInstructionsRequest<TPrincipal>,
) => string | AgentInstructions | Promise<string | AgentInstructions>;

export interface CreateAgentEngineOptions<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly ownerId: string;
  readonly models: CoreModelRuntime;
  readonly sessions: AgentSessionRepository<TPrincipal>;
  readonly turnLeases: AgentTurnLeaseProvider<TPrincipal>;
  readonly interactions?: DurableToolInteractionRepository<TPrincipal>;
  readonly interactionTokens?: TurnInteractionTokenService;
  readonly defaultModel?: AgentModelReference;
  readonly resolveInstructions: ResolveAgentInstructions<TPrincipal>;
  readonly tools?: readonly HeadlessTurnTool<TPrincipal>[];
  readonly resolveTools?: HostToolResolver<TPrincipal>;
  readonly authorizeToolCall?: AuthorizeToolCall<TPrincipal>;
  readonly resolveAuthContext?: (
    request: HeadlessTurnAuthRequest<TPrincipal>,
  ) =>
    | CoreModelAuthContext
    | undefined
    | Promise<CoreModelAuthContext | undefined>;
  readonly limits?: TurnExecutionLimits;
  readonly maxOutputTokens?: number;
  readonly leaseTtlMs?: number;
  readonly leaseRenewIntervalMs?: number;
  readonly createSessionId?: () => string;
  readonly createTurnId?: () => string;
  readonly createInteractionId?: () => string;
  readonly now?: () => number;
}

export interface CreateAgentSessionRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId?: string;
  readonly model?: AgentModelReference;
}

export interface CreateAgentSessionResponse<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly record: AgentSessionRecord<TPrincipal>;
  readonly revision: AgentSessionRevision;
}

export interface SetAgentSessionModelRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly model: AgentModelReference | undefined;
  readonly expectedRevision: AgentSessionRevision;
}

export interface ResumeAgentInteractionRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly turnId: string;
  readonly interactionId: string;
  readonly interactionRevision: string;
  readonly expectedSessionRevision: string;
  readonly decision: ToolAuthorizationDecision;
}

export interface AgentSessionOperations<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  create(
    request: CreateAgentSessionRequest<TPrincipal>,
  ): Promise<CreateAgentSessionResponse<TPrincipal>>;
  read(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
  }): Promise<ReadAgentSessionResult<TPrincipal>>;
  list(request: {
    readonly principal: TPrincipal;
  }): Promise<readonly AgentSessionSummary<TPrincipal>[]>;
  setModel(request: SetAgentSessionModelRequest<TPrincipal>): Promise<{
    readonly revision: AgentSessionRevision;
  }>;
  runTurn(
    request: AgentTurnRequest<TPrincipal>,
    options?: AgentTurnRunOptions,
  ): AgentTurnStream;
  resumeInteraction(
    request: ResumeAgentInteractionRequest<TPrincipal>,
    options?: AgentTurnRunOptions,
  ): AgentTurnStream;
  recoverInterrupted(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly reason?: string;
  }): Promise<ReadAgentSessionResult<TPrincipal>>;
}

export interface AgentEngine<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly models: CoreModelRuntime;
  readonly sessions: AgentSessionOperations<TPrincipal>;
}

export class AgentEngineError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code:
      | "session_already_exists"
      | "session_not_found"
      | "session_revision_conflict"
      | "session_busy"
      | "turn_lease_held"
      | "turn_lease_lost"
      | "interaction_not_configured"
      | "interaction_not_found"
      | "invalid_engine_configuration",
    message: string,
    retryable = false,
    /** Terminal provider result retained when its durable commit failed. */
    readonly terminalResult?: AgentTurnResult,
  ) {
    super(message);
    this.name = "AgentEngineError";
    this.retryable = retryable;
  }
}

/** Compose durable sessions, distributed leases, and the headless turn kernel. */
export function createAgentEngine<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(options: CreateAgentEngineOptions<TPrincipal>): AgentEngine<TPrincipal> {
  const ownerId = requiredText(options.ownerId, "ownerId");
  const now = options.now ?? Date.now;
  const createSessionId = options.createSessionId ?? randomUUID;
  const createTurnId = options.createTurnId ?? randomUUID;
  const maxOutputTokens = positiveInteger(
    options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    "maxOutputTokens",
  );
  const leaseTtlMs = positiveInteger(
    options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
    "leaseTtlMs",
  );
  const leaseRenewIntervalMs = positiveInteger(
    options.leaseRenewIntervalMs ?? DEFAULT_LEASE_RENEW_INTERVAL_MS,
    "leaseRenewIntervalMs",
  );
  if (leaseRenewIntervalMs >= leaseTtlMs) {
    throw new AgentEngineError(
      "invalid_engine_configuration",
      "leaseRenewIntervalMs must be less than leaseTtlMs",
    );
  }
  if (
    (options.interactions === undefined) !==
    (options.interactionTokens === undefined)
  ) {
    throw new AgentEngineError(
      "invalid_engine_configuration",
      "interactions and interactionTokens must be configured together",
    );
  }

  const kernel = createHeadlessTurnKernel({
    models: options.models,
    tools: options.tools,
    resolveTools: options.resolveTools,
    authorizeToolCall: options.authorizeToolCall,
    interactions: options.interactions,
    interactionTokens: options.interactionTokens,
    createInteractionId: options.createInteractionId,
    defaultLimits: options.limits,
    resolveAuthContext: options.resolveAuthContext,
    now,
  });

  const read = async (request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
  }): Promise<ReadAgentSessionResult<TPrincipal>> =>
    await options.sessions.readSession(request);

  return Object.freeze({
    models: options.models,
    sessions: Object.freeze({
      async create(request: CreateAgentSessionRequest<TPrincipal>) {
        const timestamp = readClock(now);
        const record: AgentSessionRecord<TPrincipal> = {
          schemaVersion: 1,
          principal: structuredClone(request.principal),
          sessionId: requiredText(
            request.sessionId ?? createSessionId(),
            "sessionId",
          ),
          createdAt: timestamp,
          updatedAt: timestamp,
          messages: [],
          ...(request.model
            ? { selectedModel: structuredClone(request.model) }
            : {}),
          runState: { phase: "idle" },
        };
        const created = await options.sessions.createSession({ record });
        if (!created.ok) {
          throw new AgentEngineError(
            "session_already_exists",
            `Session "${record.sessionId}" already exists`,
          );
        }
        return { record: structuredClone(record), revision: created.revision };
      },
      read,
      async list(request: { readonly principal: TPrincipal }) {
        return await options.sessions.listSessions(request);
      },
      async setModel(request: SetAgentSessionModelRequest<TPrincipal>) {
        const lease = await acquireLease(options.turnLeases, {
          principal: request.principal,
          sessionId: request.sessionId,
          turnId: requiredText(createTurnId(), "turnId"),
          ownerId,
          ttlMs: leaseTtlMs,
        });
        try {
          const current = await requireSession(options.sessions, request);
          assertRunnable(current.record);
          const saved = await options.sessions.saveSession({
            record: {
              ...current.record,
              updatedAt: monotonicTimestamp(current.record.updatedAt, now),
              selectedModel: request.model
                ? structuredClone(request.model)
                : undefined,
            },
            expectedRevision: request.expectedRevision,
            fencingToken: lease.fencingToken,
          });
          if (!saved.ok) throwSessionMutation(saved.reason);
          return { revision: saved.revision };
        } finally {
          await releaseLease(options.turnLeases, lease);
        }
      },
      runTurn(
        request: AgentTurnRequest<TPrincipal>,
        runOptions: AgentTurnRunOptions = { signal: undefined },
      ) {
        return streamDeferredEngineTurn(() => {
          const turnId = requiredText(createTurnId(), "turnId");
          return streamEngineTurn({
            options,
            kernel,
            ownerId,
            leaseTtlMs,
            leaseRenewIntervalMs,
            now,
            runOptions,
            acquire: {
              principal: request.principal,
              sessionId: request.sessionId,
              turnId,
            },
            prepare: async (lease, kernelRunOptions) => {
              const current = await requireSession(options.sessions, request);
              assertRunnable(current.record);
              const running = await options.sessions.saveSession({
                record: {
                  ...current.record,
                  updatedAt: monotonicTimestamp(current.record.updatedAt, now),
                  lastTurnId: turnId,
                  runState: {
                    phase: "running",
                    turnId,
                    startedAt: readClock(now),
                  },
                },
                expectedRevision: current.revision,
                fencingToken: lease.fencingToken,
              });
              if (!running.ok) throwSessionMutation(running.reason);
              const instructions = await options.resolveInstructions({
                principal: request.principal,
                session: current.record,
                turnId,
              });
              const prepared: PreparedAgentTurnRequest<TPrincipal> = {
                request: structuredClone(request),
                turnId,
                history: structuredClone(current.record.messages),
                sessionModel: current.record.selectedModel
                  ? structuredClone(current.record.selectedModel)
                  : undefined,
                runtimeDefaultModel: options.defaultModel
                  ? structuredClone(options.defaultModel)
                  : undefined,
                systemPrompt: formatInstructions(instructions),
                maxOutputTokens,
                reasoningEffort: undefined,
                limits: options.limits,
                sessionRevision: running.revision,
                turnFencingToken: lease.fencingToken,
              };
              return {
                original: current.record,
                stream: kernel.runTurn(prepared, kernelRunOptions),
              };
            },
          });
        });
      },
      resumeInteraction(
        request: ResumeAgentInteractionRequest<TPrincipal>,
        runOptions: AgentTurnRunOptions = { signal: undefined },
      ) {
        return streamDeferredEngineTurn(() => {
          if (!options.interactions || !options.interactionTokens) {
            throw new AgentEngineError(
              "interaction_not_configured",
              "Durable interactions are not configured",
            );
          }
          return streamEngineTurn({
            options,
            kernel,
            ownerId,
            leaseTtlMs,
            leaseRenewIntervalMs,
            now,
            runOptions,
            acquire: {
              principal: request.principal,
              sessionId: request.sessionId,
              turnId: request.turnId,
            },
            prepare: async (lease, kernelRunOptions) => {
              const current = await requireSession(options.sessions, request);
              if (
                current.record.runState.phase !== "suspended" ||
                current.record.pendingInteractionId !== request.interactionId
              ) {
                throw new AgentEngineError(
                  "session_busy",
                  "Session is not suspended on this interaction",
                );
              }
              const tokenRequest = {
                ...request,
                fencingToken: lease.fencingToken,
              };
              const responseToken =
                await kernel.issueInteractionResponseToken(tokenRequest);
              return {
                original: current.record,
                stream: kernel.resumeInteraction(
                  { ...tokenRequest, responseToken },
                  kernelRunOptions,
                ),
              };
            },
          });
        });
      },
      async recoverInterrupted(request: {
        readonly principal: TPrincipal;
        readonly sessionId: string;
        readonly reason?: string;
      }) {
        const turnId = requiredText(createTurnId(), "turnId");
        const lease = await acquireLease(options.turnLeases, {
          ...request,
          turnId,
          ownerId,
          ttlMs: leaseTtlMs,
        });
        try {
          const current = await requireSession(options.sessions, request);
          if (
            current.record.runState.phase !== "running" &&
            current.record.runState.phase !== "resuming"
          ) {
            return current;
          }
          const interrupted = await options.sessions.saveSession({
            record: {
              ...current.record,
              updatedAt: monotonicTimestamp(current.record.updatedAt, now),
              lastTurnId: current.record.runState.turnId,
              pendingInteractionId: undefined,
              runState: {
                phase: "interrupted",
                turnId: current.record.runState.turnId,
                interruptedAt: readClock(now),
                reason: boundedReason(
                  request.reason ?? "Previous turn lost its lease",
                ),
              },
            },
            expectedRevision: current.revision,
            fencingToken: lease.fencingToken,
          });
          if (!interrupted.ok) throwSessionMutation(interrupted.reason);
          return await read(request);
        } finally {
          await releaseLease(options.turnLeases, lease);
        }
      },
    }),
  });
}

interface EngineTurnPreparation<TPrincipal extends AgentPrincipal> {
  readonly original: AgentSessionRecord<TPrincipal>;
  readonly stream: AgentTurnStream;
}

function streamDeferredEngineTurn(
  create: () => AgentTurnStream,
): AgentTurnStream {
  return (async function* (): AgentTurnStream {
    let stream: AgentTurnStream | undefined;
    let settled = false;
    try {
      stream = create();
      for (;;) {
        const next = await stream.next();
        if (next.done) {
          settled = true;
          return next.value;
        }
        yield next.value;
      }
    } finally {
      if (stream && !settled) await stream.return(undefined as never);
    }
  })();
}

function streamEngineTurn<TPrincipal extends AgentPrincipal>(args: {
  readonly options: CreateAgentEngineOptions<TPrincipal>;
  readonly kernel: HeadlessTurnKernel<TPrincipal>;
  readonly ownerId: string;
  readonly leaseTtlMs: number;
  readonly leaseRenewIntervalMs: number;
  readonly now: () => number;
  readonly runOptions: AgentTurnRunOptions;
  readonly acquire: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly turnId: string;
  };
  readonly prepare: (
    lease: AgentTurnLease<TPrincipal>,
    runOptions: AgentTurnRunOptions,
  ) => Promise<EngineTurnPreparation<TPrincipal>>;
}): AgentTurnStream {
  return (async function* (): AgentTurnStream {
    const lease = await acquireLease(args.options.turnLeases, {
      ...args.acquire,
      ownerId: args.ownerId,
      ttlMs: args.leaseTtlMs,
    });
    const leaseAbort = new AbortController();
    const keeper = keepLeaseAlive(
      args.options.turnLeases,
      lease,
      args.leaseTtlMs,
      args.leaseRenewIntervalMs,
      leaseAbort,
    );
    const consumerAbort = new AbortController();
    let stream: AgentTurnStream | undefined;
    let streamSettled = false;
    let prepared: EngineTurnPreparation<TPrincipal> | undefined;
    let durableState: AgentTurnDurableState | undefined;
    try {
      prepared = await args.prepare(lease, {
        signal: combineAbortSignals(
          leaseAbort.signal,
          args.runOptions.signal,
          consumerAbort.signal,
        ),
        onDurableState: (state) => {
          durableState = structuredClone(state);
          args.runOptions.onDurableState?.(structuredClone(state));
        },
      });
      stream = prepared.stream;
      let pendingTerminalEvent: AgentTurnEvent | undefined;
      let terminal: AgentTurnResult;
      for (;;) {
        const next = await stream.next();
        if (next.done) {
          streamSettled = true;
          terminal = next.value;
          break;
        }
        if (isTerminalEvent(next.value)) pendingTerminalEvent = next.value;
        else yield next.value;
      }
      if (leaseAbort.signal.aborted) {
        throw new AgentEngineError(
          "turn_lease_lost",
          "Turn lease was lost while the turn was executing",
          true,
          structuredClone(terminal),
        );
      }
      let committed: string;
      try {
        await validateLease(args.options.turnLeases, lease);
        committed = await commitTerminal(
          args.options.sessions,
          prepared.original,
          lease,
          terminal,
          durableState,
          args.now,
        );
      } catch (error) {
        throw withTerminalResult(error, terminal);
      }
      const publicResult = { ...terminal, sessionRevision: committed };
      if (pendingTerminalEvent) {
        yield replaceTerminalResult(pendingTerminalEvent, publicResult);
      }
      return publicResult;
    } finally {
      if (stream && !streamSettled) {
        consumerAbort.abort("turn event stream closed");
        await stream.return(undefined as never);
        streamSettled = true;
        if (prepared && !leaseAbort.signal.aborted) {
          await validateLease(args.options.turnLeases, lease);
          await commitAbandonedTurn(
            args.options.sessions,
            prepared.original,
            lease,
            args.acquire.turnId,
            durableState,
            args.now,
          );
        }
      }
      keeper.stop();
      await keeper.settled;
      await releaseLease(args.options.turnLeases, lease);
    }
  })();
}

async function commitAbandonedTurn<TPrincipal extends AgentPrincipal>(
  sessions: AgentSessionRepository<TPrincipal>,
  original: AgentSessionRecord<TPrincipal>,
  lease: AgentTurnLease<TPrincipal>,
  turnId: string,
  durableState: AgentTurnDurableState | undefined,
  now: () => number,
): Promise<void> {
  const current = await requireSession(sessions, {
    principal: original.principal,
    sessionId: original.sessionId,
  });
  const saved = await sessions.saveSession({
    record: {
      ...current.record,
      updatedAt: monotonicTimestamp(current.record.updatedAt, now),
      messages: structuredClone(
        durableState?.messages ?? current.record.messages,
      ),
      usage: mergeUsage(current.record.usage, durableState?.usage),
      pendingInteractionId: undefined,
      lastTurnId: turnId,
      runState: {
        phase: "interrupted",
        turnId,
        interruptedAt: readClock(now),
        reason: "Turn event consumer closed the stream",
      },
    },
    expectedRevision: current.revision,
    fencingToken: lease.fencingToken,
  });
  if (!saved.ok) throwSessionMutation(saved.reason);
}

async function commitTerminal<TPrincipal extends AgentPrincipal>(
  sessions: AgentSessionRepository<TPrincipal>,
  original: AgentSessionRecord<TPrincipal>,
  lease: AgentTurnLease<TPrincipal>,
  terminal: AgentTurnResult,
  durableState: AgentTurnDurableState | undefined,
  now: () => number,
): Promise<string> {
  if (terminal.status === "suspended") return terminal.sessionRevision;
  const current = await requireSession(sessions, {
    principal: original.principal,
    sessionId: original.sessionId,
  });
  const timestamp = monotonicTimestamp(current.record.updatedAt, now);
  const durableRecord = {
    ...current.record,
    updatedAt: timestamp,
    messages: structuredClone(
      durableState?.messages ?? current.record.messages,
    ),
    usage: mergeUsage(current.record.usage, terminal.usage),
    pendingInteractionId: undefined,
    lastTurnId: terminal.turnId,
  };
  const record: AgentSessionRecord<TPrincipal> =
    terminal.status === "failed"
      ? {
          ...durableRecord,
          runState: {
            phase: "interrupted",
            turnId: terminal.turnId,
            interruptedAt: readClock(now),
            reason: boundedReason(terminal.error.message),
          },
        }
      : { ...durableRecord, runState: { phase: "idle" } };
  const saved = await sessions.saveSession({
    record,
    expectedRevision: current.revision,
    fencingToken: lease.fencingToken,
  });
  if (!saved.ok) throwSessionMutation(saved.reason);
  return saved.revision;
}

function keepLeaseAlive<TPrincipal extends AgentPrincipal>(
  provider: AgentTurnLeaseProvider<TPrincipal>,
  initial: AgentTurnLease<TPrincipal>,
  ttlMs: number,
  intervalMs: number,
  abort: AbortController,
): { readonly stop: () => void; readonly settled: Promise<void> } {
  let lease = initial;
  let stopped = false;
  let renewing = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveSettled: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const finish = (): void => {
    if (stopped && !timer && !renewing) resolveSettled();
  };
  const schedule = (): void => {
    if (stopped || abort.signal.aborted) {
      finish();
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      renewing = true;
      void provider
        .renewTurnLease({
          principal: lease.principal,
          sessionId: lease.sessionId,
          leaseId: lease.leaseId,
          ownerId: lease.ownerId,
          fencingToken: lease.fencingToken,
          ttlMs,
        })
        .then((renewed) => {
          if (renewed.ok) lease = renewed.lease;
          else abort.abort(`turn lease ${renewed.reason}`);
        })
        .catch((error: unknown) => abort.abort(error))
        .finally(() => {
          renewing = false;
          if (stopped || abort.signal.aborted) finish();
          else schedule();
        });
    }, intervalMs);
    timer.unref();
  };
  schedule();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      finish();
    },
    settled,
  };
}

async function acquireLease<TPrincipal extends AgentPrincipal>(
  provider: AgentTurnLeaseProvider<TPrincipal>,
  request: Parameters<
    AgentTurnLeaseProvider<TPrincipal>["acquireTurnLease"]
  >[0],
): Promise<AgentTurnLease<TPrincipal>> {
  const acquired = await provider.acquireTurnLease(request);
  if (!acquired.ok) {
    throw new AgentEngineError(
      "turn_lease_held",
      `Session turn lease is held by "${acquired.holder.ownerId}" until ${acquired.holder.expiresAt}`,
      true,
    );
  }
  return acquired.lease;
}

async function validateLease<TPrincipal extends AgentPrincipal>(
  provider: AgentTurnLeaseProvider<TPrincipal>,
  lease: AgentTurnLease<TPrincipal>,
): Promise<void> {
  const valid = await provider.validateTurnLease({
    principal: lease.principal,
    sessionId: lease.sessionId,
    leaseId: lease.leaseId,
    ownerId: lease.ownerId,
    fencingToken: lease.fencingToken,
  });
  if (!valid.ok) {
    throw new AgentEngineError(
      "turn_lease_lost",
      `Turn lease is no longer valid: ${valid.reason}`,
      true,
    );
  }
}

async function releaseLease<TPrincipal extends AgentPrincipal>(
  provider: AgentTurnLeaseProvider<TPrincipal>,
  lease: AgentTurnLease<TPrincipal>,
): Promise<void> {
  await provider.releaseTurnLease({
    principal: lease.principal,
    sessionId: lease.sessionId,
    leaseId: lease.leaseId,
    ownerId: lease.ownerId,
    fencingToken: lease.fencingToken,
  });
}

async function requireSession<TPrincipal extends AgentPrincipal>(
  sessions: AgentSessionRepository<TPrincipal>,
  request: { readonly principal: TPrincipal; readonly sessionId: string },
): Promise<Extract<ReadAgentSessionResult<TPrincipal>, { ok: true }>> {
  const current = await sessions.readSession(request);
  if (!current.ok) {
    throw new AgentEngineError(
      "session_not_found",
      `Session "${request.sessionId}" was not found`,
    );
  }
  return current;
}

function assertRunnable(record: AgentSessionRecord): void {
  if (
    record.runState.phase === "idle" ||
    record.runState.phase === "interrupted"
  ) {
    return;
  }
  throw new AgentEngineError(
    "session_busy",
    `Session cannot start a turn while ${record.runState.phase}`,
  );
}

function throwSessionMutation(
  reason: "not_found" | "revision_conflict" | "stale_fence",
): never {
  if (reason === "not_found") {
    throw new AgentEngineError("session_not_found", "Session was not found");
  }
  if (reason === "stale_fence") {
    throw new AgentEngineError(
      "turn_lease_lost",
      "Turn lease fencing token is stale",
      true,
    );
  }
  throw new AgentEngineError(
    "session_revision_conflict",
    "Session revision is stale",
    true,
  );
}

function withTerminalResult(error: unknown, terminal: AgentTurnResult): Error {
  if (error instanceof AgentEngineError) {
    return new AgentEngineError(
      error.code,
      error.message,
      error.retryable,
      structuredClone(terminal),
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new AgentEngineError(
    "session_revision_conflict",
    `Terminal session commit failed: ${message}`,
    true,
    structuredClone(terminal),
  );
}

function replaceTerminalResult(
  event: AgentTurnEvent,
  result: AgentTurnResult,
): AgentTurnEvent {
  if (event.type === "turn.completed" && result.status === "completed") {
    return { ...event, result };
  }
  if (event.type === "turn.cancelled" && result.status === "cancelled") {
    return { ...event, result };
  }
  if (event.type === "turn.failed" && result.status === "failed") {
    return { ...event, result };
  }
  if (event.type === "turn.suspended" && result.status === "suspended") {
    return { ...event, result };
  }
  throw new Error("Terminal turn event does not match its result");
}

function isTerminalEvent(event: AgentTurnEvent): boolean {
  return (
    event.type === "turn.completed" ||
    event.type === "turn.cancelled" ||
    event.type === "turn.failed" ||
    event.type === "turn.suspended"
  );
}

function formatInstructions(value: string | AgentInstructions): string {
  if (typeof value === "string") return value;
  return [value.identity, value.instructions]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

function mergeUsage(
  current: CoreModelUsage | undefined,
  addition: CoreModelUsage | undefined,
): CoreModelUsage | undefined {
  if (!current) return addition ? structuredClone(addition) : undefined;
  if (!addition) return structuredClone(current);
  return {
    inputTokens: current.inputTokens + addition.inputTokens,
    outputTokens: current.outputTokens + addition.outputTokens,
    cacheReadTokens:
      (current.cacheReadTokens ?? 0) + (addition.cacheReadTokens ?? 0),
    cacheCreationTokens:
      (current.cacheCreationTokens ?? 0) + (addition.cacheCreationTokens ?? 0),
  };
}

function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal =>
    Boolean(signal),
  );
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

function monotonicTimestamp(previous: number, now: () => number): number {
  return Math.max(previous + 1, readClock(now));
}

function boundedReason(reason: string): string {
  const trimmed = reason.trim() || "Turn interrupted";
  return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 499)}…`;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AgentEngineError(
      "invalid_engine_configuration",
      `${field} must be a positive integer`,
    );
  }
  return value;
}

function requiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AgentEngineError(
      "invalid_engine_configuration",
      `${field} must not be empty`,
    );
  }
  return trimmed;
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AgentEngineError(
      "invalid_engine_configuration",
      "Engine clock must return a non-negative integer",
    );
  }
  return value;
}
