import {
  CoreModelBackendRegistry,
  DefaultCoreModelRuntime,
  InMemoryAgentStateRepository,
  InMemoryAgentTurnLeaseProvider,
  createAgentEngine,
  defineTool,
} from "@agentlink/core";

import assert from "node:assert/strict";
import { resolveCoreModelCatalogReadiness } from "@agentlink/protocol/model-catalog";

const MODEL = { providerId: "fixture", modelId: "fixture-model" };
const PRINCIPAL_A = { tenantId: "tenant", subjectId: "a" };
const PRINCIPAL_B = { tenantId: "tenant", subjectId: "b" };
let markCancellationStarted;
const cancellationStarted = new Promise((resolve) => {
  markCancellationStarted = resolve;
});

const CAPS = {
  supportsThinking: false,
  supportsCaching: false,
  supportsImages: false,
  supportsToolUse: true,
  contextWindow: 32_768,
  maxOutputTokens: 4_096,
};

class FixtureBackend {
  providerId = MODEL.providerId;
  displayName = "Fixture";
  condenseModel = MODEL.modelId;

  listModels() {
    return [
      {
        id: MODEL.modelId,
        displayName: "Fixture model",
        providerId: this.providerId,
        contextWindow: CAPS.contextWindow,
        maxOutputTokens: CAPS.maxOutputTokens,
        authenticated: true,
        availability: "ready",
      },
    ];
  }

  getCapabilities() {
    return CAPS;
  }

  async *stream(request) {
    request.onProviderRequestAttempt?.({ model: request.model });
    const last = request.messages.at(-1);
    const text = typeof last?.content === "string" ? last.content : "";
    if (text.includes("cancel")) {
      markCancellationStarted();
      await new Promise((resolve) => {
        if (request.signal?.aborted) resolve();
        else request.signal?.addEventListener("abort", resolve, { once: true });
      });
      const error = new Error("cancelled");
      error.name = "AbortError";
      throw error;
    }
    const priorToolResult = [...request.messages]
      .reverse()
      .find(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some((block) => block.type === "tool_result"),
      );
    if (priorToolResult) {
      const replayedToolResult = JSON.stringify(priorToolResult.content);
      const answer = replayedToolResult.includes("call-get_sleep_history")
        ? "Sleep data loaded"
        : "Metrics loaded";
      yield { type: "text_delta", text: answer };
      yield { type: "usage", inputTokens: 8, outputTokens: 3 };
      yield {
        type: "model_stop",
        reason: "end_turn",
        assistantMessage: {
          role: "assistant",
          content: [{ type: "text", text: answer }],
        },
      };
      yield { type: "done" };
      return;
    }
    const toolName = text.includes("sleep")
      ? "get_sleep_history"
      : "query_metrics";
    yield {
      type: "tool_done",
      toolCallId: `call-${toolName}`,
      toolName,
      input: { subjectId: text },
    };
    yield {
      type: "model_stop",
      reason: "tool_use",
      assistantMessage: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: `call-${toolName}`,
            name: toolName,
            input: { subjectId: text },
          },
        ],
      },
    };
    yield { type: "done" };
  }

  async complete() {
    return { text: "fixture completion" };
  }
}

const state = new InMemoryAgentStateRepository();
const leases = new InMemoryAgentTurnLeaseProvider();
let turnId = 0;

function createRuntime() {
  const registry = new CoreModelBackendRegistry();
  registry.register(new FixtureBackend());
  return new DefaultCoreModelRuntime(registry, { ownerId: "fixture" });
}

function createFixtureEngine() {
  return createAgentEngine({
    ownerId: "fixture-engine",
    models: createRuntime(),
    sessions: state,
    turnLeases: leases,
    defaultModel: MODEL,
    resolveInstructions: () => ({
      identity: "You are the packed AgentLink fixture.",
      instructions: "Use only host tools for synthetic data.",
    }),
    resolveTools: ({ principal }) => [
      defineTool({
        name: "query_metrics",
        description: "Query synthetic metrics",
        inputSchema: { type: "object", additionalProperties: true },
        effect: "read",
        parallelSafe: true,
        handler: async () => ({
          modelContent: JSON.stringify({
            subjectId: principal.subjectId,
            metric: 42,
          }),
          displayContent: { kind: "status", text: "Metrics loaded" },
        }),
      }),
      defineTool({
        name: "get_sleep_history",
        description: "Read synthetic sleep history",
        inputSchema: { type: "object", additionalProperties: true },
        effect: "read",
        parallelSafe: true,
        handler: async () => ({
          modelContent: JSON.stringify({
            subjectId: principal.subjectId,
            hours: 8,
          }),
          displayContent: { kind: "status", text: "Sleep data loaded" },
        }),
      }),
    ],
    createSessionId: () => `session-${turnId + 1}`,
    createTurnId: () => `turn-${++turnId}`,
    maxOutputTokens: 512,
    limits: {
      maxModelCalls: 12,
      maxToolCalls: 12,
      maxElapsedMs: 30_000,
      maxToolResultBytes: 64_000,
    },
  });
}

