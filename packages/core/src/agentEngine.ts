import { randomUUID } from "node:crypto";

import { isCoreReasoningEffort } from "@agentlink/protocol/model-catalog";
import type { CoreReasoningEffort } from "@agentlink/protocol/model-catalog";

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
  AgentTranscriptStore,
  ReadAgentSessionResult,
} from "./sessionRepository.js";
import type {
  AgentInteractionRequest,
  AgentTurnDurableState,
  AgentTurnEvent,
  AgentTurnRequest,
  AgentTurnResult,
  AgentTurnRunOptions,
  AgentTurnStream,
  PreparedAgentTurnRequest,
} from "./turnContracts.js";
import { resolveAgentReasoningEffort } from "./turnContracts.js";
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

export type AgentTranscriptPolicy<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> =
  | { readonly mode: "durable" }
  | {
      readonly mode: "ephemeral";
      /** Host-owned process-local or otherwise explicitly ephemeral storage. */
      readonly store: AgentTranscriptStore<TPrincipal>;
    };

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
  readonly defaultReasoningEffort?: CoreReasoningEffort;
  /** Defaults to durable transcript storage in the session repository. */
  readonly transcriptPolicy?: AgentTranscriptPolicy<TPrincipal>;
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
  /** Session default; `"none"` explicitly disables the runtime default. */
  readonly reasoningEffort?: CoreReasoningEffort;
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

export interface SetAgentSessionReasoningEffortRequest<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly sessionId: string;
  readonly reasoningEffort: CoreReasoningEffort | undefined;
  readonly expectedRevision: AgentSessionRevision;
}

export interface AgentPendingInteractionSnapshot {
  readonly request: AgentInteractionRequest;
  readonly interactionRevision: string;
  readonly sessionRevision: string;
  /** First sequence expected from the resumed interaction stream. */
  readonly nextSequence: number;
}

export interface AgentSessionInspection<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly summary: AgentSessionSummary<TPrincipal>;
  readonly pendingInteraction?: AgentPendingInteractionSnapshot;
}

export interface AgentSessionHydration<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> extends AgentSessionInspection<TPrincipal> {
  readonly record: AgentSessionRecord<TPrincipal>;
}

