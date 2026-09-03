import { createAgentEngine, type AgentEngine } from "./agentEngine.js";
import { defineTool } from "./hostTools.js";
import type { AgentModelReference, AgentPrincipal } from "./modelIdentity.js";
import {
  CoreModelBackendRegistry,
  DefaultCoreModelRuntime,
  type CoreModelBackend,
  type CoreModelCapabilities,
  type CoreModelCompleteRequest,
  type CoreModelRequestContext,
  type CoreModelStreamEvent,
  type CoreModelStreamRequest,
} from "./modelRuntime.js";
import type { AgentSessionRepository } from "./sessionRepository.js";
import type {
  AgentTurnEvent,
  AgentTurnResult,
  AgentTurnStream,
} from "./turnContracts.js";
import {
  createTurnInteractionTokenService,
  type DurableToolInteractionRepository,
} from "./turnInteractions.js";
import type { AgentTurnLeaseProvider } from "./turnLeases.js";

const FIXTURE_MODEL: AgentModelReference = {
  providerId: "agentlink-approval-fixture",
  modelId: "scripted-model",
};
const FIXTURE_CAPABILITIES: CoreModelCapabilities = {
  supportsThinking: false,
  supportsCaching: false,
  supportsImages: false,
  supportsToolUse: true,
  contextWindow: 8_192,
  maxOutputTokens: 1_024,
};

export interface HostApprovalContractPersistence<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly sessions: AgentSessionRepository<TPrincipal>;
  readonly interactions: DurableToolInteractionRepository<TPrincipal>;
  readonly turnLeases: AgentTurnLeaseProvider<TPrincipal>;
}

export interface HostApprovalContractAdapter<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly principal: TPrincipal;
  readonly otherPrincipal: TPrincipal;
  /** Return fresh wrappers over the same durable backing store for restart checks. */
  readonly createPersistence: () =>
    | HostApprovalContractPersistence<TPrincipal>
    | Promise<HostApprovalContractPersistence<TPrincipal>>;
  readonly createSessionId: (label: string) => string;
  readonly now?: () => number;
}

export interface HostApprovalContractReport {
  readonly allowedWriteCount: 1;
  readonly deniedWriteCount: 0;
  readonly replayRejected: true;
  readonly revisionTamperingRejected: true;
  readonly principalIsolation: true;
  readonly restartResume: true;
}

/**
 * Framework-free host approval conformance runner. It exercises host persistence
 * through real engine suspension/resume operations and throws on any violation.
 */
export async function runHostApprovalContract<
  TPrincipal extends AgentPrincipal,