async function collect(stream) {
  const events = [];
  for (;;) {
    const next = await stream.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

assert.deepEqual(resolveCoreModelCatalogReadiness({ authenticated: true }), {
  status: "ready",
});

const singleton = createFixtureEngine();
const catalog = await singleton.models.listCatalog({
  principal: PRINCIPAL_A,
  authContext: undefined,
});
assert.deepEqual(
  catalog.models.map((entry) => entry.ref),
  [MODEL],
);

await singleton.sessions.create({
  principal: PRINCIPAL_A,
  sessionId: "shared-session",
});
await singleton.sessions.create({
  principal: PRINCIPAL_B,
  sessionId: "shared-session",
});
const singletonResults = await Promise.all([
  collect(
    singleton.sessions.runTurn({
      principal: PRINCIPAL_A,
      sessionId: "shared-session",
      input: { text: "metrics for a", attachments: undefined },
      model: MODEL,
    }),
  ),
  collect(
    singleton.sessions.runTurn({
      principal: PRINCIPAL_B,
      sessionId: "shared-session",
      input: { text: "sleep for b", attachments: undefined },
      model: undefined,
    }),
  ),
]);
const [turnA, turnB] = singletonResults;
assert.equal(turnA.result.status, "completed");
assert.equal(turnB.result.status, "completed");
assert.equal(turnA.result.text, "Metrics loaded");
assert.equal(turnB.result.text, "Sleep data loaded");

const recreated = createFixtureEngine();
const continued = await collect(
  recreated.sessions.runTurn({
    principal: PRINCIPAL_A,
    sessionId: "shared-session",
    input: { text: "sleep after recreation", attachments: undefined },
    model: undefined,
  }),
);
assert.equal(continued.result.status, "completed");

await recreated.sessions.create({
  principal: PRINCIPAL_A,
  sessionId: "cancel-session",
});
const controller = new AbortController();
const cancelled = collect(
  recreated.sessions.runTurn(
    {
      principal: PRINCIPAL_A,
      sessionId: "cancel-session",
      input: { text: "cancel this turn", attachments: undefined },
      model: undefined,
    },
    { signal: controller.signal },
  ),
);
await cancellationStarted;
controller.abort("fixture cancellation");
const cancelledResult = await cancelled;
assert.equal(cancelledResult.result.status, "cancelled");
const cancelledSession = await recreated.sessions.read({
  principal: PRINCIPAL_A,
  sessionId: "cancel-session",
});
assert.equal(cancelledSession.ok, true);
if (!cancelledSession.ok) throw new Error("cancelled fixture session missing");
assert.equal(cancelledSession.record.runState.phase, "idle");
assert.equal(cancelledSession.record.lastTurnId, cancelledResult.result.turnId);

const [sessionA, sessionB] = await Promise.all([
  recreated.sessions.read({
    principal: PRINCIPAL_A,
    sessionId: "shared-session",
  }),
  recreated.sessions.read({
    principal: PRINCIPAL_B,
    sessionId: "shared-session",
  }),
]);
assert.equal(sessionA.ok, true);
assert.equal(sessionB.ok, true);
if (!sessionA.ok || !sessionB.ok) throw new Error("fixture sessions missing");
assert.equal(sessionA.record.principal.subjectId, "a");
assert.equal(sessionB.record.principal.subjectId, "b");
assert.notDeepEqual(sessionA.record.messages, sessionB.record.messages);
const tenantIsolation =
  sessionA.record.principal.subjectId !== sessionB.record.principal.subjectId &&
  JSON.stringify(sessionA.record.messages) !==
    JSON.stringify(sessionB.record.messages);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    catalogModels: catalog.models.length,
    singletonTurns: singletonResults.filter(
      ({ result }) => result.status === "completed",
    ).length,
    recreatedTurns: continued.result.status === "completed" ? 1 : 0,
    cancellation: cancelledResult.result.status,
    cancellationPersisted:
      cancelledSession.record.runState.phase === "idle" &&
      cancelledSession.record.lastTurnId === cancelledResult.result.turnId,
    tenantIsolation,
  })}\n`,
);
