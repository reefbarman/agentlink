import { describe, expect, it, vi } from "vitest";

import { defineTool } from "./hostTools.js";
import type { AgentPrincipal } from "./modelIdentity.js";
import {
  CoreModelBackendRegistry,
  DefaultCoreModelRuntime,
  type CoreModelBackend,
  type CoreModelCapabilities,
  type CoreModelCompleteRequest,
  type CoreModelMessage,
  type CoreModelRequestContext,
  type CoreModelStreamEvent,
  type CoreModelStreamRequest,
} from "./modelRuntime.js";
import { InMemoryAgentStateRepository } from "./sessionRepository.js";
import type {
  AgentModelReference,
  AgentTurnEvent,
  AgentTurnResult,
  PreparedAgentTurnRequest,
} from "./turnContracts.js";
import {
  buildHeadlessTurnSystemPrompt,
  createHeadlessTurnKernel,
  type HeadlessTurnTool,
} from "./turnKernel.js";
import {
  createTurnInteractionTokenService,
  type DurableToolInteractionRecord,
  type DurableToolInteractionRepository,
} from "./turnInteractions.js";

const MODEL: AgentModelReference = {
  providerId: "fake",
  modelId: "fake-model",
};
const CAPS: CoreModelCapabilities = {
  supportsThinking: false,
  supportsCaching: false,
  supportsImages: false,
  supportsToolUse: true,
  contextWindow: 32_768,
  maxOutputTokens: 4_096,
};

interface ScriptedTurn {
  events: CoreModelStreamEvent[];
  providerAttempts?: number;
}

class ScriptedBackend implements CoreModelBackend {
  readonly providerId = MODEL.providerId;
  readonly displayName = "Fake";
  readonly condenseModel = MODEL.modelId;
  readonly requests: Array<{
    request: CoreModelStreamRequest;
    context: CoreModelRequestContext;
  }> = [];

  constructor(private readonly turns: ScriptedTurn[]) {}

  listModels() {
    return [
      {
        id: MODEL.modelId,
        displayName: "Fake model",
        providerId: this.providerId,
        contextWindow: CAPS.contextWindow,
        maxOutputTokens: CAPS.maxOutputTokens,
        authenticated: true,
      },
    ];
  }

  getCapabilities(): CoreModelCapabilities {
    return CAPS;
  }

  async *stream(
    request: CoreModelStreamRequest,
    context: CoreModelRequestContext,
  ): AsyncGenerator<CoreModelStreamEvent> {
    this.requests.push({ request, context });
    const turn = this.turns.shift();
    if (!turn) throw new Error("No scripted model turn remains");
    for (
      let attempt = 0;
      attempt < (turn.providerAttempts ?? 1);
      attempt += 1
    ) {
      request.onProviderRequestAttempt?.({ model: request.model });
    }
    for (const event of turn.events) yield event;
  }

  async complete(
    _request: CoreModelCompleteRequest,
    _context: CoreModelRequestContext,
  ) {
    return { text: "unused" };
  }
}

function createRuntime(backend: ScriptedBackend) {
  const registry = new CoreModelBackendRegistry();
  registry.register(backend);
  return new DefaultCoreModelRuntime(registry, { ownerId: "test-owner" });
}

