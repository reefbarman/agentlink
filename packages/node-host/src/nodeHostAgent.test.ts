import {
  CoreModelBackendRegistry,
  DefaultCoreModelRuntime,
  InMemoryAgentStateRepository,
  InMemoryAgentTranscriptStore,
  InMemoryAgentTurnLeaseProvider,
  defineTool,
  type CoreModelBackend,
  type CoreModelCapabilities,
  type CoreModelCompleteRequest,
  type CoreModelCompleteResult,
  type CoreModelRequestContext,
  type CoreModelStreamEvent,
  type CoreModelStreamRequest,
  type AgentTurnResult,
} from "@agentlink/core";
import { describe, expect, it, vi } from "vitest";

import { createNodeHostAgent, createNodeHostTools } from "./nodeHostAgent.js";

const principal = { tenantId: "tenant-a", subjectId: "subject-a" };
const model = { providerId: "fixture", modelId: "fixture-model" };
const capabilities: CoreModelCapabilities = {
  supportsThinking: false,
  supportsCaching: false,
  supportsImages: false,
  supportsToolUse: true,
  contextWindow: 8_192,
  maxOutputTokens: 1_024,
};

class FixtureBackend implements CoreModelBackend {
  readonly providerId = model.providerId;
  readonly displayName = "Fixture";
  readonly condenseModel = model.modelId;
  readonly requests: CoreModelStreamRequest[] = [];

  listModels() {
    return [
      {
        id: model.modelId,
        displayName: "Fixture model",
        providerId: this.providerId,
        providerDisplayName: this.displayName,
        supportsToolUse: true,
        supportsImages: false,
        contextWindow: capabilities.contextWindow,
        maxOutputTokens: capabilities.maxOutputTokens,
        authenticated: true,
      },
    ];
  }

  getCapabilities(): CoreModelCapabilities {
    return capabilities;
  }

  async *stream(
    request: CoreModelStreamRequest,
    _context: CoreModelRequestContext,
  ): AsyncGenerator<CoreModelStreamEvent> {
    this.requests.push(request);
    const hasToolResult = request.messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === "tool_result"),
    );
    if (hasToolResult) {
      yield { type: "text_delta", text: "host evidence received" };
      yield {
        type: "model_stop",
        reason: "end_turn",
        assistantMessage: {
          role: "assistant",
          content: [{ type: "text", text: "host evidence received" }],
        },
      };
      yield { type: "done" };
      return;
    }
    yield {
      type: "tool_done",
      toolCallId: "host-tool-call",
      toolName: "host_evidence",
      input: { requestId: "distinctive-request" },
    };
    yield {
      type: "model_stop",
      reason: "tool_use",
      assistantMessage: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "host-tool-call",
            name: "host_evidence",
            input: { requestId: "distinctive-request" },
          },
        ],
      },
    };
    yield { type: "done" };
  }

  async complete(
    _request: CoreModelCompleteRequest,
    _context: CoreModelRequestContext,
  ): Promise<CoreModelCompleteResult> {
    return { text: "fixture completion" };
  }
}

function createModels(
  backend = new FixtureBackend(),
  modelCapabilities: CoreModelCapabilities = capabilities,
) {
  const registry = new CoreModelBackendRegistry();
  registry.register({
    ...backend,
    getCapabilities: () => modelCapabilities,
    listModels: () =>
      backend.listModels().map((entry) => ({
        ...entry,
        reasoningEfforts: modelCapabilities.reasoningEfforts,
        defaultReasoningEffort: modelCapabilities.defaultReasoningEffort,
      })),
    stream: backend.stream.bind(backend),
    complete: backend.complete.bind(backend),
  });
  return {
    backend,
    runtime: new DefaultCoreModelRuntime(registry, {
      ownerId: "node-host-test",
    }),
  };
}