export type CancelAgentSessionResult =
  | { readonly status: "cancellation_requested"; readonly turnId: string }
  | {
      readonly status: "cancelled";
      readonly turnId: string;
      readonly revision: AgentSessionRevision;
    }
  | { readonly status: "not_active"; readonly revision: AgentSessionRevision };

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
  /** Read control state and a display-safe pending interaction without transcript data. */
  inspect(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
  }): Promise<AgentSessionInspection<TPrincipal>>;
  /** Read the host-visible session record plus pending-interaction state for UI restore. */
  hydrate(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
  }): Promise<AgentSessionHydration<TPrincipal>>;
  setModel(request: SetAgentSessionModelRequest<TPrincipal>): Promise<{
    readonly revision: AgentSessionRevision;
  }>;
  setReasoningEffort(
    request: SetAgentSessionReasoningEffortRequest<TPrincipal>,
  ): Promise<{ readonly revision: AgentSessionRevision }>;
  runTurn(
    request: AgentTurnRequest<TPrincipal>,
    options?: AgentTurnRunOptions,
  ): AgentTurnStream;
  resumeInteraction(
    request: ResumeAgentInteractionRequest<TPrincipal>,
    options?: AgentTurnRunOptions,
  ): AgentTurnStream;
  cancel(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly reason?: string;
  }): Promise<CancelAgentSessionResult>;
  recoverInterrupted(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly reason?: string;
  }): Promise<ReadAgentSessionResult<TPrincipal>>;
  delete(request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly expectedRevision?: AgentSessionRevision;
  }): Promise<void>;
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
  const defaultReasoningEffort = optionalReasoningEffort(
    options.defaultReasoningEffort,
    "defaultReasoningEffort",
  );
  const transcriptPolicy = options.transcriptPolicy ?? { mode: "durable" };
  const activeTurns = new Map<string, ActiveEngineTurn>();
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
  }): Promise<ReadAgentSessionResult<TPrincipal>> => {
    const result = await options.sessions.readSession(request);
    if (!result.ok || transcriptPolicy.mode === "durable") return result;
    const messages = await transcriptPolicy.store.readTranscript(request);
    return {
      ...result,
      record: {
        ...result.record,
        messages: structuredClone(messages ?? []),
      },
    };
  };

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
          ...(request.reasoningEffort !== undefined
            ? {
                reasoningEffort: optionalReasoningEffort(
                  request.reasoningEffort,
                  "reasoningEffort",
                ),
              }
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
      async inspect(request: {
        readonly principal: TPrincipal;
        readonly sessionId: string;
      }) {
        return await inspectSession(options, request, false, transcriptPolicy);
      },
      async hydrate(request: {
        readonly principal: TPrincipal;
        readonly sessionId: string;
      }) {
        return await inspectSession(options, request, true, transcriptPolicy);
      },
      async setModel(request: SetAgentSessionModelRequest<TPrincipal>) {
        return await mutateIdleSession(options.sessions, options.turnLeases, {
          principal: request.principal,
          sessionId: request.sessionId,
          expectedRevision: request.expectedRevision,
          turnId: requiredText(createTurnId(), "turnId"),
          ownerId,
          ttlMs: leaseTtlMs,
          now,
          mutate: (record) => ({
            ...record,
            selectedModel: request.model
              ? structuredClone(request.model)
              : undefined,
          }),
        });
      },
      async setReasoningEffort(
        request: SetAgentSessionReasoningEffortRequest<TPrincipal>,
      ) {
        const reasoningEffort = optionalReasoningEffort(
          request.reasoningEffort,
          "reasoningEffort",
        );
        return await mutateIdleSession(options.sessions, options.turnLeases, {
          principal: request.principal,
          sessionId: request.sessionId,
          expectedRevision: request.expectedRevision,
          turnId: requiredText(createTurnId(), "turnId"),
          ownerId,
          ttlMs: leaseTtlMs,
          now,
          mutate: (record) => ({ ...record, reasoningEffort }),
        });
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
            activeTurns,
            acquire: {
              principal: request.principal,
              sessionId: request.sessionId,
              turnId,
            },
            prepare: async (lease, kernelRunOptions) => {
              const current = await requireSession(options.sessions, request);
              assertRunnable(current.record);
              const history = await readTranscript(
                transcriptPolicy,
                current.record,
              );
              const running = await options.sessions.saveSession({
                record: {
                  ...current.record,
                  updatedAt: monotonicTimestamp(current.record.updatedAt, now),
                  messages: durableSessionMessages(transcriptPolicy, history),
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
              const reasoningSelection = resolveAgentReasoningEffort({
                turnReasoningEffort: optionalReasoningEffort(
                  request.reasoningEffort,
                  "reasoningEffort",
                ),
                sessionReasoningEffort: current.record.reasoningEffort,
                runtimeDefaultReasoningEffort: defaultReasoningEffort,
              });
              const prepared: PreparedAgentTurnRequest<TPrincipal> = {
                request: structuredClone(request),
                turnId,
                history: structuredClone(history),
                sessionModel: current.record.selectedModel
                  ? structuredClone(current.record.selectedModel)
                  : undefined,
                runtimeDefaultModel: options.defaultModel
                  ? structuredClone(options.defaultModel)
                  : undefined,
                systemPrompt: formatInstructions(instructions),
                maxOutputTokens,
                reasoningEffort: reasoningSelection?.effort,
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
            activeTurns,
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
      async cancel(request: {
        readonly principal: TPrincipal;
        readonly sessionId: string;
        readonly reason?: string;
      }): Promise<CancelAgentSessionResult> {
        const active = activeTurns.get(
          activeTurnKey(request.principal, request.sessionId),
        );
        if (active) {
          active.abort.abort(
            request.reason ?? "Session cancellation requested",
          );
          return { status: "cancellation_requested", turnId: active.turnId };
        }
        return await cancelInactiveSession({
          options,
          ownerId,
          leaseTtlMs,
          now,
          createTurnId,
          request,
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
      async delete(request: {
        readonly principal: TPrincipal;
        readonly sessionId: string;
        readonly expectedRevision?: AgentSessionRevision;
      }) {
        if (
          activeTurns.has(activeTurnKey(request.principal, request.sessionId))
        ) {
          throw new AgentEngineError(
            "session_busy",
            "Session has an active turn",
          );
        }
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
            request.expectedRevision !== undefined &&
            current.revision !== request.expectedRevision
          ) {
            throw new AgentEngineError(
              "session_revision_conflict",
              "Session revision is stale",
              true,
            );
          }
          const deleted = await options.sessions.deleteSession({
            principal: request.principal,
            sessionId: request.sessionId,
            expectedRevision: current.revision,
            fencingToken: lease.fencingToken,
          });
          if (!deleted.ok) throwSessionMutation(deleted.reason);
          if (transcriptPolicy.mode === "ephemeral") {
            await transcriptPolicy.store.deleteTranscript(request);
          }
        } finally {
          await releaseLease(options.turnLeases, lease);
        }
      },
    }),
  });
}

interface ActiveEngineTurn {
  readonly turnId: string;
  readonly abort: AbortController;
}

async function inspectSession<TPrincipal extends AgentPrincipal>(
  options: CreateAgentEngineOptions<TPrincipal>,
  request: { readonly principal: TPrincipal; readonly sessionId: string },
  hydrate: false,
  transcriptPolicy: AgentTranscriptPolicy<TPrincipal>,
): Promise<AgentSessionInspection<TPrincipal>>;
async function inspectSession<TPrincipal extends AgentPrincipal>(
  options: CreateAgentEngineOptions<TPrincipal>,
  request: { readonly principal: TPrincipal; readonly sessionId: string },
  hydrate: true,
  transcriptPolicy: AgentTranscriptPolicy<TPrincipal>,
): Promise<AgentSessionHydration<TPrincipal>>;
async function inspectSession<TPrincipal extends AgentPrincipal>(
  options: CreateAgentEngineOptions<TPrincipal>,
  request: { readonly principal: TPrincipal; readonly sessionId: string },
  hydrate: boolean,
  transcriptPolicy: AgentTranscriptPolicy<TPrincipal>,
): Promise<
  AgentSessionInspection<TPrincipal> | AgentSessionHydration<TPrincipal>
> {
  const current = await requireSession(options.sessions, request);
  const summary = toSessionSummary(current);
  let pendingInteraction: AgentPendingInteractionSnapshot | undefined;
  if (current.record.pendingInteractionId) {
    if (!options.interactions) {
      throw new AgentEngineError(
        "interaction_not_configured",
        "Session has a pending interaction but no interaction repository is configured",
      );
    }
    const pending = await options.interactions.readInteraction({
      ...request,
      interactionId: current.record.pendingInteractionId,
    });
    if (!pending.ok) {
      throw new AgentEngineError(
        "interaction_not_found",
        "Session pending interaction was not found",
      );
    }
    if (pending.sessionRevision !== current.revision) {
      throw new AgentEngineError(
        "session_revision_conflict",
        "Session changed while its pending interaction was inspected",
        true,
      );
    }
    pendingInteraction = {
      request: structuredClone(pending.record.request),
      interactionRevision: pending.interactionRevision,
      sessionRevision: pending.sessionRevision,
      nextSequence: pending.record.continuation.nextSequence,
    };
  }
  const inspection: AgentSessionInspection<TPrincipal> = {
    summary,
    ...(pendingInteraction ? { pendingInteraction } : {}),
  };
  if (!hydrate) return inspection;
  const messages = await readTranscript(transcriptPolicy, current.record);
  return {
    ...inspection,
    record: {
      ...structuredClone(current.record),
      messages: structuredClone(messages),
    },
  };
}

function toSessionSummary<TPrincipal extends AgentPrincipal>(
  current: Extract<ReadAgentSessionResult<TPrincipal>, { ok: true }>,
): AgentSessionSummary<TPrincipal> {
  return {
    principal: structuredClone(current.record.principal),
    sessionId: current.record.sessionId,
    createdAt: current.record.createdAt,
    updatedAt: current.record.updatedAt,
    ...(current.record.selectedModel
      ? { selectedModel: structuredClone(current.record.selectedModel) }
      : {}),
    ...(current.record.reasoningEffort !== undefined
      ? { reasoningEffort: current.record.reasoningEffort }
      : {}),
    runState: structuredClone(current.record.runState),
    ...(current.record.pendingInteractionId
      ? { pendingInteractionId: current.record.pendingInteractionId }
      : {}),
    revision: current.revision,
  };
}

async function cancelInactiveSession<TPrincipal extends AgentPrincipal>(args: {
  readonly options: CreateAgentEngineOptions<TPrincipal>;
  readonly ownerId: string;
  readonly leaseTtlMs: number;
  readonly now: () => number;
  readonly createTurnId: () => string;
  readonly request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly reason?: string;
  };
}): Promise<CancelAgentSessionResult> {
  const operationTurnId = requiredText(args.createTurnId(), "turnId");
  const lease = await acquireLease(args.options.turnLeases, {
    ...args.request,
    turnId: operationTurnId,
    ownerId: args.ownerId,
    ttlMs: args.leaseTtlMs,
  });
  try {
    let current = await requireSession(args.options.sessions, args.request);
    const activeTurnId =
      current.record.runState.phase === "idle" ||
      current.record.runState.phase === "interrupted"
        ? undefined
        : current.record.runState.turnId;
    if (!activeTurnId) {
      return { status: "not_active", revision: current.revision };
    }

    if (current.record.runState.phase === "suspended") {
      if (!args.options.interactions) {
        throw new AgentEngineError(
          "interaction_not_configured",
          "Session has a pending interaction but no interaction repository is configured",
        );
      }
      const pending = await args.options.interactions.readInteraction({
        principal: args.request.principal,
        sessionId: args.request.sessionId,
        interactionId: current.record.runState.interactionId,
      });
      if (!pending.ok) {
        throw new AgentEngineError(
          "interaction_not_found",
          "Session pending interaction was not found",
        );
      }
      const consumed = await args.options.interactions.consumeInteraction({
        principal: args.request.principal,
        sessionId: args.request.sessionId,
        interactionId: current.record.runState.interactionId,
        expectedInteractionRevision: pending.interactionRevision,
        expectedSessionRevision: pending.sessionRevision,
        fencingToken: lease.fencingToken,
        responseId: randomUUID(),
        decision: "deny",
        consumedAt: readClock(args.now),
      });
      if (!consumed.ok) {
        if (consumed.reason === "stale_fence") {
          throw new AgentEngineError(
            "turn_lease_lost",
            "Turn lease fencing token is stale",
            true,
          );
        }
        if (consumed.reason === "not_found") {
          throw new AgentEngineError(
            "interaction_not_found",
            "Session pending interaction was not found",
          );
        }
        throw new AgentEngineError(
          "session_revision_conflict",
          "Session or interaction changed while cancellation was applied",
          true,
        );
      }
      current = await requireSession(args.options.sessions, args.request);
    }

    const saved = await args.options.sessions.saveSession({
      record: {
        ...current.record,
        updatedAt: monotonicTimestamp(current.record.updatedAt, args.now),
        pendingInteractionId: undefined,
        lastTurnId: activeTurnId,
        runState: {
          phase: "interrupted",
          turnId: activeTurnId,
          interruptedAt: readClock(args.now),
          reason: boundedReason(args.request.reason ?? "Session cancelled"),
        },
      },
      expectedRevision: current.revision,
      fencingToken: lease.fencingToken,
    });
    if (!saved.ok) throwSessionMutation(saved.reason);
    return {
      status: "cancelled",
      turnId: activeTurnId,
      revision: saved.revision,
    };
  } finally {
    await releaseLease(args.options.turnLeases, lease);
  }
}

function activeTurnKey(principal: AgentPrincipal, sessionId: string): string {
  return JSON.stringify([principal.tenantId, principal.subjectId, sessionId]);
}

interface EngineTurnPreparation<TPrincipal extends AgentPrincipal> {
  readonly original: AgentSessionRecord<TPrincipal>;
  readonly stream: AgentTurnStream;
}

async function mutateIdleSession<TPrincipal extends AgentPrincipal>(
  sessions: AgentSessionRepository<TPrincipal>,
  leases: AgentTurnLeaseProvider<TPrincipal>,
  request: {
    readonly principal: TPrincipal;
    readonly sessionId: string;
    readonly expectedRevision: AgentSessionRevision;
    readonly turnId: string;
    readonly ownerId: string;
    readonly ttlMs: number;
    readonly now: () => number;
    readonly mutate: (
      record: AgentSessionRecord<TPrincipal>,
    ) => AgentSessionRecord<TPrincipal>;
  },
): Promise<{ readonly revision: AgentSessionRevision }> {
  const lease = await acquireLease(leases, request);
  try {
    const current = await requireSession(sessions, request);
    assertRunnable(current.record);
    const saved = await sessions.saveSession({
      record: {
        ...request.mutate(current.record),
        updatedAt: monotonicTimestamp(current.record.updatedAt, request.now),
      },
      expectedRevision: request.expectedRevision,
      fencingToken: lease.fencingToken,
    });
    if (!saved.ok) throwSessionMutation(saved.reason);
    return { revision: saved.revision };
  } finally {
    await releaseLease(leases, lease);
  }
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
  readonly activeTurns: Map<string, ActiveEngineTurn>;
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
    const lifecycleAbort = new AbortController();
    const activeKey = activeTurnKey(
      args.acquire.principal,
      args.acquire.sessionId,
    );
    const active: ActiveEngineTurn = {
      turnId: args.acquire.turnId,
      abort: lifecycleAbort,
    };
    args.activeTurns.set(activeKey, active);
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
          lifecycleAbort.signal,
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
          args.options.transcriptPolicy ?? { mode: "durable" },
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
            args.options.transcriptPolicy ?? { mode: "durable" },
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
      if (args.activeTurns.get(activeKey) === active) {
        args.activeTurns.delete(activeKey);
      }
      await releaseLease(args.options.turnLeases, lease);
    }
  })();
}

