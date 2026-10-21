import { describe, expect, it } from "vitest";

import { createAgentEngine } from "./agentEngine.js";
import {
  createSummarizingContextCondenser,
  getContextCondenseBudget,
  isContextTooLongError,
  projectCondensedHistory,
  stripCondenseMarkers,
} from "./contextCondenser.js";
import {
  CoreModelBackendRegistry,
  DefaultCoreModelRuntime,
  type CoreModelBackend,
  type CoreModelCapabilities,
  type CoreModelCompleteRequest,
  type CoreModelMessage,
  type CoreModelStreamEvent,
  type CoreModelStreamRequest,
} from "./modelRuntime.js";
import { InMemoryAgentStateRepository } from "./sessionRepository.js";
import type { AgentTurnEvent } from "./turnContracts.js";
import { InMemoryAgentTurnLeaseProvider } from "./turnLeases.js";

const PRINCIPAL = { tenantId: "tenant-a", subjectId: "subject-a" };
const MODEL = { providerId: "fake", modelId: "model-a" };

class ScriptedBackend implements CoreModelBackend {
  readonly providerId = MODEL.providerId;
  readonly displayName = "Fake";
  readonly condenseModel = "model-small";
  readonly requests: Array<{ messages: CoreModelMessage[] }> = [];
  readonly completions: CoreModelCompleteRequest[] = [];

  constructor(
    private readonly turns: Array<
      | readonly CoreModelStreamEvent[]
      | (() => AsyncGenerator<CoreModelStreamEvent>)
    >,
    private readonly capabilities: CoreModelCapabilities,
    private readonly onComplete?: () => void,
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
  ): AsyncGenerator<CoreModelStreamEvent> {
    this.requests.push({ messages: structuredClone(request.messages) });
    request.onProviderRequestAttempt?.({ model: request.model });
    const turn = this.turns.shift();
    if (!turn) throw new Error("No scripted turn remains");
    if (typeof turn === "function") {
      yield* turn();
      return;
    }
    yield* turn;
  }