function prepared(
  principal: AgentPrincipal = { tenantId: "tenant-a", subjectId: "subject-a" },
  overrides: Partial<PreparedAgentTurnRequest> = {},
): PreparedAgentTurnRequest {
  return {
    request: {
      principal,
      sessionId: "session-1",
      input: { text: "Find the answer", attachments: undefined },
      model: undefined,
    },
    turnId: "turn-1",
    history: [{ role: "user", content: "Earlier context" }],
    sessionModel: undefined,
    runtimeDefaultModel: MODEL,
    systemPrompt: "You are a domain assistant.",
    maxOutputTokens: 512,
    reasoningEffort: undefined,
    limits: undefined,
    sessionRevision: "session-revision-1",
    ...overrides,
  };
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

function toolTurn(calls: Array<{ id: string; name: string }>): ScriptedTurn {
  const assistantMessage: CoreModelMessage = {
    role: "assistant",
    content: calls.map((call) => ({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: { query: call.id },
    })),
  };
  return {
    events: [
      {
        type: "content_blocks",
        blocks: [{ type: "text", text: "Checking tools" }],
      },
      ...calls.map(
        (call): CoreModelStreamEvent => ({
          type: "tool_done",
          toolCallId: call.id,
          toolName: call.name,
          input: { query: call.id },
        }),
      ),
      { type: "model_stop", reason: "tool_use", assistantMessage },
      { type: "done" },
    ],
  };
}

function finalTurn(text = "Final answer"): ScriptedTurn {
  return {
    events: [
      { type: "text_delta", text },
      { type: "usage", inputTokens: 10, outputTokens: 3 },
      {
        type: "model_stop",
        reason: "end_turn",
        assistantMessage: {
          role: "assistant",
          content: [{ type: "text", text }],
        },
      },
      { type: "done" },
    ],
  };
}

class InMemoryInteractionRepository implements DurableToolInteractionRepository {
  record: DurableToolInteractionRecord | undefined;
  interactionRevision = "interaction-revision-1";
  sessionRevision = "session-revision-1";
  consumed = false;
  readonly responses = new Set<string>();

  async createInteraction({
    record,
    expectedSessionRevision,
  }: Parameters<DurableToolInteractionRepository["createInteraction"]>[0]) {
    if (this.record)
      return { ok: false as const, reason: "already_exists" as const };
    if (expectedSessionRevision !== this.sessionRevision) {
      return {
        ok: false as const,
        reason: "session_revision_conflict" as const,
        currentSessionRevision: this.sessionRevision,
      };
    }
    this.record = structuredClone(record);
    this.sessionRevision = "session-revision-2";
    return {
      ok: true as const,
      interactionRevision: this.interactionRevision,
      sessionRevision: this.sessionRevision,
    };
  }

  async readInteraction({
    interactionId,
  }: Parameters<DurableToolInteractionRepository["readInteraction"]>[0]) {
    if (!this.record || this.record.interactionId !== interactionId) {
      return { ok: false as const, reason: "not_found" as const };
    }
    if (this.consumed) {
      return { ok: false as const, reason: "consumed" as const };
    }
    return {
      ok: true as const,
      record: structuredClone(this.record),
      interactionRevision: this.interactionRevision,
      sessionRevision: this.sessionRevision,
    };
  }

  async consumeInteraction({
    interactionId,
    expectedInteractionRevision,
    expectedSessionRevision,
    responseId,
  }: Parameters<DurableToolInteractionRepository["consumeInteraction"]>[0]) {
    if (!this.record || this.record.interactionId !== interactionId) {
      return { ok: false as const, reason: "not_found" as const };
    }
    if (this.consumed || this.responses.has(responseId)) {
      return { ok: false as const, reason: "consumed" as const };
    }
    if (expectedInteractionRevision !== this.interactionRevision) {
      return {
        ok: false as const,
        reason: "interaction_revision_conflict" as const,
        currentInteractionRevision: this.interactionRevision,
      };
    }
    if (expectedSessionRevision !== this.sessionRevision) {
      return {
        ok: false as const,
        reason: "session_revision_conflict" as const,
        currentSessionRevision: this.sessionRevision,
      };
    }
    this.consumed = true;
    this.responses.add(responseId);
    this.sessionRevision = "session-revision-3";
    return { ok: true as const, sessionRevision: this.sessionRevision };
  }
}

function tool(
  name: string,
  execute: HeadlessTurnTool["execute"],
  parallelSafe = false,
): HeadlessTurnTool {
  return {
    definition: {
      name,
      description: `${name} description`,
      input_schema: { type: "object" },
    },
    parallelSafe,
    displayInput: (input) => ({ query: input.query }),
    execute,
  };
}

describe("headless E4 turn kernel", () => {
  it("suspends a required authorization durably and resumes an allowed call exactly once", async () => {
    const backend = new ScriptedBackend([
      toolTurn([{ id: "call-write", name: "update_record" }]),
      finalTurn("Updated"),
    ]);
    const repository = new InMemoryInteractionRepository();
    const tokens = createTurnInteractionTokenService({
      secret: "s".repeat(32),
      now: () => 100,
      createResponseId: () => "response-1",
    });
    const handler = vi.fn(async () => ({
      modelContent: "private update result",
      displayContent: { updated: true },
    }));
    const authorizeToolCall = vi.fn(async () => ({
      decision: "require_user" as const,
      summary: "Approve updating this record?",
      displayContent: { risk: "write" },
    }));
    const kernel = createHeadlessTurnKernel({
      models: createRuntime(backend),
      resolveTools: async () => [
        defineTool({
          name: "update_record",
          description: "Update a tenant record",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
          effect: "write",
          authorization: "required",
          displayInput: (input) => ({ query: input.query }),
          handler,
        }),
      ],
      authorizeToolCall,
      interactions: repository,
      interactionTokens: tokens,
      createInteractionId: () => "interaction-1",
      now: () => 100,
    });

    const suspendedRun = await collect(kernel.runTurn(prepared()));

    expect(suspendedRun.result).toMatchObject({
      status: "suspended",
      sessionRevision: "session-revision-2",
      interaction: {
        interactionId: "interaction-1",
        kind: "tool_authorization",
        summary: "Approve updating this record?",
        toolCallId: "call-write",
        toolName: "update_record",
        effect: "write",
        displayInput: { query: "call-write" },
        displayContent: { risk: "write" },
      },
      execution: { modelCalls: 1, toolCalls: 1 },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(repository.record?.continuation.iterationMessages).toContainEqual(
      expect.objectContaining({ role: "assistant" }),
    );
    expect(repository.record?.continuation.pendingToolCalls).toEqual([
      {
        id: "call-write",
        name: "update_record",
        input: { query: "call-write" },
      },
    ]);
    expect(suspendedRun.events.map((event) => event.type)).toContain(
      "interaction.required",
    );

    const token = await kernel.issueInteractionResponseToken({
      interactionId: "interaction-1",
      interactionRevision: "interaction-revision-1",
      principal: { tenantId: "tenant-a", subjectId: "subject-a" },
      sessionId: "session-1",
      turnId: "turn-1",
      expectedSessionRevision: "session-revision-2",
      decision: "allow",
    });
    const resumedRun = await collect(
      kernel.resumeInteraction({
        interactionId: "interaction-1",
        interactionRevision: "interaction-revision-1",
        principal: { tenantId: "tenant-a", subjectId: "subject-a" },
        sessionId: "session-1",
        turnId: "turn-1",
        expectedSessionRevision: "session-revision-2",
        decision: "allow",
        responseToken: token,
      }),
    );

    expect(resumedRun.result).toMatchObject({
      status: "completed",
      text: "Updated",
      sessionRevision: "session-revision-3",
      execution: { modelCalls: 2, toolCalls: 1 },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(authorizeToolCall).toHaveBeenCalledTimes(1);
    expect(resumedRun.events[0]).toMatchObject({
      type: "interaction.resumed",
      sequence: expect.any(Number),
      interactionId: "interaction-1",
      decision: "allow",
    });
    expect(backend.requests[1]?.request.messages).toContainEqual({
      role: "user",
      content: [
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "call-write",
          content: "private update result",
        }),
      ],
    });

    const duplicateRun = kernel.resumeInteraction({
      interactionId: "interaction-1",
      interactionRevision: "interaction-revision-1",
      principal: { tenantId: "tenant-a", subjectId: "subject-a" },
      sessionId: "session-1",
      turnId: "turn-1",
      expectedSessionRevision: "session-revision-2",
      decision: "allow",
      responseToken: token,
    });
    await expect(duplicateRun.next()).rejects.toMatchObject({
      code: "interaction_consumed",
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("resumes a denied authorization as a bounded model-visible error", async () => {
    const backend = new ScriptedBackend([
      toolTurn([{ id: "call-write", name: "update_record" }]),
      finalTurn("Not updated"),
    ]);
    const repository = new InMemoryInteractionRepository();
    const tokens = createTurnInteractionTokenService({
      secret: "s".repeat(32),
      now: () => 100,
      createResponseId: () => "response-deny",
    });
    const handler = vi.fn(async () => ({ modelContent: "unexpected" }));
    const kernel = createHeadlessTurnKernel({
      models: createRuntime(backend),
      resolveTools: async () => [
        defineTool({
          name: "update_record",
          description: "Update a tenant record",
          inputSchema: { type: "object" },
          effect: "write",
          authorization: "required",
          handler,
        }),
      ],
      authorizeToolCall: async () => ({
        decision: "require_user",
        summary: "Approve update?",
      }),
      interactions: repository,
      interactionTokens: tokens,
      createInteractionId: () => "interaction-deny",
      now: () => 100,
    });
    await collect(kernel.runTurn(prepared()));
    const token = await kernel.issueInteractionResponseToken({
      interactionId: "interaction-deny",
      interactionRevision: "interaction-revision-1",
      principal: { tenantId: "tenant-a", subjectId: "subject-a" },
      sessionId: "session-1",
      turnId: "turn-1",
      expectedSessionRevision: "session-revision-2",
      decision: "deny",
    });

    const { events, result } = await collect(
      kernel.resumeInteraction({
        interactionId: "interaction-deny",
        interactionRevision: "interaction-revision-1",
        principal: { tenantId: "tenant-a", subjectId: "subject-a" },
        sessionId: "session-1",
        turnId: "turn-1",
        expectedSessionRevision: "session-revision-2",
        decision: "deny",
        responseToken: token,
      }),
    );

    expect(result).toMatchObject({ status: "completed", text: "Not updated" });
    expect(handler).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.failed",
        toolCallId: "call-write",
        error: expect.objectContaining({ code: "tool_authorization_denied" }),
      }),
    );
    expect(backend.requests[1]?.request.messages).toContainEqual({
      role: "user",
      content: [
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "call-write",
          is_error: true,
          content: expect.stringContaining("authorization was denied"),
        }),
      ],
    });
  });

  it("rejects cross-principal and stale interaction resumes before consumption", async () => {
    const backend = new ScriptedBackend([
      toolTurn([{ id: "call-write", name: "update_record" }]),
    ]);
    const repository = new InMemoryInteractionRepository();
    const tokens = createTurnInteractionTokenService({
      secret: "s".repeat(32),
      now: () => 100,
      createResponseId: () => "response-1",
    });
    const kernel = createHeadlessTurnKernel({
      models: createRuntime(backend),
      resolveTools: async () => [
        defineTool({
          name: "update_record",
          description: "Update a tenant record",
          inputSchema: { type: "object" },
          effect: "write",
          authorization: "required",
          handler: async () => ({ modelContent: "unexpected" }),
        }),
      ],
      authorizeToolCall: async () => ({
        decision: "require_user",
        summary: "Approve update?",
      }),
      interactions: repository,
      interactionTokens: tokens,
      createInteractionId: () => "interaction-1",
      now: () => 100,
    });
    await collect(kernel.runTurn(prepared()));
    await expect(
      kernel.issueInteractionResponseToken({
        interactionId: "interaction-1",
        interactionRevision: "interaction-revision-1",
        principal: { tenantId: "tenant-a", subjectId: "subject-b" },
        sessionId: "session-1",
        turnId: "turn-1",
        expectedSessionRevision: "session-revision-2",
        decision: "allow",
      }),
    ).rejects.toMatchObject({ code: "interaction_scope_mismatch" });
    const token = await kernel.issueInteractionResponseToken({
      interactionId: "interaction-1",
      interactionRevision: "interaction-revision-1",
      principal: { tenantId: "tenant-a", subjectId: "subject-a" },
      sessionId: "session-1",
      turnId: "turn-1",
      expectedSessionRevision: "session-revision-2",
      decision: "allow",
    });

    const crossPrincipal = kernel.resumeInteraction({
      interactionId: "interaction-1",
      interactionRevision: "interaction-revision-1",
      principal: { tenantId: "tenant-a", subjectId: "subject-b" },
      sessionId: "session-1",
      turnId: "turn-1",
      expectedSessionRevision: "session-revision-2",
      decision: "allow",
      responseToken: token,
    });
    await expect(crossPrincipal.next()).rejects.toMatchObject({
      code: "interaction_scope_mismatch",
    });

    const stale = kernel.resumeInteraction({
      interactionId: "interaction-1",
      interactionRevision: "interaction-revision-stale",
      principal: { tenantId: "tenant-a", subjectId: "subject-a" },
      sessionId: "session-1",
      turnId: "turn-1",
      expectedSessionRevision: "session-revision-2",
      decision: "allow",
      responseToken: token,
    });
    await expect(stale.next()).rejects.toMatchObject({
      code: "interaction_revision_conflict",
    });
    expect(repository.consumed).toBe(false);
  });

  it("rejects stale fencing tokens before durable suspension", async () => {
    const backend = new ScriptedBackend([
      toolTurn([{ id: "call-write", name: "update_record" }]),
    ]);
    const repository = new InMemoryAgentStateRepository();
    await repository.createSession({
      record: {
        schemaVersion: 1,
        principal: { tenantId: "tenant-a", subjectId: "subject-a" },
        sessionId: "session-1",
        createdAt: 100,
        updatedAt: 100,
        messages: [],
        runState: { phase: "idle" },
      },
    });
    await repository.saveSession({
      record: {
        schemaVersion: 1,
        principal: { tenantId: "tenant-a", subjectId: "subject-a" },
        sessionId: "session-1",
        createdAt: 100,
        updatedAt: 200,
        messages: [],
        runState: { phase: "running", turnId: "turn-1", startedAt: 200 },
      },
      expectedRevision: "1",
      fencingToken: "2",
    });
    const tokens = createTurnInteractionTokenService({
      secret: "s".repeat(32),
      now: () => 100,
    });
    const kernel = createHeadlessTurnKernel({
      models: createRuntime(backend),
      resolveTools: async () => [
        defineTool({
          name: "update_record",
          description: "Update a record",
          inputSchema: { type: "object" },
          effect: "write",
          authorization: "required",
          handler: async () => ({ modelContent: "unexpected" }),
        }),
      ],
      authorizeToolCall: async () => ({
        decision: "require_user",
        summary: "Approve update?",
      }),
      interactions: repository,
      interactionTokens: tokens,
      createInteractionId: () => "interaction-stale-fence",
      now: () => 100,
    });

    const result = await collect(
      kernel.runTurn(
        prepared(undefined, {
          sessionRevision: "2",
          turnFencingToken: "1",
        }),
      ),
    );

    expect(result.result).toMatchObject({
      status: "failed",
      error: { code: "turn_lease_lost" },
    });
    await expect(
      repository.readInteraction({
        principal: { tenantId: "tenant-a", subjectId: "subject-a" },
        sessionId: "session-1",
        interactionId: "interaction-stale-fence",
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("resolves and validates principal-scoped tools once per turn", async () => {
    const backend = new ScriptedBackend([
      toolTurn([{ id: "call-dynamic", name: "tenant_lookup" }]),
      finalTurn(),
    ]);
    const handler = vi.fn(async (_input, context) => ({
      modelContent: `tenant:${context.principal.tenantId}`,
    }));
    const toolA = defineTool({
      name: "tenant_lookup",
      description: "Lookup tenant data",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      effect: "read",
      handler,
    });
    const resolveTools = vi.fn(async (request) => {
      expect(request).toEqual({
        principal: { tenantId: "tenant-a", subjectId: "subject-a" },
        sessionId: "session-1",
        turnId: "turn-1",
      });
      return [toolA];
    });
    const kernel = createHeadlessTurnKernel({
      models: createRuntime(backend),
      resolveTools,
    });

    const { result } = await collect(kernel.runTurn(prepared()));

    expect(result).toMatchObject({ status: "completed", text: "Final answer" });
    expect(resolveTools).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      { query: "call-dynamic" },
      expect.objectContaining({
        principal: { tenantId: "tenant-a", subjectId: "subject-a" },
        sessionId: "session-1",
        turnId: "turn-1",
      }),
    );
    expect(backend.requests[0]?.request.tools).toEqual([toolA.definition]);
  });

  it("merges static compatibility tools with dynamically resolved tools", async () => {
    const backend = new ScriptedBackend([finalTurn()]);
    const staticTool = tool("static_lookup", async () => ({
      modelContent: "static",
    }));
    const dynamicTool = defineTool({
      name: "dynamic_lookup",
      description: "Dynamic lookup",
      inputSchema: { type: "object" },
      effect: "read",
      handler: async () => ({ modelContent: "dynamic" }),
    });
    const kernel = createHeadlessTurnKernel({
      models: createRuntime(backend),
      tools: [staticTool],
      resolveTools: async () => [dynamicTool],
    });

    const { result } = await collect(kernel.runTurn(prepared()));

    expect(result.status).toBe("completed");
    expect(backend.requests[0]?.request.tools).toEqual([
      staticTool.definition,
      dynamicTool.definition,
    ]);
  });

  it("reports duplicate static and dynamic tool names as invalid resolution", async () => {
    const backend = new ScriptedBackend([finalTurn()]);
    const kernel = createHeadlessTurnKernel({
      models: createRuntime(backend),
      tools: [tool("duplicate", async () => ({ modelContent: "static" }))],
      resolveTools: async () => [
        defineTool({
          name: "duplicate",
          description: "Duplicate dynamic tool",
          inputSchema: { type: "object" },
          effect: "read",
          handler: async () => ({ modelContent: "dynamic" }),
        }),
      ],
    });

    const { result } = await collect(kernel.runTurn(prepared()));

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "invalid_tool_resolution",
        message: 'Duplicate resolved host tool "duplicate"',
        retryable: false,
      },
    });
    expect(backend.requests).toHaveLength(0);
  });

  it("rejects non-normalized static tool names", () => {
    const backend = new ScriptedBackend([finalTurn()]);

    expect(() =>
      createHeadlessTurnKernel({
        models: createRuntime(backend),
        tools: [tool(" padded", async () => ({ modelContent: "unexpected" }))],
      }),
    ).toThrow("Headless turn tool names must start with a letter");
  });

  it("keeps dynamic tools isolated between concurrent principals", async () => {
    const backend = new ScriptedBackend([finalTurn("A"), finalTurn("B")]);
    const resolvedSubjects: string[] = [];
    const resolveTools = vi.fn(async ({ principal }) => {
      resolvedSubjects.push(principal.subjectId);
      return [
        defineTool({
          name: `lookup_${principal.subjectId}`,
          description: "Principal-specific tool",
          inputSchema: { type: "object" },
          effect: "read",
          handler: async () => ({ modelContent: principal.subjectId }),
        }),
      ];
    });
    const kernel = createHeadlessTurnKernel({
      models: createRuntime(backend),
      resolveTools,
    });
    const principalA = { tenantId: "tenant", subjectId: "a" };
    const principalB = { tenantId: "tenant", subjectId: "b" };

    await Promise.all([
      collect(
        kernel.runTurn(
          prepared(principalA, {
            turnId: "turn-a",
            request: {
              ...prepared(principalA).request,
              sessionId: "session-a",
            },
          }),
        ),
      ),
      collect(
        kernel.runTurn(
          prepared(principalB, {
            turnId: "turn-b",
            request: {
              ...prepared(principalB).request,
              sessionId: "session-b",
            },
          }),
        ),
      ),
    ]);

    expect(resolvedSubjects.sort()).toEqual(["a", "b"]);
    expect(
      backend.requests.map(({ request }) => request.tools?.[0]?.name),
    ).toEqual(expect.arrayContaining(["lookup_a", "lookup_b"]));
  });

  it("turns invalid dynamic tool input into a bounded model-visible error", async () => {
    const invalidToolTurn = toolTurn([
      { id: "call-invalid", name: "tenant_lookup" },
    ]);
    const invalidCall = invalidToolTurn.events.find(
      (event) => event.type === "tool_done",
    );
    if (invalidCall?.type === "tool_done") invalidCall.input = { extra: true };
    const invalidStop = invalidToolTurn.events.find(
      (event) => event.type === "model_stop",
    );
    if (
      invalidStop?.type === "model_stop" &&
      Array.isArray(invalidStop.assistantMessage.content)
    ) {
      const use = invalidStop.assistantMessage.content.find(
        (block) => block.type === "tool_use",
      );
      if (use?.type === "tool_use") use.input = { extra: true };
    }
    const backend = new ScriptedBackend([invalidToolTurn, finalTurn()]);
    const handler = vi.fn(async () => ({ modelContent: "unexpected" }));
    const displayInput = vi.fn(() => {
      throw new Error("projector must not run for invalid input");
    });
    const kernel = createHeadlessTurnKernel({
      models: createRuntime(backend),
      resolveTools: async () => [
        defineTool({
          name: "tenant_lookup",
          description: "Lookup tenant data",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
          effect: "read",
          displayInput,
          handler,
        }),
      ],
    });

    const { events, result } = await collect(kernel.runTurn(prepared()));

    expect(result).toMatchObject({ status: "completed" });
    expect(handler).not.toHaveBeenCalled();
    expect(displayInput).not.toHaveBeenCalled();
    const requested = events.find(
      (event) =>
        event.type === "tool.requested" && event.toolCallId === "call-invalid",
    );
    expect(requested).toBeDefined();
    expect(requested).not.toHaveProperty("displayInput");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.failed",
        toolCallId: "call-invalid",
        error: {
          code: "tool_input_invalid",
          retryable: false,
          message: expect.stringContaining("input is invalid"),
        },
      }),
    );
    expect(backend.requests[1]?.request.messages).toContainEqual({
      role: "user",
      content: [
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "call-invalid",
          is_error: true,
          content: expect.stringContaining("input is invalid"),
        }),
      ],
    });
  });

  it("fails closed when a dynamic tool requires authorization", async () => {
    const backend = new ScriptedBackend([
      toolTurn([{ id: "call-authorized", name: "protected_lookup" }]),
      finalTurn(),
    ]);
    const handler = vi.fn(async () => ({ modelContent: "unexpected" }));
    const kernel = createHeadlessTurnKernel({
      models: createRuntime(backend),
      resolveTools: async () => [
        defineTool({
          name: "protected_lookup",
          description: "Lookup protected tenant data",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
          effect: "read",
          authorization: "required",
          handler,
        }),
      ],
    });

    const { events, result } = await collect(kernel.runTurn(prepared()));

    expect(result).toMatchObject({ status: "completed" });
    expect(handler).not.toHaveBeenCalled();
    expect(backend.requests[0]?.request.tools).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.failed",
        toolCallId: "call-authorized",
        error: {
          code: "tool_authorization_required",
          retryable: false,
          message: expect.stringContaining("requires authorization"),
        },
      }),
    );
    expect(backend.requests[1]?.request.messages).toContainEqual({
      role: "user",
      content: [
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "call-authorized",
          is_error: true,
          content: expect.stringContaining("requires authorization"),
        }),
      ],
    });
  });

  it("fails closed for unknown static authorization metadata", async () => {
    const backend = new ScriptedBackend([
      toolTurn([{ id: "call-unknown-auth", name: "legacy_lookup" }]),
      finalTurn(),
    ]);
    const execute = vi.fn(async () => ({ modelContent: "unexpected" }));
    const legacyTool: HeadlessTurnTool = {
      ...tool("legacy_lookup", execute),
      authorization: "unknown" as "none",
    };
    const kernel = createHeadlessTurnKernel({
      models: createRuntime(backend),
      tools: [legacyTool],
    });

    const { events, result } = await collect(kernel.runTurn(prepared()));

    expect(result.status).toBe("completed");
    expect(execute).not.toHaveBeenCalled();
    expect(backend.requests[0]?.request.tools).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.failed",
        toolCallId: "call-unknown-auth",
        error: expect.objectContaining({
          code: "tool_authorization_required",
        }),
      }),
    );
  });

  it("omits display input when a projector throws", async () => {
    const backend = new ScriptedBackend([
      toolTurn([{ id: "call-projector", name: "lookup" }]),
      finalTurn(),
    ]);
    const baseTool = tool("lookup", async () => ({ modelContent: "ok" }));
    const staticTool: HeadlessTurnTool = {
      ...baseTool,
      displayInput: () => {
        throw new Error("unsafe projector failure");
      },
    };
    const kernel = createHeadlessTurnKernel({
      models: createRuntime(backend),
      tools: [staticTool],
    });

    const { events, result } = await collect(kernel.runTurn(prepared()));

    expect(result.status).toBe("completed");
    const requested = events.find(
      (event) =>
        event.type === "tool.requested" &&
        event.toolCallId === "call-projector",
    );
    expect(requested).toBeDefined();
    expect(requested).not.toHaveProperty("displayInput");
  });

  it("streams a bounded multi-tool conversation with exact replay and safe events", async () => {
    const backend = new ScriptedBackend([
      toolTurn([
        { id: "call-a", name: "lookup" },
        { id: "call-b", name: "lookup" },
      ]),
      finalTurn(),
    ]);
    let active = 0;
    let maxActive = 0;
    const execute = vi.fn(async (input: Record<string, unknown>) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return {
        modelContent: `private:${String(input.query)}`,
        displayContent: { found: true },
      };
    });
    const resolveAuthContext = vi.fn(() => undefined);
    const kernel = createHeadlessTurnKernel({
      models: createRuntime(backend),
      tools: [tool("lookup", execute, true)],
      resolveAuthContext,
      now: () => 100,
    });

    const { events, result } = await collect(kernel.runTurn(prepared()));

    expect(result).toMatchObject({
      status: "completed",
      text: "Final answer",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 3 },
      execution: { modelCalls: 2, toolCalls: 2 },
      provenance: {
        requestedModel: undefined,
        resolvedModel: { model: MODEL, source: "runtime" },
      },
    });
    expect(maxActive).toBe(2);
    expect(resolveAuthContext).toHaveBeenCalledWith({
      principal: { tenantId: "tenant-a", subjectId: "subject-a" },
      sessionId: "session-1",
      turnId: "turn-1",
    });
    expect(backend.requests[0]?.request.systemPrompt).toBe(
      buildHeadlessTurnSystemPrompt("You are a domain assistant."),
    );
    expect(backend.requests[1]?.request.messages).toEqual([
      { role: "user", content: "Earlier context" },
      { role: "user", content: "Find the answer" },
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([
          expect.objectContaining({ type: "tool_use", id: "call-a" }),
          expect.objectContaining({ type: "tool_use", id: "call-b" }),
        ]),
      }),
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-a",
            content: "private:call-a",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-b",
            content: "private:call-b",
          },
        ],
      },
    ]);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "turn.started",
        "model.resolved",
        "tool.requested",
        "tool.started",
        "tool.completed",
        "text.delta",
        "usage.updated",
        "turn.completed",
      ]),
    );
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_event, index) => index),
    );
    expect(JSON.stringify(events)).not.toContain("private:call-a");
    expect(
      events.find((event) => event.type === "tool.completed"),
    ).toMatchObject({ displayContent: { found: true } });
  });

  it("refreshes request-scoped auth context before every model call", async () => {
    const backend = new ScriptedBackend([
      toolTurn([{ id: "call-auth", name: "lookup" }]),
      finalTurn(),
    ]);
    let authRevision = 0;
    const resolveAuthContext = vi.fn(() => ({
      credentialResolver: {
        resolveCredential: vi.fn(async () => null),
        revision: ++authRevision,
      } as never,
    }));
    const kernel = createHeadlessTurnKernel({
      models: createRuntime(backend),
      tools: [tool("lookup", async () => ({ modelContent: "ok" }))],
      resolveAuthContext,
    });

    await collect(kernel.runTurn(prepared()));

    expect(resolveAuthContext).toHaveBeenCalledTimes(3);
    expect(backend.requests[0]?.context.authContext).not.toBe(
      backend.requests[1]?.context.authContext,
    );
  });

  it("continues a provider pause without exposing a terminal result early", async () => {
    const backend = new ScriptedBackend([
      {
        events: [
          {
            type: "model_stop",
            reason: "pause_turn",
            assistantMessage: { role: "assistant", content: [] },
          },
          { type: "done" },
        ],
      },
      finalTurn("After pause"),
    ]);
    const kernel = createHeadlessTurnKernel({ models: createRuntime(backend) });

    const { events, result } = await collect(kernel.runTurn(prepared()));

    expect(result).toMatchObject({
      status: "completed",
      text: "After pause",
      execution: { modelCalls: 2 },
    });
    expect(
      events.filter((event) => event.type.startsWith("turn.")),
    ).toMatchObject([{ type: "turn.started" }, { type: "turn.completed" }]);
  });

  it("fails after preserving an oversized completed tool result", async () => {
    const backend = new ScriptedBackend([
      toolTurn([{ id: "call-large", name: "lookup" }]),
    ]);
    const execute = vi.fn(async () => ({ modelContent: "oversized" }));
    const kernel = createHeadlessTurnKernel({
      models: createRuntime(backend),
      tools: [tool("lookup", execute)],
    });

    const { events, result } = await collect(
      kernel.runTurn(
        prepared(undefined, { limits: { maxToolResultBytes: 1 } }),
      ),
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "turn_execution_limit_reached" },
      execution: { toolCalls: 1 },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.completed",
        toolCallId: "call-large",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "execution.updated",
        event: expect.objectContaining({
          type: "limit_reached",
          limit: "maxToolResultBytes",
        }),
      }),
    );
  });

  it("still bounds logical calls when a backend ignores the physical-attempt hook", async () => {
    class HookIgnoringBackend extends ScriptedBackend {
      override async *stream(
        request: CoreModelStreamRequest,
        context: CoreModelRequestContext,
      ): AsyncGenerator<CoreModelStreamEvent> {
        this.requests.push({ request, context });
        if (this.requests.length === 1) {
          yield* toolTurn([{ id: "call-hook", name: "lookup" }]).events;
        } else {
          yield* finalTurn().events;
        }
      }
    }
    const backend = new HookIgnoringBackend([]);
    const kernel = createHeadlessTurnKernel({
      models: createRuntime(backend),
      tools: [tool("lookup", async () => ({ modelContent: "ok" }))],
    });

    const { result } = await collect(
      kernel.runTurn(prepared(undefined, { limits: { maxModelCalls: 1 } })),
    );

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "turn_execution_limit_reached" },
      execution: { modelCalls: 1 },
    });
    expect(backend.requests).toHaveLength(1);
  });

  it("fails deterministically when physical provider attempts exceed the model budget", async () => {
    const backend = new ScriptedBackend([
      { ...finalTurn(), providerAttempts: 2 },
    ]);
    const kernel = createHeadlessTurnKernel({ models: createRuntime(backend) });

    const { events, result } = await collect(
      kernel.runTurn(prepared(undefined, { limits: { maxModelCalls: 1 } })),
    );

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "turn_execution_limit_reached",
        retryable: false,
      },
      execution: { modelCalls: 1 },
    });
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", result });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "execution.updated",
        event: expect.objectContaining({
          type: "limit_reached",
          limit: "maxModelCalls",
        }),
      }),
    );
  });

  it("aborts in-flight work when the event consumer closes the stream", async () => {
    let observedSignal: AbortSignal | undefined;
    let signalAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      signalAborted = resolve;
    });
    class BlockingBackend extends ScriptedBackend {
      // oxlint-disable-next-line require-yield
      override async *stream(
        request: CoreModelStreamRequest,
        context: CoreModelRequestContext,
      ): AsyncGenerator<CoreModelStreamEvent> {
        this.requests.push({ request, context });
        observedSignal = request.signal;
        await new Promise<void>((resolve) =>
          request.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        signalAborted();
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
    }
    const backend = new BlockingBackend([]);
    const kernel = createHeadlessTurnKernel({ models: createRuntime(backend) });
    const stream = kernel.runTurn(prepared());

    await stream.next();
    while (!observedSignal) await Promise.resolve();
    await stream.return(undefined as never);
    await aborted;

    expect(observedSignal?.aborted).toBe(true);
  });

  it("does not start work until the returned stream is consumed", async () => {
    const backend = new ScriptedBackend([finalTurn()]);
    const kernel = createHeadlessTurnKernel({ models: createRuntime(backend) });

    const stream = kernel.runTurn(prepared());
    await Promise.resolve();

    expect(backend.requests).toHaveLength(0);
    await collect(stream);
    expect(backend.requests).toHaveLength(1);
  });

  it("returns cancellation without calling the model when already aborted", async () => {
    const backend = new ScriptedBackend([finalTurn()]);
    const controller = new AbortController();
    controller.abort("client disconnected");
    const kernel = createHeadlessTurnKernel({ models: createRuntime(backend) });

    const { events, result } = await collect(
      kernel.runTurn(prepared(), { signal: controller.signal }),
    );

    expect(result).toMatchObject({
      status: "cancelled",
      reason: "client disconnected",
      execution: { modelCalls: 0, toolCalls: 0 },
    });
    expect(backend.requests).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "turn.cancelled", result });
  });

  it("keeps principal and turn model selection isolated across concurrent turns", async () => {
    const backend = new ScriptedBackend([finalTurn("A"), finalTurn("B")]);
    const runtime = createRuntime(backend);
    const kernel = createHeadlessTurnKernel({ models: runtime });
    const principalA = { tenantId: "tenant", subjectId: "a" };
    const principalB = { tenantId: "tenant", subjectId: "b" };

    const [turnA, turnB] = await Promise.all([
      collect(
        kernel.runTurn(
          prepared(principalA, {
            turnId: "turn-a",
            request: {
              ...prepared(principalA).request,
              sessionId: "session-a",
              model: MODEL,
            },
          }),
        ),
      ),
      collect(
        kernel.runTurn(
          prepared(principalB, {
            turnId: "turn-b",
            request: {
              ...prepared(principalB).request,
              sessionId: "session-b",
              model: MODEL,
            },
          }),
        ),
      ),
    ]);

    expect(turnA.result).toMatchObject({
      status: "completed",
      turnId: "turn-a",
      provenance: { resolvedModel: { source: "turn" } },
    });
    expect(turnB.result).toMatchObject({
      status: "completed",
      turnId: "turn-b",
      provenance: { resolvedModel: { source: "turn" } },
    });
    expect(backend.requests.map(({ context }) => context.principal)).toEqual(
      expect.arrayContaining([principalA, principalB]),
    );
  });

  it("redacts unclassified provider errors from public results", async () => {
    class FailingBackend extends ScriptedBackend {
      // oxlint-disable-next-line require-yield
      override async *stream(): AsyncGenerator<CoreModelStreamEvent> {
        throw new Error("secret=https://private.example/token");
      }
    }
    const kernel = createHeadlessTurnKernel({
      models: createRuntime(new FailingBackend([])),
    });

    const { events, result } = await collect(kernel.runTurn(prepared()));

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "turn_execution_failed",
        message: "Turn execution failed",
      },
    });
    expect(JSON.stringify({ events, result })).not.toContain("private.example");
  });

  it("rejects unsupported model capabilities before provider dispatch", async () => {
    class NoToolBackend extends ScriptedBackend {
      override getCapabilities(): CoreModelCapabilities {
        return { ...CAPS, supportsToolUse: false };
      }
    }
    const backend = new NoToolBackend([finalTurn()]);
    const kernel = createHeadlessTurnKernel({
      models: createRuntime(backend),
      tools: [tool("lookup", async () => ({ modelContent: "unused" }))],
    });

    const { result } = await collect(kernel.runTurn(prepared()));

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "model_capability_unsupported" },
      execution: { modelCalls: 0 },
    });
    expect(backend.requests).toHaveLength(0);
  });
});
