import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentConfig } from "./types.js";
import { AgentEngine } from "./AgentEngine.js";
import { AgentSession } from "./AgentSession.js";

const mocks = vi.hoisted(() => ({
  mockBuildSystemPrompt: vi.fn().mockResolvedValue("mock system prompt"),
  mockStream: vi.fn(),
  mockCreateAnthropicClient: vi.fn(),
  mockRefreshClaudeCredentials: vi.fn().mockReturnValue(false),
  mockSummarizeConversation: vi.fn(),
  mockGetEffectiveHistory: vi.fn((messages: unknown[]) => messages),
  mockInjectSyntheticToolResults: vi.fn((messages: unknown[]) => messages),
}));

vi.mock("./systemPrompt.js", () => ({
  buildSystemPrompt: mocks.mockBuildSystemPrompt,
}));

vi.mock("./clientFactory.js", () => ({
  createAnthropicClient: mocks.mockCreateAnthropicClient,
  refreshClaudeCredentials: mocks.mockRefreshClaudeCredentials,
}));

vi.mock("./condense.js", () => ({
  summarizeConversation: mocks.mockSummarizeConversation,
  getEffectiveHistory: mocks.mockGetEffectiveHistory,
  injectSyntheticToolResults: mocks.mockInjectSyntheticToolResults,
}));

const testConfig: AgentConfig = {
  model: "claude-sonnet-4-6",
  maxTokens: 8192,
  thinkingBudget: 0,
  showThinking: false,
  autoCondense: true,
  autoCondenseThreshold: 0.9,
};

function makeStream(events: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function makeSimpleTextResponse(opts?: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  text?: string;
}): AsyncIterable<unknown> {
  const inputTokens = opts?.inputTokens ?? 100;
  const outputTokens = opts?.outputTokens ?? 40;
  const cacheReadTokens = opts?.cacheReadTokens ?? 0;
  const cacheCreationTokens = opts?.cacheCreationTokens ?? 0;
  const text = opts?.text ?? "ok";
  return makeStream([
    {
      type: "message_start",
      message: {
        usage: {
          input_tokens: inputTokens,
          cache_read_input_tokens: cacheReadTokens,
          cache_creation_input_tokens: cacheCreationTokens,
        },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", usage: { output_tokens: outputTokens } },
  ]);
}

async function makeSession(
  config: AgentConfig = testConfig,
): Promise<AgentSession> {
  return AgentSession.create({
    mode: "code",
    config,
    cwd: "/test",
  });
}

async function collectEvents(
  iter: AsyncGenerator<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

describe("AgentEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockCreateAnthropicClient.mockReturnValue({
      client: { messages: { stream: mocks.mockStream } },
      authSource: "explicit",
    });
    mocks.mockStream.mockReturnValue(makeSimpleTextResponse());
  });

  describe("auto-condense threshold behavior", () => {
    it("triggers auto-condense at 90% usage by default", async () => {
      const session = await makeSession();
      session.addUserMessage("hello");
      session.lastInputTokens = 180_000; // 90% of 200k window
      session.lastCacheReadTokens = 0;

      const engine = new AgentEngine("test-key");
      const condenseSpy = vi.spyOn(engine, "condenseSession").mockImplementation(
        async function* () {
          yield { type: "condense_start", isAutomatic: true };
          yield {
            type: "condense",
            summary: "summary",
            prevInputTokens: 180_000,
            newInputTokens: 20_000,
          };
        },
      );

      const events = await collectEvents(engine.run(session));
      expect(condenseSpy).toHaveBeenCalledTimes(1);
      expect(events.some((e) => e.type === "condense")).toBe(true);
    });

    it("does not auto-condense below threshold", async () => {
      const session = await makeSession();
      session.addUserMessage("hello");
      session.lastInputTokens = 170_000; // 85%
      session.lastCacheReadTokens = 0;

      const engine = new AgentEngine("test-key");
      const condenseSpy = vi.spyOn(engine, "condenseSession");

      await collectEvents(engine.run(session));
      expect(condenseSpy).not.toHaveBeenCalled();
    });

    it("uses cache-aware threshold and delays condense when cache hit ratio is high", async () => {
      const session = await makeSession();
      session.addUserMessage("hello");
      session.lastInputTokens = 184_000; // 92%
      session.lastCacheReadTokens = 92_000; // 50% cache-hit ratio => threshold 95%

      const engine = new AgentEngine("test-key");
      const condenseSpy = vi.spyOn(engine, "condenseSession");

      await collectEvents(engine.run(session));
      expect(condenseSpy).not.toHaveBeenCalled();
    });

    it("caps cache-aware threshold at 95%", async () => {
      const session = await makeSession();
      session.addUserMessage("hello");
      session.lastInputTokens = 190_000; // 95%
      session.lastCacheReadTokens = 190_000; // ratio=1 would push above 100%, but cap is 95%

      const engine = new AgentEngine("test-key");
      const condenseSpy = vi.spyOn(engine, "condenseSession").mockImplementation(
        async function* () {
          yield { type: "condense_start", isAutomatic: true };
          yield {
            type: "condense",
            summary: "summary",
            prevInputTokens: 190_000,
            newInputTokens: 20_000,
          };
        },
      );

      await collectEvents(engine.run(session));
      expect(condenseSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("token accounting", () => {
    it("reports api_request inputTokens as uncached + cache_read + cache_creation", async () => {
      mocks.mockStream.mockReturnValue(
        makeSimpleTextResponse({
          inputTokens: 50,
          outputTokens: 25,
          cacheReadTokens: 9000,
          cacheCreationTokens: 1000,
        }),
      );

      const session = await makeSession();
      session.addUserMessage("hello");
      const engine = new AgentEngine("test-key");

      const events = await collectEvents(engine.run(session));
      const apiRequest = events.find((e) => e.type === "api_request");
      expect(apiRequest).toBeDefined();
      if (!apiRequest || apiRequest.type !== "api_request") return;

      expect(apiRequest.inputTokens).toBe(10_050);
      expect(apiRequest.cacheReadTokens).toBe(9000);
      expect(apiRequest.cacheCreationTokens).toBe(1000);
      expect(session.lastInputTokens).toBe(10_050);
      expect(session.totalInputTokens).toBe(50);
      expect(session.totalCacheReadTokens).toBe(9000);
      expect(session.totalCacheCreationTokens).toBe(1000);
    });
  });

  describe("condenseSession", () => {
    it("clears lastCacheReadTokens after successful condense", async () => {
      mocks.mockSummarizeConversation.mockResolvedValue({
        messages: [{ role: "user", content: "summary", isSummary: true }],
        summary: "summary",
        prevInputTokens: 180_000,
        newInputTokens: 12_000,
      });

      const session = await makeSession();
      session.addUserMessage("hello");
      session.lastInputTokens = 180_000;
      session.lastCacheReadTokens = 100_000;

      const engine = new AgentEngine("test-key");
      const events = await collectEvents(engine.condenseSession(session, true));

      expect(events.some((e) => e.type === "condense")).toBe(true);
      expect(session.lastInputTokens).toBe(12_000);
      expect(session.lastCacheReadTokens).toBe(0);
    });
  });
});