  async complete(request: CoreModelCompleteRequest) {
    this.completions.push(request);
    this.onComplete?.();
    return { text: "<summary>CONDENSED-PARSER-WORK</summary>" };
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

function caps(contextWindow: number): CoreModelCapabilities {
  return {
    supportsThinking: false,
    supportsCaching: false,
    supportsImages: false,
    supportsToolUse: true,
    contextWindow,
    maxOutputTokens: 4_096,
  };
}

function setup(backend: ScriptedBackend) {
  const registry = new CoreModelBackendRegistry();
  registry.register(backend);
  const state = new InMemoryAgentStateRepository();
  let turn = 0;
  const engine = createAgentEngine({
    ownerId: "engine-a",
    models: new DefaultCoreModelRuntime(registry, { ownerId: "test" }),
    sessions: state,
    turnLeases: new InMemoryAgentTurnLeaseProvider(),
    defaultModel: MODEL,
    resolveInstructions: () => "You are a test assistant.",
    createSessionId: () => "session-1",
    createTurnId: () => `turn-${++turn}`,
    contextCondenser: createSummarizingContextCondenser(),
  });
  const run = async (text: string, signal?: AbortSignal) => {
    const events: AgentTurnEvent[] = [];
    const stream = engine.sessions.runTurn(
      {
        principal: PRINCIPAL,
        sessionId: "session-1",
        model: undefined,
        input: { text, attachments: [] },
      },
      { signal },
    );
    for (;;) {
      const next = await stream.next();
      if (next.done) return { result: next.value, events };
      events.push(next.value);
    }
  };
  return { engine, run };
}

function textOf(messages: readonly CoreModelMessage[]): string {
  return JSON.stringify(messages);
}

// ~10.5k tokens: over 90% of the 9,904-token usable input of `caps(14_000)`.
const LONG_REPLY = "parser detail ".repeat(3_000);

describe("engine context condensing", () => {
  it("condenses before a turn near the limit, sends VS Code's projection and keeps the full transcript", async () => {
    const backend = new ScriptedBackend(
      [finalTurn(LONG_REPLY), finalTurn("second done")],
      caps(14_000),
    );
    const { engine, run } = setup(backend);
    await engine.sessions.create({ principal: PRINCIPAL });

    const first = await run("start the parser");
    expect(first.result).toMatchObject({ status: "completed" });
    expect(first.events.map((event) => event.type)).not.toContain(
      "context.condensing",
    );

    const second = await run("now add tests");
    expect(second.result.status).toBe("completed");
    expect(
      second.events.filter((event) => event.type.startsWith("context.")),
    ).toMatchObject([
      { type: "context.condensing", trigger: "threshold" },
      { type: "context.condensed", trigger: "threshold", status: "condensed" },
    ]);
    expect(backend.completions[0]).toMatchObject({ model: "model-small" });

    const sent = backend.requests[1]!.messages;
    expect(sent).toHaveLength(4);
    expect(sent[0]).toEqual({ role: "user", content: "start the parser" });
    expect(textOf(sent)).toContain("CONDENSED-PARSER-WORK");
    expect(textOf(sent)).not.toContain(LONG_REPLY);
    expect(sent.at(-1)).toEqual({ role: "user", content: "now add tests" });
    for (const message of sent) {
      expect(Object.keys(message).sort()).toEqual(["content", "role"]);
    }

    const read = await engine.sessions.read({
      principal: PRINCIPAL,
      sessionId: "session-1",
    });
    if (!read.ok) throw new Error("session missing");
    const stored = read.record.messages;
    expect(textOf(stored)).toContain(LONG_REPLY);
    const summary = stored.find((message) => message.isSummary);
    expect(summary?.condenseId).toBeTruthy();
    expect(stored[1]?.condenseParent).toBe(summary?.condenseId);
    expect(stored.at(-1)).toMatchObject({ role: "assistant" });
  });

  it("condenses and retries once when the provider rejects a request as too long", async () => {
    const backend = new ScriptedBackend(
      [
        finalTurn(LONG_REPLY),
        async function* () {
          yield { type: "text_delta", text: "PARTIAL " };
          throw new Error("prompt is too long: 300000 tokens > 200000 maximum");
        },
        finalTurn("retried"),
      ],
      caps(1_000_000),
    );
    const { engine, run } = setup(backend);
    await engine.sessions.create({ principal: PRINCIPAL });
    await run("start the parser");

    const second = await run("now add tests");
    expect(second.result).toMatchObject({
      status: "completed",
      text: "retried",
    });
    expect(
      second.events.filter(
        (event) =>
          event.type.startsWith("context.") || event.type === "response.retry",
      ),
    ).toMatchObject([
      { type: "context.condensing", trigger: "context_too_long" },
      {
        type: "context.condensed",
        trigger: "context_too_long",
        status: "condensed",
      },
      // Clears the text the rejected attempt already streamed.
      { type: "response.retry", reason: "context_too_long" },
    ]);
    expect(textOf(backend.requests[1]!.messages)).toContain(LONG_REPLY);
    expect(textOf(backend.requests[2]!.messages)).not.toContain(LONG_REPLY);
    expect(textOf(backend.requests[2]!.messages)).toContain(
      "CONDENSED-PARSER-WORK",
    );
  });
});

describe("engine context condensing cancellation", () => {
  it("reports a turn cancelled while summarising as cancelled", async () => {
    const abort = new AbortController();
    const backend = new ScriptedBackend(
      [finalTurn(LONG_REPLY)],
      caps(14_000),
      () => abort.abort("Stopped by the user"),
    );
    const { engine, run } = setup(backend);
    await engine.sessions.create({ principal: PRINCIPAL });
    await run("start the parser");

    const second = await run("now add tests", abort.signal);
    expect(second.result).toMatchObject({ status: "cancelled" });
    expect(backend.requests).toHaveLength(1);
  });
});

describe("condense helpers", () => {
  it("matches VS Code's budget and context-too-long rules", () => {
    const budget = getContextCondenseBudget({
      modelId: "model-a",
      capabilities: caps(100_000),
      usedTokens: 0,
    });
    // 0.9 default threshold of 95,904 usable input; 5% safety buffer.
    expect(budget.maxInputTokens).toBe(95_904);
    expect(budget.softThresholdBudget).toBe(Math.floor(95_904 * 0.9));
    expect(budget.hardBudget).toBe(95_904 - Math.floor(95_904 * 0.05));
    expect(isContextTooLongError(new Error("maximum context length"))).toBe(
      true,
    );
    expect(
      isContextTooLongError(
        Object.assign(new Error("x"), { code: "context_window_exceeded" }),
      ),
    ).toBe(true);
    expect(isContextTooLongError(new Error("rate limited"))).toBe(false);
  });

  it("projects past a stored summary and strips markers", () => {
    const history: CoreModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "old", condenseParent: "c1" },
      { role: "user", content: "summary", isSummary: true, condenseId: "c1" },
      { role: "assistant", content: "after" },
    ];
    const projected =
      projectCondensedHistory(history).map(stripCondenseMarkers);
    expect(projected.map((message) => message.content)).toEqual([
      "first",
      "summary",
      expect.anything(),
      "after",
    ]);
    expect(textOf(projected)).not.toContain('"old"');
    expect(textOf(projected)).not.toMatch(
      /isSummary|condenseId|isResumeContext/,
    );
  });
});
