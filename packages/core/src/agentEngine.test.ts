import { describe, expect, it } from "vitest";

import { createAgentEngine, type AgentEngine } from "./agentEngine.js";
import { defineTool } from "./hostTools.js";
import type { AgentPrincipal } from "./modelIdentity.js";
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
import {
  InMemoryAgentStateRepository,
  InMemoryAgentTranscriptStore,
} from "./sessionRepository.js";
import type { AgentTurnEvent, AgentTurnResult } from "./turnContracts.js";
import { createTurnInteractionTokenService } from "./turnInteractions.js";
import {
  InMemoryAgentTurnLeaseProvider,
  type AgentTurnLeaseProvider,
} from "./turnLeases.js";

const PRINCIPAL = { tenantId: "tenant-a", subjectId: "subject-a" };
const MODEL = { providerId: "fake", modelId: "model-a" };
const CAPS: CoreModelCapabilities = {
  supportsThinking: false,
  supportsCaching: false,
  supportsImages: false,
  supportsToolUse: true,
  contextWindow: 32_768,
  maxOutputTokens: 4_096,
};

class ScriptedBackend implements CoreModelBackend {
  readonly providerId = MODEL.providerId;
  readonly displayName = "Fake";
  readonly condenseModel = MODEL.modelId;
  readonly requests: CoreModelStreamRequest[] = [];

  constructor(
    private readonly turns: Array<
      | readonly CoreModelStreamEvent[]
      | (() => AsyncGenerator<CoreModelStreamEvent>)
    >,
    private readonly capabilities: CoreModelCapabilities = CAPS,
  ) {}

  listModels() {
    return [
      {
        id: MODEL.modelId,
        displayName: "Fake model",
        providerId: this.providerId,
        contextWindow: this.capabilities.contextWindow,
        maxOutputTokens: this.capabilities.maxOutputTokens,
        authenticated: true,
      },
    ];
  }

  getCapabilities(): CoreModelCapabilities {
    return this.capabilities;
  }

  async *stream(
    request: CoreModelStreamRequest,
    _context: CoreModelRequestContext,
  ): AsyncGenerator<CoreModelStreamEvent> {
    this.requests.push(request);
    request.onProviderRequestAttempt?.({ model: request.model });
    const turn = this.turns.shift();
    if (!turn) throw new Error("No scripted turn remains");
    if (typeof turn === "function") {
      yield* turn();
      return;
    }
    yield* turn;
  }

  async complete(
    _request: CoreModelCompleteRequest,
    _context: CoreModelRequestContext,
  ) {
    return { text: "unused" };
  }
}

function finalTurn(text: string): readonly CoreModelStreamEvent[] {
  return [
    { type: "text_delta", text },
    { type: "usage", inputTokens: 7, outputTokens: 2 },
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

function toolTurn(): readonly CoreModelStreamEvent[] {
  return [
    {
      type: "tool_done",
      toolCallId: "call-1",
      toolName: "write_record",
      input: { value: "new" },
    },
    {
      type: "model_stop",
      reason: "tool_use",
      assistantMessage: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-1",
            name: "write_record",
            input: { value: "new" },
          },
        ],
      },
    },
    { type: "done" },
  ];
}

function runtime(backend: ScriptedBackend) {
  const registry = new CoreModelBackendRegistry();
  registry.register(backend);
  return new DefaultCoreModelRuntime(registry, { ownerId: "test" });
}

function engine(
  backend: ScriptedBackend,
  state: InMemoryAgentStateRepository = new InMemoryAgentStateRepository(),
  leases: AgentTurnLeaseProvider = new InMemoryAgentTurnLeaseProvider(),
  overrides: Partial<Parameters<typeof createAgentEngine>[0]> = {},
): AgentEngine {
  return createAgentEngine({
    ownerId: "engine-a",
    models: runtime(backend),
    sessions: state,
    turnLeases: leases,
    interactions: state,
    interactionTokens: createTurnInteractionTokenService({
      secret: "0123456789abcdef0123456789abcdef",
      createResponseId: () => "response-1",
    }),
    defaultModel: MODEL,
    resolveInstructions: () => "You are a test assistant.",
    createSessionId: () => "session-1",
    createTurnId: () => "turn-1",
    createInteractionId: () => "interaction-1",
    leaseTtlMs: 60_000,
    leaseRenewIntervalMs: 30_000,
    ...overrides,
  });
}