>(
  adapter: HostApprovalContractAdapter<TPrincipal>,
): Promise<HostApprovalContractReport> {
  const now = adapter.now ?? Date.now;
  let interactionCounter = 0;
  let turnCounter = 0;
  let allowedWriteCount = 0;
  let deniedWriteCount = 0;
  const createEngine = async (
    ownerId: string,
    turns: readonly (readonly CoreModelStreamEvent[])[],
    countWrite: () => void,
  ): Promise<AgentEngine<TPrincipal>> => {
    const persistence = await adapter.createPersistence();
    const backend = new HostApprovalFixtureModelBackend(turns);
    const registry = new CoreModelBackendRegistry();
    registry.register(backend);
    return createAgentEngine({
      ownerId,
      models: new DefaultCoreModelRuntime(registry, { ownerId }),
      sessions: persistence.sessions,
      interactions: persistence.interactions,
      turnLeases: persistence.turnLeases,
      interactionTokens: createTurnInteractionTokenService({
        secret: "agentlink-host-approval-fixture-secret",
        now,
        createResponseId: () => `response-${++interactionCounter}`,
      }),
      defaultModel: FIXTURE_MODEL,
      maxOutputTokens: 1_024,
      resolveInstructions: () => "Run only the scripted approval fixture.",
      resolveTools: () => [
        defineTool<TPrincipal>({
          name: "approval_fixture_write",
          description: "Record one synthetic approved write",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
          effect: "write",
          authorization: "required",
          displayInput: (input) => ({ value: input.value }),
          handler: async () => {
            countWrite();
            return { modelContent: "synthetic write recorded" };
          },
        }),
      ],
      authorizeToolCall: () => ({
        decision: "require_user",
        summary: "Approve the synthetic fixture write?",
      }),
      createTurnId: () => `turn-${++turnCounter}`,
      createInteractionId: () => `interaction-${++interactionCounter}`,
      now,
      leaseTtlMs: 60_000,
      leaseRenewIntervalMs: 30_000,
    });
  };

  const allowSessionId = adapter.createSessionId("approval-allow");
  const first = await createEngine(
    "approval-fixture-first",
    [toolTurn()],
    () => {
      allowedWriteCount += 1;
    },
  );
  await first.sessions.create({
    principal: adapter.principal,
    sessionId: allowSessionId,
  });
  const suspended = await collectTurn(
    first.sessions.runTurn({
      principal: adapter.principal,
      sessionId: allowSessionId,
      input: { text: "perform the synthetic write", attachments: undefined },
      model: undefined,
    }),
  );
  assert(
    suspended.result.status === "suspended",
    `allow turn must suspend (received ${suspended.result.status}${suspended.result.status === "failed" ? `: ${suspended.result.error.code} ${suspended.result.error.message}` : ""})`,
  );
  if (suspended.result.status !== "suspended") throw new Error("unreachable");
  const interaction = suspended.result.interaction;
  const required = requiredInteraction(suspended.events);

  let principalIsolation = false;
  try {
    await collectTurn(
      first.sessions.resumeInteraction({
        principal: adapter.otherPrincipal,
        sessionId: allowSessionId,
        turnId: interactionTurnId(suspended.events),
        interactionId: interaction.interactionId,
        interactionRevision: required.interactionRevision,
        expectedSessionRevision: required.sessionRevision,
        decision: "allow",
      }),
    );
  } catch {
    principalIsolation = true;
  }
  assert(principalIsolation, "cross-principal resume must fail");
  assert(allowedWriteCount === 0, "cross-principal resume must not execute");

  let revisionTamperingRejected = false;
  try {
    await collectTurn(
      first.sessions.resumeInteraction({
        principal: adapter.principal,
        sessionId: allowSessionId,
        turnId: interactionTurnId(suspended.events),
        interactionId: interaction.interactionId,
        interactionRevision: `${required.interactionRevision}-tampered`,
        expectedSessionRevision: required.sessionRevision,
        decision: "allow",
      }),
    );
  } catch {
    revisionTamperingRejected = true;
  }
  assert(revisionTamperingRejected, "tampered interaction revision must fail");
  assert(allowedWriteCount === 0, "tampered revision must not execute");

  const restarted = await createEngine(
    "approval-fixture-restarted",
    [finalTurn("approved")],
    () => {
      allowedWriteCount += 1;
    },
  );
  const allowed = await collectTurn(
    restarted.sessions.resumeInteraction({
      principal: adapter.principal,
      sessionId: allowSessionId,
      turnId: interactionTurnId(suspended.events),
      interactionId: interaction.interactionId,
      interactionRevision: required.interactionRevision,
      expectedSessionRevision: required.sessionRevision,
      decision: "allow",
    }),
  );
  assert(allowed.result.status === "completed", "allowed resume must complete");
  assert(
    Number(allowedWriteCount) === 1,
    "allowed resume must execute exactly once",
  );

  let replayRejected = false;
  try {
    await collectTurn(
      restarted.sessions.resumeInteraction({
        principal: adapter.principal,
        sessionId: allowSessionId,
        turnId: interactionTurnId(suspended.events),
        interactionId: interaction.interactionId,
        interactionRevision: required.interactionRevision,
        expectedSessionRevision: required.sessionRevision,
        decision: "allow",
      }),
    );
  } catch {
    replayRejected = true;
  }
  assert(replayRejected, "consumed interaction replay must fail");
  assert(Number(allowedWriteCount) === 1, "replay must not execute again");

  const denySessionId = adapter.createSessionId("approval-deny");
  const denyFirst = await createEngine(
    "approval-fixture-deny-first",
    [toolTurn()],
    () => {
      deniedWriteCount += 1;
    },
  );
  await denyFirst.sessions.create({
    principal: adapter.principal,
    sessionId: denySessionId,
  });
  const denySuspended = await collectTurn(
    denyFirst.sessions.runTurn({
      principal: adapter.principal,
      sessionId: denySessionId,
      input: { text: "deny the synthetic write", attachments: undefined },
      model: undefined,
    }),
  );
  assert(denySuspended.result.status === "suspended", "deny turn must suspend");
  if (denySuspended.result.status !== "suspended")
    throw new Error("unreachable");
  const denyRequired = requiredInteraction(denySuspended.events);
  const denyRestarted = await createEngine(
    "approval-fixture-deny-restarted",
    [finalTurn("denied")],
    () => {
      deniedWriteCount += 1;
    },
  );
  const denied = await collectTurn(
    denyRestarted.sessions.resumeInteraction({
      principal: adapter.principal,
      sessionId: denySessionId,
      turnId: interactionTurnId(denySuspended.events),
      interactionId: denySuspended.result.interaction.interactionId,
      interactionRevision: denyRequired.interactionRevision,
      expectedSessionRevision: denyRequired.sessionRevision,
      decision: "deny",
    }),
  );
  assert(denied.result.status === "completed", "denied resume must complete");
  assert(deniedWriteCount === 0, "denied resume must never execute the write");

  return {
    allowedWriteCount: 1,
    deniedWriteCount: 0,
    replayRejected: true,
    revisionTamperingRejected: true,
    principalIsolation: true,
    restartResume: true,
  };
}