async function collect<T>(stream: AsyncGenerator<T, AgentTurnResult>) {
  const events: T[] = [];
  for (;;) {
    const next = await stream.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

describe("node host composition", () => {
  it("runs an explicitly host-provided tool through the core event stream", async () => {
    const handler = vi.fn(async (_input, context) => ({
      modelContent: JSON.stringify({
        evidence: "distinctive-host-evidence",
        subjectId: context.principal.subjectId,
      }),
      displayContent: { status: "host evidence loaded" },
    }));
    const { runtime } = createModels();
    const agent = createNodeHostAgent({
      ownerId: "node-host-test",
      models: runtime,
      persistence: {
        sessions: new InMemoryAgentStateRepository<typeof principal>(),
        turnLeases: new InMemoryAgentTurnLeaseProvider<typeof principal>(),
      },
      instructions: () => "Use host tools only.",
      defaultModel: model,
      maxOutputTokens: 512,
      tools: {
        tools: [
          defineTool({
            name: "host_evidence",
            description: "Load explicitly host-provided evidence.",
            inputSchema: {
              type: "object",
              properties: { requestId: { type: "string" } },
              required: ["requestId"],
              additionalProperties: false,
            },
            effect: "read",
            displayInput: (input) => input,
            handler,
          }),
        ],
      },
    });

    await agent.sessions.create({ principal, sessionId: "session-a" });
    const { events, result } = await collect(
      agent.sessions.runTurn({
        principal,
        sessionId: "session-a",
        input: { text: "load evidence", attachments: undefined },
        model: undefined,
      }),
    );

    if (result.status === "failed") throw new Error(result.error.message);
    expect(result).toMatchObject({
      status: "completed",
      text: "host evidence received",
    });
    expect(handler).toHaveBeenCalledWith(
      { requestId: "distinctive-request" },
      expect.objectContaining({
        principal,
        sessionId: "session-a",
        model: expect.objectContaining({ model }),
      }),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool.requested",
          toolName: "host_evidence",
          displayInput: { requestId: "distinctive-request" },
        }),
        expect.objectContaining({
          type: "tool.completed",
          toolName: "host_evidence",
          displayContent: { status: "host evidence loaded" },
        }),
      ]),
    );
  });

  it("forwards an explicit ephemeral transcript policy without persisting messages", async () => {
    const backend = new FixtureBackend();
    const { runtime } = createModels(backend);
    const sessions = new InMemoryAgentStateRepository<typeof principal>();
    const transcripts = new InMemoryAgentTranscriptStore<typeof principal>();
    const agent = createNodeHostAgent({
      ownerId: "node-host-test",
      models: runtime,
      persistence: {
        sessions,
        turnLeases: new InMemoryAgentTurnLeaseProvider<typeof principal>(),
      },
      instructions: () => "Use host tools only.",
      defaultModel: model,
      transcriptPolicy: { mode: "ephemeral", store: transcripts },
      maxOutputTokens: 512,
    });

    await agent.sessions.create({ principal, sessionId: "ephemeral" });
    await collect(
      agent.sessions.runTurn({
        principal,
        sessionId: "ephemeral",
        input: { text: "private message", attachments: undefined },
        model: undefined,
      }),
    );

    await expect(
      sessions.readSession({ principal, sessionId: "ephemeral" }),
    ).resolves.toMatchObject({ record: { messages: [] } });
    await expect(
      agent.sessions.read({ principal, sessionId: "ephemeral" }),
    ).resolves.toMatchObject({
      record: {
        messages: expect.arrayContaining([
          { role: "user", content: "private message" },
        ]),
      },
    });
  });

  it("forwards the runtime reasoning default into the core engine", async () => {
    const { backend, runtime } = createModels(new FixtureBackend(), {
      ...capabilities,
      supportsThinking: true,
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    });
    const agent = createNodeHostAgent({
      ownerId: "node-host-test",
      models: runtime,
      persistence: {
        sessions: new InMemoryAgentStateRepository<typeof principal>(),
        turnLeases: new InMemoryAgentTurnLeaseProvider<typeof principal>(),
      },
      instructions: () => "Use host tools only.",
      defaultModel: model,
      defaultReasoningEffort: "high",
      maxOutputTokens: 512,
    });

    await agent.sessions.create({ principal, sessionId: "reasoning" });
    await collect(
      agent.sessions.runTurn({
        principal,
        sessionId: "reasoning",
        input: { text: "reason", attachments: undefined },
        model: undefined,
      }),
    );

    expect(backend.requests[0]?.reasoningEffort).toBe("high");
  });

  it("does not create an implicit tool resolver", () => {
    expect(createNodeHostTools({})).toBeUndefined();
    expect(() =>
      createNodeHostTools({
        tools: [],
        resolveTools: () => [],
      }),
    ).toThrow(/static or dynamically resolved/i);
  });
});