async function commitAbandonedTurn<TPrincipal extends AgentPrincipal>(
  sessions: AgentSessionRepository<TPrincipal>,
  transcriptPolicy: AgentTranscriptPolicy<TPrincipal>,
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
  const messages = structuredClone(
    durableState?.messages ??
      (await readTranscript(transcriptPolicy, current.record)),
  );
  const saved = await sessions.saveSession({
    record: {
      ...current.record,
      updatedAt: monotonicTimestamp(current.record.updatedAt, now),
      messages: durableSessionMessages(transcriptPolicy, messages),
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
  await writeTranscript(transcriptPolicy, original, messages);
}

async function commitTerminal<TPrincipal extends AgentPrincipal>(
  sessions: AgentSessionRepository<TPrincipal>,
  transcriptPolicy: AgentTranscriptPolicy<TPrincipal>,
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
  const messages = structuredClone(
    durableState?.messages ??
      (await readTranscript(transcriptPolicy, current.record)),
  );
  const durableRecord = {
    ...current.record,
    updatedAt: timestamp,
    messages: durableSessionMessages(transcriptPolicy, messages),
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
  await writeTranscript(transcriptPolicy, original, messages);
  return saved.revision;
}

async function readTranscript<TPrincipal extends AgentPrincipal>(
  policy: AgentTranscriptPolicy<TPrincipal>,
  record: AgentSessionRecord<TPrincipal>,
): Promise<readonly import("./modelRuntime.js").CoreModelMessage[]> {
  if (policy.mode === "durable") return record.messages;
  return (
    (await policy.store.readTranscript({
      principal: record.principal,
      sessionId: record.sessionId,
    })) ?? []
  );
}

function durableSessionMessages<TPrincipal extends AgentPrincipal>(
  policy: AgentTranscriptPolicy<TPrincipal>,
  messages: readonly import("./modelRuntime.js").CoreModelMessage[],
): readonly import("./modelRuntime.js").CoreModelMessage[] {
  return policy.mode === "durable" ? structuredClone(messages) : [];
}

async function writeTranscript<TPrincipal extends AgentPrincipal>(
  policy: AgentTranscriptPolicy<TPrincipal>,
  record: AgentSessionRecord<TPrincipal>,
  messages: readonly import("./modelRuntime.js").CoreModelMessage[],
): Promise<void> {
  if (policy.mode === "durable") return;
  await policy.store.writeTranscript({
    principal: record.principal,
    sessionId: record.sessionId,
    messages,
  });
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

function optionalReasoningEffort(
  value: CoreReasoningEffort | undefined,
  field: string,
): CoreReasoningEffort | undefined {
  if (value !== undefined && !isCoreReasoningEffort(value)) {
    throw new AgentEngineError(
      "invalid_engine_configuration",
      `${field} must be a supported reasoning effort`,
    );
  }
  return value;
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