/** Deterministic model backend available for additional host-level fixtures. */
export class HostApprovalFixtureModelBackend implements CoreModelBackend {
  readonly providerId = FIXTURE_MODEL.providerId;
  readonly displayName = "AgentLink approval fixture";
  readonly condenseModel = FIXTURE_MODEL.modelId;
  private readonly turns: Array<readonly CoreModelStreamEvent[]>;

  constructor(turns: readonly (readonly CoreModelStreamEvent[])[]) {
    this.turns = [...turns];
  }

  listModels() {
    return [
      {
        id: FIXTURE_MODEL.modelId,
        displayName: "Scripted approval model",
        providerId: this.providerId,
        contextWindow: FIXTURE_CAPABILITIES.contextWindow,
        maxOutputTokens: FIXTURE_CAPABILITIES.maxOutputTokens,
        authenticated: true,
      },
    ];
  }

  getCapabilities(): CoreModelCapabilities {
    return FIXTURE_CAPABILITIES;
  }

  async *stream(
    request: CoreModelStreamRequest,
    _context: CoreModelRequestContext,
  ): AsyncGenerator<CoreModelStreamEvent> {
    request.onProviderRequestAttempt?.({ model: request.model });
    const turn = this.turns.shift();
    if (!turn)
      throw new Error("Host approval fixture has no scripted turn left");
    yield* turn;
  }

  async complete(
    _request: CoreModelCompleteRequest,
    _context: CoreModelRequestContext,
  ) {
    return { text: "unused" };
  }
}

function toolTurn(): readonly CoreModelStreamEvent[] {
  const input = { value: "synthetic" };
  return [
    {
      type: "tool_done",
      toolCallId: "approval-fixture-call",
      toolName: "approval_fixture_write",
      input,
    },
    {
      type: "model_stop",
      reason: "tool_use",
      assistantMessage: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "approval-fixture-call",
            name: "approval_fixture_write",
            input,
          },
        ],
      },
    },
    { type: "done" },
  ];
}

function finalTurn(text: string): readonly CoreModelStreamEvent[] {
  return [
    { type: "text_delta", text },
    {
      type: "model_stop",
      reason: "end_turn",
      assistantMessage: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    },
    { type: "done" },
  ];
}

async function collectTurn(stream: AgentTurnStream): Promise<{
  events: AgentTurnEvent[];
  result: AgentTurnResult;
}> {
  const events: AgentTurnEvent[] = [];
  for (;;) {
    const next = await stream.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

function interactionTurnId(events: readonly AgentTurnEvent[]): string {
  return requiredInteraction(events).turnId;
}

function requiredInteraction(
  events: readonly AgentTurnEvent[],
): Extract<AgentTurnEvent, { type: "interaction.required" }> {
  const required = events.find(
    (
      event,
    ): event is Extract<AgentTurnEvent, { type: "interaction.required" }> =>
      event.type === "interaction.required",
  );
  if (!required)
    throw new Error("Host approval fixture interaction event missing");
  return required;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new Error(`Agent host approval contract failed: ${message}`);
}