async function collect(
  stream: AsyncGenerator<AgentTurnEvent, AgentTurnResult>,
) {
  const events: AgentTurnEvent[] = [];
  for (;;) {
    const next = await stream.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

describe("public E6 agent engine", () => {
  it("creates a session and commits exact completed transcript state", async () => {
    const state = new InMemoryAgentStateRepository();
    const backend = new ScriptedBackend([finalTurn("Hello")]);
    const agent = engine(backend, state);
    await expect(
      agent.sessions.create({ principal: PRINCIPAL }),
    ).resolves.toMatchObject({
      revision: "1",
      record: { sessionId: "session-1", runState: { phase: "idle" } },
    });

    const run = await collect(
      agent.sessions.runTurn({
        principal: PRINCIPAL,
        sessionId: "session-1",
        input: { text: "Hi", attachments: undefined },
        model: undefined,
      }),
    );

    expect(run.result).toMatchObject({
      status: "completed",
      text: "Hello",
      sessionRevision: "3",
    });
    expect(run.events.at(-1)).toMatchObject({
      type: "turn.completed",
      result: { sessionRevision: "3" },
    });
    await expect(
      state.readSession({ principal: PRINCIPAL, sessionId: "session-1" }),
    ).resolves.toMatchObject({
      revision: "3",
      record: {
        messages: [
          { role: "user", content: "Hi" },
          {
            role: "assistant",
            content: [{ type: "text", text: "Hello" }],
          },
        ],
        usage: { inputTokens: 7, outputTokens: 2 },
        runState: { phase: "idle" },
      },
    });
  });

  it("keeps ordinary transcripts ephemeral while preserving conversational history", async () => {
    const state = new InMemoryAgentStateRepository();
    const transcripts = new InMemoryAgentTranscriptStore();
    const backend = new ScriptedBackend([
      finalTurn("First"),
      finalTurn("Second"),
    ]);
    const agent = engine(backend, state, undefined, {
      transcriptPolicy: { mode: "ephemeral", store: transcripts },
    });
    await agent.sessions.create({ principal: PRINCIPAL });

    await collect(
      agent.sessions.runTurn({
        principal: PRINCIPAL,
        sessionId: "session-1",
        input: { text: "one", attachments: undefined },
        model: undefined,
      }),
    );
    await collect(
      agent.sessions.runTurn({
        principal: PRINCIPAL,
        sessionId: "session-1",
        input: { text: "two", attachments: undefined },
        model: undefined,
      }),
    );

    expect(backend.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        { role: "user", content: "one" },
        {
          role: "assistant",
          content: [{ type: "text", text: "First" }],
        },
      ]),
    );
    await expect(
      state.readSession({ principal: PRINCIPAL, sessionId: "session-1" }),
    ).resolves.toMatchObject({ record: { messages: [] } });
    await expect(
      agent.sessions.hydrate({ principal: PRINCIPAL, sessionId: "session-1" }),
    ).resolves.toMatchObject({
      summary: { sessionId: "session-1", runState: { phase: "idle" } },
      record: {
        messages: [
          { role: "user", content: "one" },
          {
            role: "assistant",
            content: [{ type: "text", text: "First" }],
          },
          { role: "user", content: "two" },
          {
            role: "assistant",
            content: [{ type: "text", text: "Second" }],
          },
        ],
      },
    });
    await expect(
      agent.sessions.inspect({ principal: PRINCIPAL, sessionId: "session-1" }),
    ).resolves.toEqual(
      expect.not.objectContaining({ record: expect.anything() }),
    );
  });

  it("applies turn, session, and runtime reasoning effort precedence", async () => {
    const backend = new ScriptedBackend(
      [
        finalTurn("runtime"),
        finalTurn("session"),
        finalTurn("turn"),
        finalTurn("disabled"),
      ],
      {
        ...CAPS,
        supportsThinking: true,
        reasoningEfforts: ["none", "low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
    );
    const agent = engine(backend, undefined, undefined, {
      defaultReasoningEffort: "medium",
    });
    await agent.sessions.create({
      principal: PRINCIPAL,
      sessionId: "runtime",
    });
    await agent.sessions.create({
      principal: PRINCIPAL,
      sessionId: "session",
      reasoningEffort: "low",
    });
    await agent.sessions.create({
      principal: PRINCIPAL,
      sessionId: "turn",
      reasoningEffort: "low",
    });
    await agent.sessions.create({
      principal: PRINCIPAL,
      sessionId: "disabled",
    });

    for (const [sessionId, reasoningEffort] of [
      ["runtime", undefined],
      ["session", undefined],
      ["turn", "high"],
      ["disabled", "none"],
    ] as const) {
      await collect(
        agent.sessions.runTurn({
          principal: PRINCIPAL,
          sessionId,
          input: { text: sessionId, attachments: undefined },
          model: undefined,
          ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        }),
      );
    }

    expect(backend.requests.map((request) => request.reasoningEffort)).toEqual([
      "medium",
      "low",
      "high",
      "none",
    ]);
  });

  it("updates and clears a session reasoning default with revision checks", async () => {
    const backend = new ScriptedBackend([]);
    const agent = engine(backend);
    const created = await agent.sessions.create({ principal: PRINCIPAL });

    const updated = await agent.sessions.setReasoningEffort({
      principal: PRINCIPAL,
      sessionId: "session-1",
      reasoningEffort: "high",
      expectedRevision: created.revision,
    });
    await expect(
      agent.sessions.read({ principal: PRINCIPAL, sessionId: "session-1" }),
    ).resolves.toMatchObject({
      revision: updated.revision,
      record: { reasoningEffort: "high" },
    });

    await expect(
      agent.sessions.setReasoningEffort({
        principal: PRINCIPAL,
        sessionId: "session-1",
        reasoningEffort: undefined,
        expectedRevision: created.revision,
      }),
    ).rejects.toMatchObject({ code: "session_revision_conflict" });
    const cleared = await agent.sessions.setReasoningEffort({
      principal: PRINCIPAL,
      sessionId: "session-1",
      reasoningEffort: undefined,
      expectedRevision: updated.revision,
    });
    await expect(
      agent.sessions.read({ principal: PRINCIPAL, sessionId: "session-1" }),
    ).resolves.toMatchObject({
      revision: cleared.revision,
      record: { reasoningEffort: undefined },
    });
  });

  it("excludes a concurrent engine before either can advance the same session", async () => {
    const state = new InMemoryAgentStateRepository();
    const leases = new InMemoryAgentTurnLeaseProvider();
    let started!: () => void;
    let finish!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const finishPromise = new Promise<void>((resolve) => (finish = resolve));
    const backend = new ScriptedBackend([
      async function* () {
        started();
        await finishPromise;
        yield* finalTurn("first");
      },
      finalTurn("second"),
    ]);
    const first = engine(backend, state, leases);
    const second = engine(backend, state, leases, { ownerId: "engine-b" });
    await first.sessions.create({ principal: PRINCIPAL });

    const active = collect(
      first.sessions.runTurn({
        principal: PRINCIPAL,
        sessionId: "session-1",
        input: { text: "first", attachments: undefined },
        model: undefined,
      }),
    );
    await startedPromise;
    await expect(
      collect(
        second.sessions.runTurn({
          principal: PRINCIPAL,
          sessionId: "session-1",
          input: { text: "second", attachments: undefined },
          model: undefined,
        }),
      ),
    ).rejects.toMatchObject({ code: "turn_lease_held" });
    finish();
    await expect(active).resolves.toMatchObject({
      result: { status: "completed" },
    });
    expect(backend.requests).toHaveLength(1);
  });

  it("retains the terminal result when its durable commit conflicts", async () => {
    const state = new InMemoryAgentStateRepository();
    const backend = new ScriptedBackend([
      finalTurn("completed but uncommitted"),
    ]);
    const repository = {
      ...state,
      createSession: state.createSession.bind(state),
      readSession: state.readSession.bind(state),
      listSessions: state.listSessions.bind(state),
      deleteSession: state.deleteSession.bind(state),
      saveSession: async (request: Parameters<typeof state.saveSession>[0]) => {
        if (request.record.runState.phase === "idle") {
          return {
            ok: false as const,
            reason: "revision_conflict" as const,
            currentRevision: "conflicting-revision",
          };
        }
        return await state.saveSession(request);
      },
    };
    const agent = engine(backend, state, new InMemoryAgentTurnLeaseProvider(), {
      sessions: repository,
    });
    await agent.sessions.create({ principal: PRINCIPAL });

    await expect(
      collect(
        agent.sessions.runTurn({
          principal: PRINCIPAL,
          sessionId: "session-1",
          input: { text: "finish", attachments: undefined },
          model: undefined,
        }),
      ),
    ).rejects.toMatchObject({
      code: "session_revision_conflict",
      terminalResult: {
        status: "completed",
        text: "completed but uncommitted",
        usage: { inputTokens: 7, outputTokens: 2 },
      },
    });
  });

  it("cancels an active local turn through the session lifecycle API", async () => {
    const state = new InMemoryAgentStateRepository();
    let observedSignal: AbortSignal | undefined;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const backend = new ScriptedBackend([
      async function* () {
        started();
        while (!observedSignal?.aborted) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        yield { type: "done" };
      },
    ]);
    const originalStream = backend.stream.bind(backend);
    backend.stream = async function* (request, context) {
      observedSignal = request.signal;
      yield* originalStream(request, context);
    };
    const agent = engine(backend, state);
    await agent.sessions.create({ principal: PRINCIPAL });
    const running = collect(
      agent.sessions.runTurn({
        principal: PRINCIPAL,
        sessionId: "session-1",
        input: { text: "wait", attachments: undefined },
        model: undefined,
      }),
    );
    await startedPromise;

    await expect(
      agent.sessions.cancel({
        principal: PRINCIPAL,
        sessionId: "session-1",
        reason: "user stopped",
      }),
    ).resolves.toEqual({ status: "cancellation_requested", turnId: "turn-1" });
    await expect(running).resolves.toMatchObject({
      result: { status: "cancelled" },
    });
    await expect(
      agent.sessions.inspect({ principal: PRINCIPAL, sessionId: "session-1" }),
    ).resolves.toMatchObject({
      summary: { runState: { phase: "idle" } },
    });
  });

  it("settles physical execution before releasing a lease when the consumer closes", async () => {
    const state = new InMemoryAgentStateRepository();
    let observedSignal: AbortSignal | undefined;
    let releaseCount = 0;
    const backend = new ScriptedBackend([
      async function* () {
        yield { type: "text_delta", text: "started" };
        while (!observedSignal?.aborted) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
      },
    ]);
    const baseLeases = new InMemoryAgentTurnLeaseProvider();
    const leases: AgentTurnLeaseProvider = {
      acquireTurnLease: baseLeases.acquireTurnLease.bind(baseLeases),
      renewTurnLease: baseLeases.renewTurnLease.bind(baseLeases),
      validateTurnLease: baseLeases.validateTurnLease.bind(baseLeases),
      async releaseTurnLease(request) {
        expect(observedSignal?.aborted).toBe(true);
        releaseCount += 1;
        return await baseLeases.releaseTurnLease(request);
      },
    };
    const agent = engine(backend, state, leases, {
      resolveAuthContext() {
        return undefined;
      },
    });
    const originalStream = backend.stream.bind(backend);
    backend.stream = async function* (request, context) {
      observedSignal = request.signal;
      yield* originalStream(request, context);
    };
    await agent.sessions.create({ principal: PRINCIPAL });
    const stream = agent.sessions.runTurn({
      principal: PRINCIPAL,
      sessionId: "session-1",
      input: { text: "wait", attachments: undefined },
      model: undefined,
    });

    await stream.next();
    await stream.return(undefined as never);

    expect(releaseCount).toBe(1);
    await expect(
      state.readSession({ principal: PRINCIPAL, sessionId: "session-1" }),
    ).resolves.toMatchObject({
      record: {
        runState: {
          phase: "interrupted",
          reason: "Turn event consumer closed the stream",
        },
      },
    });
  });

  it("waits for an in-flight renewal before releasing the lease", async () => {
    const state = new InMemoryAgentStateRepository();
    let finishRenewal!: () => void;
    const renewalBlocked = new Promise<void>(
      (resolve) => (finishRenewal = resolve),
    );
    let renewalStarted!: () => void;
    const started = new Promise<void>((resolve) => (renewalStarted = resolve));
    let released = false;
    const baseLeases = new InMemoryAgentTurnLeaseProvider();
    const leases: AgentTurnLeaseProvider = {
      acquireTurnLease: baseLeases.acquireTurnLease.bind(baseLeases),
      validateTurnLease: baseLeases.validateTurnLease.bind(baseLeases),
      async renewTurnLease(request) {
        renewalStarted();
        await renewalBlocked;
        return await baseLeases.renewTurnLease(request);
      },
      async releaseTurnLease(request) {
        released = true;
        return await baseLeases.releaseTurnLease(request);
      },
    };
    const backend = new ScriptedBackend([
      async function* () {
        await started;
        yield* finalTurn("done");
      },
    ]);
    const agent = engine(backend, state, leases, {
      leaseTtlMs: 50,
      leaseRenewIntervalMs: 5,
    });
    await agent.sessions.create({ principal: PRINCIPAL });
    const run = collect(
      agent.sessions.runTurn({
        principal: PRINCIPAL,
        sessionId: "session-1",
        input: { text: "wait", attachments: undefined },
        model: undefined,
      }),
    );
    await started;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(released).toBe(false);
    finishRenewal();
    await expect(run).resolves.toMatchObject({
      result: { status: "completed" },
    });
    expect(released).toBe(true);
  });

  it("aborts physical execution when lease renewal reports loss", async () => {
    const state = new InMemoryAgentStateRepository();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => (resolveStarted = resolve));
    const backend = new ScriptedBackend([
      async function* () {
        resolveStarted();
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        yield* finalTurn("late");
      },
    ]);
    const baseLeases = new InMemoryAgentTurnLeaseProvider();
    const leases: AgentTurnLeaseProvider = {
      ...baseLeases,
      acquireTurnLease: baseLeases.acquireTurnLease.bind(baseLeases),
      releaseTurnLease: baseLeases.releaseTurnLease.bind(baseLeases),
      validateTurnLease: baseLeases.validateTurnLease.bind(baseLeases),
      async renewTurnLease() {
        return { ok: false as const, reason: "lost" as const };
      },
    };
    const agent = engine(backend, state, leases, {
      leaseTtlMs: 20,
      leaseRenewIntervalMs: 5,
    });
    await agent.sessions.create({ principal: PRINCIPAL });
    const run = collect(
      agent.sessions.runTurn({
        principal: PRINCIPAL,
        sessionId: "session-1",
        input: { text: "wait", attachments: undefined },
        model: undefined,
      }),
    );
    await started;
    await expect(run).rejects.toMatchObject({
      code: "turn_lease_lost",
      retryable: true,
    });
    await expect(
      state.readSession({ principal: PRINCIPAL, sessionId: "session-1" }),
    ).resolves.toMatchObject({
      record: { runState: { phase: "running" } },
    });
  });

  it("resumes a durable interaction on another engine with a newer fence", async () => {
    const state = new InMemoryAgentStateRepository();
    const leases = new InMemoryAgentTurnLeaseProvider();
    const backend = new ScriptedBackend([toolTurn(), finalTurn("Updated")]);
    const write = defineTool({
      name: "write_record",
      description: "Update a record",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      effect: "write",
      authorization: "required",
      handler: async () => ({ modelContent: "updated" }),
    });
    const first = engine(backend, state, leases, {
      resolveTools: () => [write],
      authorizeToolCall: () => ({
        decision: "require_user",
        summary: "Approve record update",
      }),
    });
    const second = engine(backend, state, leases, {
      ownerId: "engine-b",
      resolveTools: () => [write],
      authorizeToolCall: () => ({ decision: "allow" }),
    });
    await first.sessions.create({ principal: PRINCIPAL });

    const suspended = await collect(
      first.sessions.runTurn({
        principal: PRINCIPAL,
        sessionId: "session-1",
        input: { text: "Update it", attachments: undefined },
        model: undefined,
      }),
    );
    expect(suspended.result).toMatchObject({ status: "suspended" });
    const required = suspended.events.find(
      (
        event,
      ): event is Extract<AgentTurnEvent, { type: "interaction.required" }> =>
        event.type === "interaction.required",
    );
    expect(required).toBeDefined();
    expect(suspended.result).toMatchObject({
      status: "suspended",
      sessionRevision: "3",
    });

    const resumed = await collect(
      second.sessions.resumeInteraction({
        principal: PRINCIPAL,
        sessionId: "session-1",
        turnId: "turn-1",
        interactionId: required!.interaction.interactionId,
        interactionRevision: required!.interactionRevision,
        expectedSessionRevision: required!.sessionRevision,
        decision: "allow",
      }),
    );
    expect(resumed.result).toMatchObject({
      status: "completed",
      text: "Updated",
      sessionRevision: "5",
    });
    await expect(
      state.readSession({ principal: PRINCIPAL, sessionId: "session-1" }),
    ).resolves.toMatchObject({
      revision: "5",
      fencingToken: "2",
      record: {
        runState: { phase: "idle" },
        pendingInteractionId: undefined,
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "assistant" }),
          expect.objectContaining({ role: "user" }),
        ]),
      },
    });
  });

  it("resumes a durable approval without persisting ordinary session messages", async () => {
    const state = new InMemoryAgentStateRepository();
    const transcripts = new InMemoryAgentTranscriptStore();
    const leases = new InMemoryAgentTurnLeaseProvider();
    const backend = new ScriptedBackend([toolTurn(), finalTurn("Updated")]);
    const write = defineTool({
      name: "write_record",
      description: "Update a record",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      effect: "write",
      authorization: "required",
      handler: async () => ({ modelContent: "updated" }),
    });
    const shared = {
      transcriptPolicy: { mode: "ephemeral" as const, store: transcripts },
      resolveTools: () => [write],
    };
    const first = engine(backend, state, leases, {
      ...shared,
      authorizeToolCall: () => ({
        decision: "require_user",
        summary: "Approve record update",
      }),
    });
    const second = engine(backend, state, leases, {
      ...shared,
      ownerId: "engine-b",
      authorizeToolCall: () => ({ decision: "allow" }),
    });
    await first.sessions.create({ principal: PRINCIPAL });

    const suspended = await collect(
      first.sessions.runTurn({
        principal: PRINCIPAL,
        sessionId: "session-1",
        input: { text: "Update it", attachments: undefined },
        model: undefined,
      }),
    );
    const required = suspended.events.find(
      (
        event,
      ): event is Extract<AgentTurnEvent, { type: "interaction.required" }> =>
        event.type === "interaction.required",
    );
    expect(required).toBeDefined();
    await expect(
      state.readSession({ principal: PRINCIPAL, sessionId: "session-1" }),
    ).resolves.toMatchObject({
      record: {
        messages: [],
        runState: { phase: "suspended" },
      },
    });

    const resumed = await collect(
      second.sessions.resumeInteraction({
        principal: PRINCIPAL,
        sessionId: "session-1",
        turnId: "turn-1",
        interactionId: required!.interaction.interactionId,
        interactionRevision: required!.interactionRevision,
        expectedSessionRevision: required!.sessionRevision,
        decision: "allow",
      }),
    );
    expect(resumed.result).toMatchObject({
      status: "completed",
      text: "Updated",
    });
    await expect(
      state.readSession({ principal: PRINCIPAL, sessionId: "session-1" }),
    ).resolves.toMatchObject({
      record: { messages: [], runState: { phase: "idle" } },
    });
    await expect(
      second.sessions.read({ principal: PRINCIPAL, sessionId: "session-1" }),
    ).resolves.toMatchObject({
      record: {
        messages: expect.arrayContaining([
          { role: "user", content: "Update it" },
          expect.objectContaining({ role: "assistant" }),
        ]),
      },
    });
    await expect(
      state.readInteraction({
        principal: PRINCIPAL,
        sessionId: "session-1",
        interactionId: required!.interaction.interactionId,
      }),
    ).resolves.toEqual({ ok: false, reason: "consumed" });
  });

  it("hydrates and cancels a suspended approval without repository access", async () => {
    const state = new InMemoryAgentStateRepository();
    const backend = new ScriptedBackend([toolTurn()]);
    const write = defineTool({
      name: "write_record",
      description: "Update a record",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      effect: "write",
      authorization: "required",
      handler: async () => ({ modelContent: "updated" }),
    });
    const agent = engine(backend, state, undefined, {
      resolveTools: () => [write],
      authorizeToolCall: () => ({
        decision: "require_user",
        summary: "Approve record update",
        displayContent: { destructive: true },
      }),
    });
    await agent.sessions.create({ principal: PRINCIPAL });
    await collect(
      agent.sessions.runTurn({
        principal: PRINCIPAL,
        sessionId: "session-1",
        input: { text: "Update it", attachments: undefined },
        model: undefined,
      }),
    );

    const inspection = await agent.sessions.inspect({
      principal: PRINCIPAL,
      sessionId: "session-1",
    });
    expect(inspection).toMatchObject({
      summary: { runState: { phase: "suspended" } },
      pendingInteraction: {
        request: {
          summary: "Approve record update",
          displayContent: { destructive: true },
        },
        interactionRevision: "1",
      },
    });
    await expect(
      agent.sessions.cancel({
        principal: PRINCIPAL,
        sessionId: "session-1",
        reason: "approval dismissed",
      }),
    ).resolves.toMatchObject({ status: "cancelled", turnId: "turn-1" });
    const cancelled = await agent.sessions.inspect({
      principal: PRINCIPAL,
      sessionId: "session-1",
    });
    expect(cancelled.summary).toMatchObject({
      runState: { phase: "interrupted", reason: "approval dismissed" },
    });
    expect(cancelled.summary).not.toHaveProperty("pendingInteractionId");
    expect(cancelled).not.toHaveProperty("pendingInteraction");
    await expect(
      state.readInteraction({
        principal: PRINCIPAL,
        sessionId: "session-1",
        interactionId: inspection.pendingInteraction!.request.interactionId,
      }),
    ).resolves.toEqual({ ok: false, reason: "consumed" });
  });

  it("deletes durable control state and process-local transcript together", async () => {
    const state = new InMemoryAgentStateRepository();
    const transcripts = new InMemoryAgentTranscriptStore();
    const agent = engine(
      new ScriptedBackend([finalTurn("private")]),
      state,
      undefined,
      {
        transcriptPolicy: { mode: "ephemeral", store: transcripts },
      },
    );
    const created = await agent.sessions.create({ principal: PRINCIPAL });
    await collect(
      agent.sessions.runTurn({
        principal: PRINCIPAL,
        sessionId: "session-1",
        input: { text: "secret", attachments: undefined },
        model: undefined,
      }),
    );
    const hydrated = await agent.sessions.hydrate({
      principal: PRINCIPAL,
      sessionId: "session-1",
    });
    expect(hydrated.record.messages).not.toHaveLength(0);

    await expect(
      agent.sessions.delete({
        principal: PRINCIPAL,
        sessionId: "session-1",
        expectedRevision: hydrated.summary.revision,
      }),
    ).resolves.toBeUndefined();
    await expect(
      state.readSession({ principal: PRINCIPAL, sessionId: "session-1" }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(
      transcripts.readTranscript({
        principal: PRINCIPAL,
        sessionId: "session-1",
      }),
    ).resolves.toBeUndefined();
    expect(created.revision).toBe("1");
  });

  it("takes over an expired lease and marks a crashed run interrupted", async () => {
    let now = 100;
    const state = new InMemoryAgentStateRepository();
    const leases = new InMemoryAgentTurnLeaseProvider({
      now: () => now,
      createLeaseId: () => `lease-${now}`,
    });
    const crashed = await leases.acquireTurnLease({
      principal: PRINCIPAL,
      sessionId: "session-1",
      turnId: "turn-crashed",
      ownerId: "engine-crashed",
      ttlMs: 50,
    });
    if (!crashed.ok) throw new Error("expected crash lease");
    await state.createSession({
      record: {
        schemaVersion: 1,
        principal: PRINCIPAL,
        sessionId: "session-1",
        createdAt: 100,
        updatedAt: 100,
        messages: [],
        runState: { phase: "idle" },
      },
    });
    await state.saveSession({
      record: {
        schemaVersion: 1,
        principal: PRINCIPAL,
        sessionId: "session-1",
        createdAt: 100,
        updatedAt: 101,
        messages: [],
        lastTurnId: "turn-crashed",
        runState: {
          phase: "running",
          turnId: "turn-crashed",
          startedAt: 101,
        },
      },
      expectedRevision: "1",
      fencingToken: crashed.lease.fencingToken,
    });
    now = 200;
    const recovery = engine(new ScriptedBackend([]), state, leases, {
      ownerId: "engine-recovery",
      now: () => now,
      createTurnId: () => "recovery-turn",
      leaseTtlMs: 50,
      leaseRenewIntervalMs: 25,
    });

    await expect(
      recovery.sessions.recoverInterrupted({
        principal: PRINCIPAL,
        sessionId: "session-1",
        reason: "worker exited",
      }),
    ).resolves.toMatchObject({
      revision: "3",
      fencingToken: "2",
      record: {
        runState: {
          phase: "interrupted",
          turnId: "turn-crashed",
          reason: "worker exited",
        },
      },
    });
  });

  it("keeps identical session IDs isolated by principal", async () => {
    const state = new InMemoryAgentStateRepository();
    const backend = new ScriptedBackend([finalTurn("A"), finalTurn("B")]);
    const agent = engine(backend, state);
    const other: AgentPrincipal = {
      tenantId: "tenant-a",
      subjectId: "subject-b",
    };
    await agent.sessions.create({ principal: PRINCIPAL, sessionId: "shared" });
    await agent.sessions.create({ principal: other, sessionId: "shared" });

    await Promise.all([
      collect(
        agent.sessions.runTurn({
          principal: PRINCIPAL,
          sessionId: "shared",
          input: { text: "A", attachments: undefined },
          model: undefined,
        }),
      ),
      collect(
        agent.sessions.runTurn({
          principal: other,
          sessionId: "shared",
          input: { text: "B", attachments: undefined },
          model: undefined,
        }),
      ),
    ]);

    const [first, second] = await Promise.all([
      state.readSession({ principal: PRINCIPAL, sessionId: "shared" }),
      state.readSession({ principal: other, sessionId: "shared" }),
    ]);
    if (!first.ok || !second.ok) throw new Error("expected both sessions");
    expect(first.record.messages[0]).toMatchObject({ content: "A" });
    expect(first.record.messages).toHaveLength(2);
    expect(second.record.messages[0]).toMatchObject({ content: "B" });
    expect(second.record.messages).toHaveLength(2);
  });
});
