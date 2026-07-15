import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { AgentConfig, AgentEvent } from "./types.js";
import type {
  CompleteRequest,
  CompleteResult,
  ModelCapabilities,
  ModelInfo,
  ModelProvider,
  ProviderStreamEvent,
  StreamRequest,
  ToolDefinition,
} from "./providers/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentEngine, truncateToolText } from "./AgentEngine.js";
import { AgentSession } from "./AgentSession.js";
import { ProviderRegistry } from "./providers/index.js";
import { AgentToolCallTracker } from "./AgentToolCallTracker.js";
import type { AgentToolExecutionRequest } from "../core/tools/types.js";
import {
  createAgentToolRuntime,
  type ToolDispatchContext,
} from "./toolAdapter.js";

const mocks = vi.hoisted(() => ({
  mockMkdir: vi.fn<typeof import("fs/promises").mkdir>(),
  mockWriteFile: vi.fn<typeof import("fs/promises").writeFile>(),
  mockBuildSystemPrompt: vi.fn().mockResolvedValue("mock system prompt"),
  mockBuildPromptArtifacts: vi.fn().mockResolvedValue({
    systemPrompt: "mock system prompt",
    skills: [],
    promptBreakdown: {
      sections: [{ label: "test", chars: 18, estimatedTokens: 5 }],
      totalChars: 18,
      estimatedTokens: 5,
    },
  }),
  mockSummarizeConversation: vi.fn(),
  mockGetEffectiveHistory: vi.fn((messages: unknown[]) => messages),
  mockInjectSyntheticToolResults: vi.fn((messages: unknown[]) => messages),
  mockEnforceToolResultAdjacency: vi.fn((messages: unknown[]) => messages),
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  mocks.mockMkdir.mockImplementation(actual.mkdir);
  mocks.mockWriteFile.mockImplementation(actual.writeFile);
  return {
    ...actual,
    default: {
      ...actual,
      mkdir: mocks.mockMkdir,
      writeFile: mocks.mockWriteFile,
    },
    mkdir: mocks.mockMkdir,
    writeFile: mocks.mockWriteFile,
  };
});

vi.mock("./systemPrompt.js", () => ({
  buildSystemPrompt: mocks.mockBuildSystemPrompt,
  buildPromptArtifacts: mocks.mockBuildPromptArtifacts,
}));

vi.mock("./condense.js", () => ({
  summarizeConversation: mocks.mockSummarizeConversation,
  getEffectiveHistory: mocks.mockGetEffectiveHistory,
  injectSyntheticToolResults: mocks.mockInjectSyntheticToolResults,
  enforceToolResultAdjacency: mocks.mockEnforceToolResultAdjacency,
}));

const TEST_MODEL = "claude-sonnet-4-6";

const testConfig: AgentConfig = {
  model: TEST_MODEL,
  maxTokens: 8192,
  thinkingBudget: 0,
  showThinking: false,
  autoCondense: true,
  autoCondenseThreshold: 0.9,
};

/**
 * Build a mock stream of ProviderStreamEvents for a simple text response.
 */
function makeProviderStream(opts?: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  text?: string;
}): ProviderStreamEvent[] {
  const inputTokens = opts?.inputTokens ?? 100;
  const outputTokens = opts?.outputTokens ?? 40;
  const cacheReadTokens = opts?.cacheReadTokens ?? 0;
  const cacheCreationTokens = opts?.cacheCreationTokens ?? 0;
  const text = opts?.text ?? "ok";
  return [
    { type: "text_delta", text },
    {
      type: "content_blocks",
      blocks: [{ type: "text", text }],
    },
    {
      type: "usage",
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    },
    { type: "done" },
  ];
}

const TEST_CAPABILITIES: ModelCapabilities = {
  supportsThinking: false,
  supportsCaching: true,
  supportsImages: true,
  supportsToolUse: true,
  contextWindow: 200_000,
  maxOutputTokens: 8192,
};

/**
 * Create a mock ModelProvider that yields from a configurable event list.
 */
function makeMockProvider(
  streamEvents?: ProviderStreamEvent[],
): ModelProvider & { setStreamEvents: (e: ProviderStreamEvent[]) => void } {
  let events = streamEvents ?? makeProviderStream();
  return {
    id: "mock",
    displayName: "Mock",
    condenseModel: "mock-fast",
    async isAuthenticated() {
      return true;
    },
    getCapabilities() {
      return TEST_CAPABILITIES;
    },
    listModels(): ModelInfo[] {
      return [
        {
          id: TEST_MODEL,
          displayName: "Claude Sonnet 4.6",
          provider: "mock",
          capabilities: TEST_CAPABILITIES,
        },
      ];
    },
    async *stream(_request: StreamRequest) {
      for (const event of events) {
        yield event;
      }
    },
    async complete(_request: CompleteRequest): Promise<CompleteResult> {
      return { text: "ok" };
    },
    setStreamEvents(e: ProviderStreamEvent[]) {
      events = e;
    },
  };
}

function makeRegistry(provider?: ModelProvider): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(provider ?? makeMockProvider());
  return registry;
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

function setEngineToolContext(
  engine: AgentEngine,
  ctx: ToolDispatchContext,
  executeTool?: (request: AgentToolExecutionRequest) => Promise<unknown>,
): void {
  const runtime = createAgentToolRuntime(ctx);
  engine.setToolRuntime(
    executeTool
      ? {
          ...runtime,
          async executeTool(request) {
            return (await executeTool(request)) as Awaited<
              ReturnType<typeof runtime.executeTool>
            >;
          },
        }
      : runtime,
  );
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

describe("truncateToolText", () => {
  it("returns pass-through text without scheduling a temp-file write", () => {
    expect(truncateToolText("short output", 20, "call_short")).toBe(
      "short output",
    );
    expect(mocks.mockMkdir).not.toHaveBeenCalled();
    expect(mocks.mockWriteFile).not.toHaveBeenCalled();
  });

  it("schedules the original truncated text and emits the exact temp-file suffix", async () => {
    const text = `${"head".repeat(10_001)}\ntail`;
    mocks.mockMkdir.mockResolvedValueOnce(undefined);
    mocks.mockWriteFile.mockResolvedValueOnce();

    const result = truncateToolText(text, 40_000, "call_large");
    await vi.waitFor(() => expect(mocks.mockWriteFile).toHaveBeenCalledOnce());

    expect(mocks.mockMkdir).toHaveBeenCalledWith("/tmp/agentlink-results", {
      recursive: true,
    });
    expect(mocks.mockWriteFile).toHaveBeenCalledWith(
      "/tmp/agentlink-results/call_large.txt",
      text,
      "utf-8",
    );
    expect(result).toContain(
      "\nFull output saved to: /tmp/agentlink-results/call_large.txt — use read_file to access the complete result.\n\n",
    );
  });
});

describe("AgentEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Soft threshold applies to projected request input. For fixed-envelope models,
  // usable input is contextWindow - maxOutputTokens.
  describe("auto-condense threshold behavior", () => {
    it("triggers auto-condense at 90% of usable input by default", async () => {
      const session = await makeSession();
      session.addUserMessage("hello");
      session.lastInputTokens = 173_000; // >90% of 191,808 usable input tokens
      session.lastCacheReadTokens = 0;

      const engine = new AgentEngine(makeRegistry());
      const condenseSpy = vi
        .spyOn(engine, "condenseSession")
        .mockImplementation(async function* () {
          yield { type: "condense_start", isAutomatic: true };
          yield {
            type: "condense",
            summary: "summary",
            prevInputTokens: 173_000,
            newInputTokens: 20_000,
          };
          return true;
        });

      const events = await collectEvents(engine.run(session));
      expect(condenseSpy).toHaveBeenCalledTimes(1);
      expect(events.some((e) => e.type === "condense")).toBe(true);
    });

    it("does not auto-condense below the usable input threshold", async () => {
      const session = await makeSession();
      session.addUserMessage("hello");
      session.lastInputTokens = 170_000; // below 90% of 191,808 usable input tokens
      session.lastCacheReadTokens = 0;

      const engine = new AgentEngine(makeRegistry());
      const condenseSpy = vi.spyOn(engine, "condenseSession");

      await collectEvents(engine.run(session));
      expect(condenseSpy).not.toHaveBeenCalled();
    });

    it("still condenses when the hard-fit guardrail is exceeded even if cache raises the soft threshold", async () => {
      const session = await makeSession();
      session.addUserMessage("hello");
      session.lastInputTokens = 183_000; // exceeds hard fit limit for 191,808 usable input tokens
      session.lastCacheReadTokens = 91_500; // 50% cache-hit ratio => soft threshold rises to 95%

      const engine = new AgentEngine(makeRegistry());
      const condenseSpy = vi
        .spyOn(engine, "condenseSession")
        .mockImplementation(async function* () {
          yield { type: "condense_start", isAutomatic: true };
          yield {
            type: "condense",
            summary: "summary",
            prevInputTokens: 183_000,
            newInputTokens: 20_000,
          };
          return true;
        });

      await collectEvents(engine.run(session));
      expect(condenseSpy).toHaveBeenCalledTimes(1);
    });

    it("caps cache-aware threshold at 95%", async () => {
      const session = await makeSession();
      session.addUserMessage("hello");
      session.lastInputTokens = 183_000; // above 95% of 191,808 usable input tokens
      session.lastCacheReadTokens = 183_000; // ratio=1 would push above 100%, but cap is 95%

      const engine = new AgentEngine(makeRegistry());
      const condenseSpy = vi
        .spyOn(engine, "condenseSession")
        .mockImplementation(async function* () {
          yield { type: "condense_start", isAutomatic: true };
          yield {
            type: "condense",
            summary: "summary",
            prevInputTokens: 183_000,
            newInputTokens: 20_000,
          };
          return true;
        });

      await collectEvents(engine.run(session));
      expect(condenseSpy).toHaveBeenCalledTimes(1);
    });

    it("does not count previous output tokens against input-cap condensing", async () => {
      const session = await makeSession();
      session.addUserMessage("hello");
      session.lastInputTokens = 170_000; // below 90% of usable input
      session.lastOutputTokens = 40_000; // would exceed old total-window threshold
      session.lastCacheReadTokens = 0;

      const engine = new AgentEngine(makeRegistry());
      const condenseSpy = vi.spyOn(engine, "condenseSession");

      await collectEvents(engine.run(session));
      expect(condenseSpy).not.toHaveBeenCalled();
    });
  });

  describe("mode switch turn boundary", () => {
    it("stops current turn after successful switch_mode and skips trailing non-read-only tools", async () => {
      const streamCalls: StreamRequest[] = [];
      let callCount = 0;
      const provider: ModelProvider = {
        id: "mock",
        displayName: "Mock",
        condenseModel: "mock-fast",
        async isAuthenticated() {
          return true;
        },
        getCapabilities() {
          return TEST_CAPABILITIES;
        },
        listModels(): ModelInfo[] {
          return [
            {
              id: TEST_MODEL,
              displayName: "Mock",
              provider: "mock",
              capabilities: TEST_CAPABILITIES,
            },
          ];
        },
        async *stream(request: StreamRequest) {
          streamCalls.push(request);
          callCount += 1;
          if (callCount === 1) {
            yield {
              type: "content_blocks",
              blocks: [
                {
                  type: "tool_use",
                  id: "call_switch",
                  name: "switch_mode",
                  input: { mode: "architect", reason: "plan first" },
                },
                {
                  type: "tool_use",
                  id: "call_write",
                  name: "write_file",
                  input: { path: "src/x.ts", content: "x" },
                },
              ],
            };
            yield { type: "usage", inputTokens: 20, outputTokens: 5 };
            yield { type: "done" };
            return;
          }

          yield* makeProviderStream({ text: "should not run" });
        },
        async complete() {
          return { text: "ok" };
        },
      };

      const session = await makeSession();
      session.addUserMessage("switch and then continue");
      const engine = new AgentEngine(makeRegistry(provider));

      const writeSpy = vi
        .fn()
        .mockResolvedValue({ content: [{ type: "text", text: "write ok" }] });

      const toolCtx: ToolDispatchContext = {
        approvalManager: {} as ToolDispatchContext["approvalManager"],
        approvalPanel: {} as ToolDispatchContext["approvalPanel"],
        sessionId: "seed-session",
        extensionUri: {} as ToolDispatchContext["extensionUri"],
        onModeSwitch: vi.fn().mockResolvedValue({
          approved: true,
          mode: "architect",
        }),
      };
      const executeTool = vi.fn(async (request: AgentToolExecutionRequest) => {
        if (request.name === "switch_mode") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: true, mode: "architect" }),
              },
            ],
          };
        }
        if (request.name === "write_file") {
          return await writeSpy(request.name, request.input);
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
        };
      });
      setEngineToolContext(engine, toolCtx, executeTool);

      const events = await collectEvents(engine.run(session));

      expect(streamCalls).toHaveLength(1);
      expect(writeSpy).not.toHaveBeenCalled();
      expect(executeTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "switch_mode",
          input: { mode: "architect", reason: "plan first" },
          context: expect.objectContaining({ mode: "code" }),
        }),
      );

      const toolResults = events.filter(
        (e): e is Extract<AgentEvent, { type: "tool_result" }> =>
          e.type === "tool_result",
      );
      expect(toolResults).toHaveLength(2);
      expect(toolResults[0]).toMatchObject({
        toolName: "switch_mode",
      });
      expect(toolResults[1]).toMatchObject({
        toolName: "write_file",
      });
      if (toolResults[1].type !== "tool_result") return;
      const skippedText = toolResults[1].result
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n");
      expect(skippedText).toContain('"status":"skipped"');
      expect(skippedText).toContain('"skipped_by":"mode_switch"');

      expect(events.at(-1)).toMatchObject({ type: "done" });
    });

    it("allows read-only tools in mixed batches but skips trailing non-read-only tools after switch", async () => {
      const streamCalls: StreamRequest[] = [];
      let callCount = 0;
      const provider: ModelProvider = {
        id: "mock",
        displayName: "Mock",
        condenseModel: "mock-fast",
        async isAuthenticated() {
          return true;
        },
        getCapabilities() {
          return TEST_CAPABILITIES;
        },
        listModels(): ModelInfo[] {
          return [
            {
              id: TEST_MODEL,
              displayName: "Mock",
              provider: "mock",
              capabilities: TEST_CAPABILITIES,
            },
          ];
        },
        async *stream(request: StreamRequest) {
          streamCalls.push(request);
          callCount += 1;
          if (callCount === 1) {
            yield {
              type: "content_blocks",
              blocks: [
                {
                  type: "tool_use",
                  id: "call_read",
                  name: "read_file",
                  input: { path: "src/a.ts" },
                },
                {
                  type: "tool_use",
                  id: "call_switch",
                  name: "switch_mode",
                  input: { mode: "architect" },
                },
                {
                  type: "tool_use",
                  id: "call_write",
                  name: "write_file",
                  input: { path: "src/x.ts", content: "x" },
                },
              ],
            };
            yield { type: "usage", inputTokens: 30, outputTokens: 8 };
            yield { type: "done" };
            return;
          }
          yield* makeProviderStream({ text: "should not run" });
        },
        async complete() {
          return { text: "ok" };
        },
      };

      const session = await makeSession();
      session.addUserMessage("mixed batch");
      const engine = new AgentEngine(makeRegistry(provider));

      const readSpy = vi.fn().mockResolvedValue({
        content: [
          { type: "text", text: JSON.stringify({ ok: true, read: true }) },
        ],
      });
      const writeSpy = vi
        .fn()
        .mockResolvedValue({ content: [{ type: "text", text: "write ok" }] });

      const toolCtx: ToolDispatchContext = {
        approvalManager: {} as ToolDispatchContext["approvalManager"],
        approvalPanel: {} as ToolDispatchContext["approvalPanel"],
        sessionId: "seed-session",
        extensionUri: {} as ToolDispatchContext["extensionUri"],
        onModeSwitch: vi.fn().mockResolvedValue({
          approved: true,
          mode: "architect",
        }),
      };
      const executeTool = vi.fn(async (request: AgentToolExecutionRequest) => {
        if (request.name === "read_file") {
          return await readSpy(request.name, request.input);
        }
        if (request.name === "switch_mode") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: true, mode: "architect" }),
              },
            ],
          };
        }
        if (request.name === "write_file") {
          return await writeSpy(request.name, request.input);
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
        };
      });
      setEngineToolContext(engine, toolCtx, executeTool);

      const events = await collectEvents(engine.run(session));

      expect(streamCalls).toHaveLength(1);
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy).not.toHaveBeenCalled();

      const toolResults = events.filter(
        (e): e is Extract<AgentEvent, { type: "tool_result" }> =>
          e.type === "tool_result",
      );
      expect(toolResults.map((r) => r.toolName)).toEqual([
        "read_file",
        "switch_mode",
        "write_file",
      ]);
      const skippedText = toolResults[2].result
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n");
      expect(skippedText).toContain('"status":"skipped"');
      expect(skippedText).toContain('"skipped_by":"mode_switch"');

      expect(events.at(-1)).toMatchObject({ type: "done" });
    });

    it("registers queued write tools in the tracker before read-only tools finish", async () => {
      let callCount = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        callCount += 1;
        if (callCount === 1) {
          yield {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id: "call_read",
                name: "read_file",
                input: { path: "src/a.ts" },
              },
              {
                type: "tool_use",
                id: "call_write",
                name: "write_file",
                input: { path: "src/x.ts", content: "x" },
              },
            ],
          };
          yield { type: "usage", inputTokens: 20, outputTokens: 5 };
          yield { type: "done" };
          return;
        }
        yield* makeProviderStream({ text: "done" });
      };

      const session = await makeSession();
      session.addUserMessage("read then write");
      const engine = new AgentEngine(makeRegistry(provider));
      const tracker = new AgentToolCallTracker();
      const toolCtx: ToolDispatchContext = {
        approvalManager: {} as ToolDispatchContext["approvalManager"],
        approvalPanel: {} as ToolDispatchContext["approvalPanel"],
        sessionId: "seed-session",
        extensionUri: {} as ToolDispatchContext["extensionUri"],
        toolCallTracker: tracker,
      };
      let releaseRead!: () => void;
      const readCanFinish = new Promise<void>((release) => {
        releaseRead = release;
      });
      const readStarted = new Promise<void>((resolve) => {
        setEngineToolContext(engine, toolCtx, async (request) => {
          if (request.name === "read_file") {
            resolve();
            await readCanFinish;
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ ok: true, read: true }),
                },
              ],
            };
          }
          if (request.name === "write_file") {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ ok: true, write: true }),
                },
              ],
            };
          }
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
          };
        });
      });

      const runPromise = collectEvents(engine.run(session));
      await readStarted;

      expect(tracker.getActiveCalls().map((c) => c.toolName)).toEqual([
        "read_file",
        "write_file",
      ]);

      releaseRead();
      const events = await runPromise;

      expect(
        tracker.getActiveCalls().filter((c) => c.status === "active"),
      ).toHaveLength(0);
      expect(
        events
          .filter(
            (e): e is Extract<AgentEvent, { type: "tool_result" }> =>
              e.type === "tool_result",
          )
          .map((e) => e.toolName),
      ).toEqual(["read_file", "write_file"]);
    });

    it("resolves queued interjection attachments asynchronously before the next provider request", async () => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-engine-"));
      await fs.writeFile(path.join(cwd, "note.md"), "# Note\nhello", "utf-8");

      const requests: StreamRequest[] = [];
      let callCount = 0;
      const provider = makeMockProvider();
      provider.stream = async function* (request: StreamRequest) {
        requests.push(request);
        callCount += 1;
        if (callCount === 1) {
          yield {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id: "call_read",
                name: "read_file",
                input: { path: "src/a.ts" },
              },
            ],
          };
          yield { type: "usage", inputTokens: 20, outputTokens: 5 };
          yield { type: "done" };
          return;
        }
        yield* makeProviderStream({ text: "done" });
      };

      const session = await AgentSession.create({
        mode: "code",
        config: testConfig,
        cwd,
      });
      session.addUserMessage("read then follow up");
      const engine = new AgentEngine(makeRegistry(provider));
      const toolCtx: ToolDispatchContext = {
        approvalManager: {} as ToolDispatchContext["approvalManager"],
        approvalPanel: {} as ToolDispatchContext["approvalPanel"],
        sessionId: "seed-session",
        extensionUri: {} as ToolDispatchContext["extensionUri"],
      };
      setEngineToolContext(engine, toolCtx, async () => {
        session.setPendingInterjection(
          "follow up",
          "queue-1",
          undefined,
          undefined,
          false,
          undefined,
          ["note.md"],
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
        };
      });

      await collectEvents(engine.run(session));

      expect(requests).toHaveLength(2);
      expect(requests[1].messages.at(-1)).toEqual({
        role: "user",
        content:
          '<file path="note.md">\n```md\n# Note\nhello\n```\n</file>\n\nfollow up',
      });
    });

    it("does not emit completed tool events after abort", async () => {
      const provider = makeMockProvider();
      provider.stream = async function* () {
        yield {
          type: "content_blocks",
          blocks: [
            {
              type: "tool_use",
              id: "call_read",
              name: "read_file",
              input: { path: "src/a.ts" },
            },
          ],
        };
        yield { type: "usage", inputTokens: 20, outputTokens: 5 };
        yield { type: "done" };
      };

      const session = await makeSession();
      session.addUserMessage("read then stop");
      const engine = new AgentEngine(makeRegistry(provider));
      let releaseRead!: () => void;
      const executeTool = vi.fn(
        () =>
          new Promise<{ content: Array<{ type: "text"; text: string }> }>(
            (resolve) => {
              releaseRead = () => {
                session.abort();
                resolve({
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ ok: true, read: true }),
                    },
                  ],
                });
              };
            },
          ),
      );
      setEngineToolContext(
        engine,
        {
          approvalManager: {} as ToolDispatchContext["approvalManager"],
          approvalPanel: {} as ToolDispatchContext["approvalPanel"],
          sessionId: "seed-session",
          extensionUri: {} as ToolDispatchContext["extensionUri"],
        },
        executeTool,
      );

      const runPromise = collectEvents(engine.run(session));
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseRead();
      const events = await runPromise;

      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(events.map((event) => event.type)).not.toContain("tool_result");
      expect(events.map((event) => event.type)).not.toContain("done");
    });

    it("unblocks in-flight tracked tools when a run is aborted", async () => {
      const provider = makeMockProvider();
      provider.stream = async function* () {
        yield {
          type: "content_blocks",
          blocks: [
            {
              type: "tool_use",
              id: "call_read",
              name: "read_file",
              input: { path: "src/a.ts" },
            },
          ],
        };
        yield { type: "usage", inputTokens: 20, outputTokens: 5 };
        yield { type: "done" };
      };

      const session = await makeSession();
      session.addUserMessage("read then stop");
      const engine = new AgentEngine(makeRegistry(provider));
      const tracker = new AgentToolCallTracker();
      let toolSignal: AbortSignal | undefined;
      let toolStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        toolStarted = resolve;
      });
      const executeTool = vi.fn(
        (request: AgentToolExecutionRequest) =>
          new Promise<{ content: Array<{ type: "text"; text: string }> }>(
            () => {
              toolSignal = request.context.toolAbortSignal;
              toolStarted();
            },
          ),
      );
      setEngineToolContext(
        engine,
        {
          approvalManager: {} as ToolDispatchContext["approvalManager"],
          approvalPanel: {} as ToolDispatchContext["approvalPanel"],
          sessionId: "seed-session",
          extensionUri: {} as ToolDispatchContext["extensionUri"],
          toolCallTracker: tracker,
        },
        executeTool,
      );

      const runPromise = collectEvents(engine.run(session));
      await started;
      session.abort();

      const events = await Promise.race([
        runPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("run did not abort")), 500),
        ),
      ]);

      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(toolSignal?.aborted).toBe(true);
      expect(events.map((event) => event.type)).not.toContain("tool_result");
      expect(events.map((event) => event.type)).not.toContain("done");
      expect(
        tracker.getActiveCalls().filter((call) => call.status === "active"),
      ).toHaveLength(0);
    });

    it("unblocks in-flight tools on abort without a tracker", async () => {
      const provider = makeMockProvider();
      provider.stream = async function* () {
        yield {
          type: "content_blocks",
          blocks: [
            {
              type: "tool_use",
              id: "call_read",
              name: "read_file",
              input: { path: "src/a.ts" },
            },
          ],
        };
        yield { type: "usage", inputTokens: 20, outputTokens: 5 };
        yield { type: "done" };
      };

      const session = await makeSession();
      session.addUserMessage("read then stop");
      const engine = new AgentEngine(makeRegistry(provider));
      let toolSignal: AbortSignal | undefined;
      let toolStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        toolStarted = resolve;
      });
      const executeTool = vi.fn(
        (request: AgentToolExecutionRequest) =>
          new Promise<{ content: Array<{ type: "text"; text: string }> }>(
            () => {
              toolSignal = request.context.toolAbortSignal;
              toolStarted();
            },
          ),
      );
      setEngineToolContext(
        engine,
        {
          approvalManager: {} as ToolDispatchContext["approvalManager"],
          approvalPanel: {} as ToolDispatchContext["approvalPanel"],
          sessionId: "seed-session",
          extensionUri: {} as ToolDispatchContext["extensionUri"],
        },
        executeTool,
      );

      const runPromise = collectEvents(engine.run(session));
      await started;
      session.abort();

      const events = await Promise.race([
        runPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("run did not abort")), 500),
        ),
      ]);

      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(toolSignal?.aborted).toBe(true);
      expect(events.map((event) => event.type)).not.toContain("tool_result");
      expect(events.map((event) => event.type)).not.toContain("done");
    });

    it("clears pre-registered tracker calls when a run is aborted", async () => {
      const provider = makeMockProvider();
      provider.stream = async function* () {
        yield {
          type: "content_blocks",
          blocks: [
            {
              type: "tool_use",
              id: "call_read",
              name: "read_file",
              input: { path: "src/a.ts" },
            },
            {
              type: "tool_use",
              id: "call_write",
              name: "write_file",
              input: { path: "src/x.ts", content: "x" },
            },
          ],
        };
        yield { type: "usage", inputTokens: 20, outputTokens: 5 };
        yield { type: "done" };
      };

      const session = await makeSession();
      session.addUserMessage("read then stop");
      const engine = new AgentEngine(makeRegistry(provider));
      const tracker = new AgentToolCallTracker();
      const toolCtx: ToolDispatchContext = {
        approvalManager: {} as ToolDispatchContext["approvalManager"],
        approvalPanel: {} as ToolDispatchContext["approvalPanel"],
        sessionId: "seed-session",
        extensionUri: {} as ToolDispatchContext["extensionUri"],
        toolCallTracker: tracker,
      };
      const executeTool = vi.fn(async (request: AgentToolExecutionRequest) => {
        if (request.name === "read_file") {
          session.abort();
          return {
            content: [
              { type: "text", text: JSON.stringify({ ok: true, read: true }) },
            ],
          };
        }
        if (request.name === "write_file") {
          throw new Error("write_file should not execute after abort");
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
        };
      });
      setEngineToolContext(engine, toolCtx, executeTool);

      const events = await collectEvents(engine.run(session));
      tracker.clearAgentCalls(session.id);

      expect(
        tracker.getActiveCalls().filter((c) => c.status === "active"),
      ).toHaveLength(0);
      expect(
        events
          .filter(
            (e): e is Extract<AgentEvent, { type: "tool_result" }> =>
              e.type === "tool_result",
          )
          .map((e) => e.toolName),
      ).toEqual([]);
      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(executeTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: "read_file" }),
      );
    });

    it("stops turn and skips trailing tools after set_task_status", async () => {
      const provider = makeMockProvider();
      provider.stream = async function* () {
        yield {
          type: "content_blocks",
          blocks: [
            { type: "text", text: "Ready to implement." },
            {
              type: "tool_use",
              id: "call_final",
              name: "set_task_status",
              input: {
                status: "waiting_for_user",
                continueLabel: "Implement this",
                continuePrompt: "Please implement this plan.",
              },
            },
            {
              type: "tool_use",
              id: "call_write",
              name: "write_file",
              input: { path: "src/x.ts", content: "x" },
            },
          ],
        };
        yield { type: "usage", inputTokens: 20, outputTokens: 5 };
        yield { type: "done" };
      };

      const session = await makeSession();
      session.addUserMessage("plan");
      const engine = new AgentEngine(makeRegistry(provider));
      const writeSpy = vi
        .fn()
        .mockResolvedValue({ content: [{ type: "text", text: "write ok" }] });
      const toolCtx: ToolDispatchContext = {
        approvalManager: {} as ToolDispatchContext["approvalManager"],
        approvalPanel: {} as ToolDispatchContext["approvalPanel"],
        sessionId: "seed-session",
        extensionUri: {} as ToolDispatchContext["extensionUri"],
      };
      setEngineToolContext(
        engine,
        toolCtx,
        async (request: AgentToolExecutionRequest) => {
          if (request.name === "set_task_status") {
            request.context.onFinalStatus?.({
              status: "waiting_for_user",
              source: "tool",
              continueAction: {
                label: "Implement this",
                prompt: "Please implement this plan.",
              },
            });
            return {
              content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
            };
          }
          if (request.name === "write_file") {
            return await writeSpy(request.name, request.input);
          }
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
          };
        },
      );

      const events = await collectEvents(engine.run(session));

      expect(writeSpy).not.toHaveBeenCalled();
      const markerEvent = events.find((e) => e.type === "final_marker");
      expect(markerEvent).toMatchObject({
        type: "final_marker",
        marker: {
          status: "waiting_for_user",
          source: "tool",
          continueAction: {
            label: "Implement this",
            prompt: "Please implement this plan.",
          },
        },
      });
      const toolResults = events.filter(
        (e): e is Extract<AgentEvent, { type: "tool_result" }> =>
          e.type === "tool_result",
      );
      expect(toolResults.map((r) => r.toolName)).toEqual([
        "set_task_status",
        "write_file",
      ]);
      const skippedText = toolResults[1].result
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n");
      expect(skippedText).toContain('"skipped_by":"set_task_status"');
      expect(
        session.getAllMessages().at(-2)?.uiHint?.finalMarker,
      ).toMatchObject({
        status: "waiting_for_user",
        source: "tool",
      });
    });

    it("emits completed todos when set_task_status requests todo completion", async () => {
      const provider = makeMockProvider();
      provider.stream = async function* () {
        yield {
          type: "content_blocks",
          blocks: [
            {
              type: "tool_use",
              id: "call_todos",
              name: "todo_write",
              input: {
                todos: [
                  {
                    id: "1",
                    content: "Implement change",
                    activeForm: "Implementing change",
                    status: "in_progress",
                    children: [
                      {
                        id: "1a",
                        content: "Update docs",
                        activeForm: "Updating docs",
                        status: "pending",
                      },
                    ],
                  },
                ],
              },
            },
            {
              type: "tool_use",
              id: "call_final",
              name: "set_task_status",
              input: {
                status: "completed",
                summary: "Done",
                completeTodos: true,
              },
            },
          ],
        };
        yield { type: "usage", inputTokens: 20, outputTokens: 5 };
        yield { type: "done" };
      };

      const session = await makeSession();
      session.addUserMessage("finish");
      const engine = new AgentEngine(makeRegistry(provider));
      setEngineToolContext(engine, {
        approvalManager: {} as ToolDispatchContext["approvalManager"],
        approvalPanel: {} as ToolDispatchContext["approvalPanel"],
        sessionId: "seed-session",
        extensionUri: {} as ToolDispatchContext["extensionUri"],
      });

      const events = await collectEvents(engine.run(session));
      const todoUpdates = events.filter(
        (event): event is Extract<AgentEvent, { type: "todo_update" }> =>
          event.type === "todo_update",
      );

      expect(todoUpdates).toHaveLength(2);
      expect(todoUpdates[0].todos[0]).toMatchObject({
        id: "1",
        status: "in_progress",
        children: [expect.objectContaining({ id: "1a", status: "pending" })],
      });
      expect(todoUpdates[1].todos[0]).toMatchObject({
        id: "1",
        status: "completed",
        children: [expect.objectContaining({ id: "1a", status: "completed" })],
      });
      expect(
        events.find((event) => event.type === "final_marker"),
      ).toMatchObject({
        type: "final_marker",
        marker: { status: "completed", source: "tool", summary: "Done" },
      });
    });

    it("can complete todos created in an earlier provider roundtrip", async () => {
      const provider = makeMockProvider();
      provider.stream = async function* () {
        yield {
          type: "content_blocks",
          blocks: [
            {
              type: "tool_use",
              id: "call_final",
              name: "set_task_status",
              input: {
                status: "completed",
                summary: "Done",
                completeTodos: true,
              },
            },
          ],
        };
        yield { type: "usage", inputTokens: 20, outputTokens: 5 };
        yield { type: "done" };
      };

      const session = await makeSession();
      session.addUserMessage("work");
      session.appendAssistantTurn([
        {
          type: "tool_use",
          id: "call_todos",
          name: "todo_write",
          input: {
            todos: [
              {
                id: "1",
                content: "Implement change",
                activeForm: "Implementing change",
                status: "in_progress",
              },
            ],
          },
        },
      ]);
      session.appendToolResults([
        {
          type: "tool_result",
          tool_use_id: "call_todos",
          content: "Updated: 0/1 complete, 1 in progress, 0 pending",
        },
      ]);
      session.appendAssistantTurn([
        {
          type: "tool_use",
          id: "call_prior_final",
          name: "set_task_status",
          input: {
            status: "completed",
            summary: "Done previously",
            completeTodos: true,
          },
        },
      ]);
      session.appendToolResults([
        {
          type: "tool_result",
          tool_use_id: "call_prior_final",
          content: JSON.stringify({ ok: true, completedTodos: 1 }),
        },
      ]);
      session.addUserMessage("finish");
      const engine = new AgentEngine(makeRegistry(provider));
      setEngineToolContext(engine, {
        approvalManager: {} as ToolDispatchContext["approvalManager"],
        approvalPanel: {} as ToolDispatchContext["approvalPanel"],
        sessionId: "seed-session",
        extensionUri: {} as ToolDispatchContext["extensionUri"],
      });

      const events = await collectEvents(engine.run(session));
      const todoUpdate = events.find(
        (event): event is Extract<AgentEvent, { type: "todo_update" }> =>
          event.type === "todo_update",
      );

      expect(todoUpdate?.todos[0]).toMatchObject({
        id: "1",
        status: "completed",
      });
    });

    it("does not stop turn when switch_mode is rejected", async () => {
      let callCount = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        callCount += 1;
        if (callCount === 1) {
          yield {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id: "call_switch",
                name: "switch_mode",
                input: { mode: "architect" },
              },
            ],
          };
          yield { type: "usage", inputTokens: 20, outputTokens: 5 };
          yield { type: "done" };
          return;
        }

        yield* makeProviderStream({ text: "continued after rejection" });
      };

      const session = await makeSession();
      session.addUserMessage("try switch");
      const engine = new AgentEngine(makeRegistry(provider));

      const toolCtx: ToolDispatchContext = {
        approvalManager: {} as ToolDispatchContext["approvalManager"],
        approvalPanel: {} as ToolDispatchContext["approvalPanel"],
        sessionId: "seed-session",
        extensionUri: {} as ToolDispatchContext["extensionUri"],
        onModeSwitch: vi.fn().mockResolvedValue({
          approved: false,
          mode: "architect",
        }),
      };
      setEngineToolContext(engine, toolCtx);

      const events = await collectEvents(engine.run(session));

      expect(callCount).toBe(2);
      expect(events.at(-1)).toMatchObject({ type: "done" });
      const results = events.filter(
        (e): e is Extract<AgentEvent, { type: "tool_result" }> =>
          e.type === "tool_result",
      );
      expect(results).toHaveLength(1);
      const rejectedText = results[0].result
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n");
      expect(JSON.parse(rejectedText)).toMatchObject({
        status: "rejected_by_user",
      });
      const lastMessage = session.getAllMessages().at(-1);
      expect(lastMessage).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "continued after rejection" }],
      });
    });
  });

  describe("tool assembly", () => {
    it("omits deferred MCP tools from provider requests while retaining discovery/call meta-tools", async () => {
      const streamCalls: StreamRequest[] = [];
      const provider = makeMockProvider();
      provider.stream = async function* (request: StreamRequest) {
        streamCalls.push(request);
        yield { type: "text_delta", text: "ok" };
        yield {
          type: "content_blocks",
          blocks: [{ type: "text", text: "ok" }],
        };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "done" };
      };

      const session = await makeSession();
      session.addUserMessage("hello");
      const liveMcpTools = [
        {
          name: "ddg-search__search",
          description: "Search the web",
          input_schema: { type: "object", properties: {} },
        },
        {
          name: "linear__list_issues",
          description: "List Linear issues",
          input_schema: { type: "object", properties: {} },
        },
      ];

      const engine = new AgentEngine(makeRegistry(provider));
      setEngineToolContext(engine, {
        ...({} as ToolDispatchContext),
        approvalManager: {} as any,
        approvalPanel: {} as any,
        sessionId: "agent",
        extensionUri: {} as any,
        mcpHub: {
          getToolDefs: () => liveMcpTools,
          getServerConfig: (serverName: string) =>
            serverName === "linear"
              ? { toolDisclosure: "deferred" }
              : undefined,
        } as any,
      });

      await collectEvents(engine.run(session));

      expect(streamCalls).toHaveLength(1);
      const names = streamCalls[0]?.tools?.map((tool) => tool.name) ?? [];
      expect(names).toContain("ddg-search__search");
      expect(names).not.toContain("linear__list_issues");
      expect(names).toContain("find_mcp_tools");
      expect(names).toContain("call_mcp_tool");
      expect(session.contextBreakdown.tools?.mcp.servers).toEqual([
        expect.objectContaining({
          serverName: "ddg-search",
          toolCount: 1,
        }),
      ]);
      expect(session.contextBreakdown.tools?.mcp.totalToolCount).toBe(1);
      expect(session.mcpToolDisclosure?.deferredTools).toEqual([
        expect.objectContaining({ name: "linear__list_issues" }),
      ]);
    });

    it("rebuilds cached provider tools when same-name tool definitions change", async () => {
      const streamCalls: StreamRequest[] = [];
      let streamCount = 0;
      const provider = makeMockProvider();
      provider.stream = async function* (request: StreamRequest) {
        streamCalls.push(request);
        streamCount += 1;
        if (streamCount === 1) {
          yield {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "alpha",
                input: {},
              },
            ],
          };
          yield { type: "usage", inputTokens: 10, outputTokens: 5 };
          yield { type: "done" };
          return;
        }

        yield { type: "text_delta", text: "ok" };
        yield {
          type: "content_blocks",
          blocks: [{ type: "text", text: "ok" }],
        };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "done" };
      };

      const firstSchema = { type: "object" as const, properties: {} };
      const secondSchema = {
        type: "object" as const,
        properties: { query: { type: "string" } },
      };
      const toolDefs: ToolDefinition[][] = [
        [
          {
            name: "alpha",
            description: "first definition",
            input_schema: firstSchema,
          },
        ],
        [
          {
            name: "alpha",
            description: "second definition",
            input_schema: secondSchema,
          },
        ],
      ];
      let listCalls = 0;

      const session = await makeSession();
      session.addUserMessage("hello");
      const engine = new AgentEngine(makeRegistry(provider));
      engine.setToolRuntime({
        listTools() {
          return toolDefs[Math.min(listCalls++, toolDefs.length - 1)];
        },
        isParallelSafe() {
          return true;
        },
        async executeTool() {
          return { content: [{ type: "text", text: "tool ok" }] };
        },
      } as any);

      await collectEvents(engine.run(session));

      expect(streamCalls).toHaveLength(2);
      const firstAlpha = streamCalls[0].tools?.find(
        (tool) => tool.name === "alpha",
      );
      const secondAlpha = streamCalls[1].tools?.find(
        (tool) => tool.name === "alpha",
      );
      expect(firstAlpha?.description).toBe("first definition");
      expect(firstAlpha?.input_schema).toBe(firstSchema);
      expect(secondAlpha?.description).toBe("second definition");
      expect(secondAlpha?.input_schema).toBe(secondSchema);
    });

    it("reuses cached provider tools when definitions are structurally unchanged", async () => {
      const streamCalls: StreamRequest[] = [];
      let streamCount = 0;
      const provider = makeMockProvider();
      provider.stream = async function* (request: StreamRequest) {
        streamCalls.push(request);
        streamCount += 1;
        if (streamCount === 1) {
          yield {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "alpha",
                input: {},
              },
            ],
          };
          yield { type: "usage", inputTokens: 10, outputTokens: 5 };
          yield { type: "done" };
          return;
        }

        yield { type: "text_delta", text: "ok" };
        yield {
          type: "content_blocks",
          blocks: [{ type: "text", text: "ok" }],
        };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "done" };
      };

      let listCalls = 0;
      const session = await makeSession();
      session.addUserMessage("hello");
      const engine = new AgentEngine(makeRegistry(provider));
      engine.setToolRuntime({
        listTools() {
          listCalls += 1;
          return [
            {
              name: "alpha",
              description: "same definition",
              input_schema: {
                properties: { query: { type: "string" } },
                type: "object",
              },
            },
          ];
        },
        isParallelSafe() {
          return true;
        },
        async executeTool() {
          return { content: [{ type: "text", text: "tool ok" }] };
        },
      } as any);

      await collectEvents(engine.run(session));

      expect(listCalls).toBe(2);
      expect(streamCalls).toHaveLength(2);
      const firstAlpha = streamCalls[0].tools?.find(
        (tool) => tool.name === "alpha",
      );
      const secondAlpha = streamCalls[1].tools?.find(
        (tool) => tool.name === "alpha",
      );
      expect(firstAlpha).toBeDefined();
      expect(secondAlpha).toBe(firstAlpha);
    });

    it("recomputes MCP disclosure at request time when tools connect after session creation", async () => {
      const streamCalls: StreamRequest[] = [];
      const provider = makeMockProvider();
      provider.stream = async function* (request: StreamRequest) {
        streamCalls.push(request);
        yield { type: "text_delta", text: "ok" };
        yield {
          type: "content_blocks",
          blocks: [{ type: "text", text: "ok" }],
        };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "done" };
      };

      const session = await makeSession();
      session.addUserMessage("hello");
      expect(session.mcpToolDisclosure).toBeUndefined();

      const engine = new AgentEngine(makeRegistry(provider));
      setEngineToolContext(engine, {
        ...({} as ToolDispatchContext),
        approvalManager: {} as any,
        approvalPanel: {} as any,
        sessionId: "agent",
        extensionUri: {} as any,
        mcpHub: {
          getToolDefs: () => [
            {
              name: "linear__list_issues",
              description: "List Linear issues",
              input_schema: { type: "object", properties: {} },
            },
          ],
          getServerConfig: (serverName: string) =>
            serverName === "linear"
              ? { toolDisclosure: "deferred" }
              : undefined,
        } as any,
      });

      await collectEvents(engine.run(session));

      const names = streamCalls[0]?.tools?.map((tool) => tool.name) ?? [];
      expect(names).not.toContain("linear__list_issues");
      expect(names).toContain("find_mcp_tools");
      expect(names).toContain("call_mcp_tool");
      expect(session.mcpToolDisclosure?.deferredTools).toEqual([
        expect.objectContaining({ name: "linear__list_issues" }),
      ]);
      expect(session.contextBreakdown.tools?.mcp.totalToolCount).toBe(0);
    });
  });

  describe("token accounting", () => {
    it("reports api_request inputTokens as uncached + cache_read + cache_creation", async () => {
      const provider = makeMockProvider(
        makeProviderStream({
          inputTokens: 50,
          outputTokens: 25,
          cacheReadTokens: 9000,
          cacheCreationTokens: 1000,
        }),
      );

      const session = await makeSession();
      session.addUserMessage("hello");
      const engine = new AgentEngine(makeRegistry(provider));

      const events = await collectEvents(engine.run(session));
      const apiRequest = events.find((e) => e.type === "api_request");
      expect(apiRequest).toBeDefined();
      if (!apiRequest || apiRequest.type !== "api_request") return;

      expect(apiRequest.inputTokens).toBe(10_050);
      expect(apiRequest.uncachedInputTokens).toBe(50);
      expect(apiRequest.cacheReadTokens).toBe(9000);
      expect(apiRequest.cacheCreationTokens).toBe(1000);
      expect(apiRequest.reasoningEffort).toBe("none");
      expect(session.lastInputTokens).toBe(10_050);
      expect(session.totalInputTokens).toBe(50);
      expect(session.totalCacheReadTokens).toBe(9000);
      expect(session.totalCacheCreationTokens).toBe(1000);
      expect(apiRequest.contextBreakdown?.prompt).toMatchObject({
        totalChars: 18,
        estimatedTokens: 5,
      });
    });

    it("emits gated hot-path timing logs when a logger is configured", async () => {
      const provider = makeMockProvider();
      const session = await makeSession();
      session.addUserMessage("hello");
      const logs: string[] = [];
      const engine = new AgentEngine(makeRegistry(provider), (msg) => {
        logs.push(msg);
      });

      await collectEvents(engine.run(session));

      expect(logs).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^\[perf\] tool setup \d+ms tools=0 mcp=0$/),
          expect.stringMatching(/^\[perf\] getMessages \d+ms messages=1$/),
          expect.stringMatching(
            /^\[perf\] message assembly \d+ms apiMessages=1$/,
          ),
        ]),
      );
    });

    it("stores provider response id from usage events for future stateful codex turns", async () => {
      const provider = makeMockProvider([
        { type: "text_delta", text: "ok" },
        {
          type: "content_blocks",
          blocks: [{ type: "text", text: "ok" }],
        },
        {
          type: "usage",
          inputTokens: 10,
          outputTokens: 5,
          providerResponseId: "resp_abc",
        },
        { type: "done" },
      ]);

      const session = await makeSession();
      session.addUserMessage("hello");
      const engine = new AgentEngine(makeRegistry(provider));

      const events = await collectEvents(engine.run(session));
      const apiRequest = events.find((e) => e.type === "api_request");
      expect(session.providerResponseId).toBe("resp_abc");
      expect(apiRequest).toMatchObject({
        type: "api_request",
        providerResponseId: "resp_abc",
        usedPreviousResponseId: false,
        previousResponseIdFallback: false,
      });
    });

    it("surfaces model fallback and records the effective model", async () => {
      const provider = makeMockProvider([
        {
          type: "model_fallback",
          requestedModel: "gpt-5.6-luna",
          effectiveModel: "gpt-5.4-mini",
        },
        ...makeProviderStream(),
      ]);
      provider.listModels = () => [
        {
          id: "gpt-5.6-luna",
          displayName: "GPT-5.6 Luna",
          provider: provider.id,
          capabilities: TEST_CAPABILITIES,
        },
        {
          id: "gpt-5.4-mini",
          displayName: "GPT-5.4 Mini",
          provider: provider.id,
          capabilities: TEST_CAPABILITIES,
        },
      ];
      const session = await makeSession();
      session.model = "gpt-5.6-luna";
      session.addUserMessage("hello");
      const engine = new AgentEngine(makeRegistry(provider));

      const events = await collectEvents(engine.run(session));

      expect(session.model).toBe("gpt-5.4-mini");
      expect(events).toContainEqual({
        type: "warning",
        message:
          "gpt-5.6-luna is unavailable for this account. Switched to gpt-5.4-mini.",
        modelFallback: {
          requestedModel: "gpt-5.6-luna",
          effectiveModel: "gpt-5.4-mini",
        },
      });
      expect(
        events.find((event) => event.type === "api_request"),
      ).toMatchObject({
        model: "gpt-5.4-mini",
      });
    });

    it("retries codex once without previous_response_id when the remote state cannot be resolved", async () => {
      const streamCalls: StreamRequest[] = [];
      const provider: ModelProvider = {
        id: "codex",
        displayName: "Codex",
        condenseModel: "gpt-5.4",
        async isAuthenticated() {
          return true;
        },
        getCapabilities() {
          return TEST_CAPABILITIES;
        },
        listModels(): ModelInfo[] {
          return [
            {
              id: TEST_MODEL,
              displayName: "Codex",
              provider: "codex",
              capabilities: TEST_CAPABILITIES,
            },
          ];
        },
        async *stream(request: StreamRequest) {
          streamCalls.push(request);
          if (streamCalls.length === 1) {
            throw new Error(
              "previous_response_id could not be resolved: response not found",
            );
          }
          yield { type: "text_delta", text: "ok" };
          yield {
            type: "content_blocks",
            blocks: [{ type: "text", text: "ok" }],
          };
          yield {
            type: "usage",
            inputTokens: 20,
            outputTokens: 5,
            providerResponseId: "resp_new",
          };
          yield { type: "done" };
        },
        async complete() {
          return { text: "ok" };
        },
      };

      const session = await makeSession({
        ...testConfig,
        model: TEST_MODEL,
        codexStatefulResponses: true,
      });
      session.providerId = "codex";
      session.addUserMessage("hello");
      session.setProviderResponseId("resp_prev");
      const engine = new AgentEngine(makeRegistry(provider));

      const events = await collectEvents(engine.run(session));
      const warnings = events.filter((e) => e.type === "warning");
      const apiRequest = events.find((e) => e.type === "api_request");

      expect(streamCalls).toHaveLength(2);
      expect(streamCalls[0]?.state).toEqual({
        previousResponseId: "resp_prev",
        store: false,
      });
      expect(streamCalls[1]?.state).toEqual({
        previousResponseId: undefined,
        store: false,
      });
      expect(warnings).toContainEqual(
        expect.objectContaining({
          type: "warning",
          message:
            "Codex could not resume the prior response state — retrying this turn with full local replay.",
        }),
      );
      expect(apiRequest).toMatchObject({
        type: "api_request",
        usedPreviousResponseId: false,
        previousResponseIdFallback: true,
        promptCacheKey: expect.stringContaining("codex:"),
        promptCacheRetention: "24h",
        storeResponseState: false,
        providerResponseId: "resp_new",
      });
      expect(session.providerResponseId).toBe("resp_new");
    });

    it("serializes pasted image turns with text before image blocks", async () => {
      const streamCalls: StreamRequest[] = [];
      const provider: ModelProvider = {
        id: "codex",
        displayName: "Codex",
        condenseModel: "gpt-5.4",
        async isAuthenticated() {
          return true;
        },
        getCapabilities() {
          return TEST_CAPABILITIES;
        },
        listModels(): ModelInfo[] {
          return [
            {
              id: TEST_MODEL,
              displayName: "Codex",
              provider: "codex",
              capabilities: TEST_CAPABILITIES,
            },
          ];
        },
        async *stream(request: StreamRequest) {
          streamCalls.push(request);
          yield { type: "text_delta", text: "ok" };
          yield {
            type: "content_blocks",
            blocks: [{ type: "text", text: "ok" }],
          };
          yield {
            type: "usage",
            inputTokens: 20,
            outputTokens: 5,
            providerResponseId: "resp_media",
          };
          yield { type: "done" };
        },
        async complete() {
          return { text: "ok" };
        },
      };

      const session = await makeSession({
        ...testConfig,
        model: TEST_MODEL,
      });
      session.providerId = "codex";
      session.addUserMessage("what's in this image?", {
        images: [
          { name: "paste.png", mimeType: "image/png", base64: "abc123" },
        ],
      });
      const engine = new AgentEngine(makeRegistry(provider));

      await collectEvents(engine.run(session));

      expect(streamCalls).toHaveLength(1);
      expect(streamCalls[0]?.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "what's in this image?" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "abc123",
              },
            },
          ],
        },
      ]);
    });

    it("injects image media even when prior runtime-error messages shift indices", async () => {
      const streamCalls: StreamRequest[] = [];
      const provider: ModelProvider = {
        id: "codex",
        displayName: "Codex",
        condenseModel: "gpt-5.4",
        async isAuthenticated() {
          return true;
        },
        getCapabilities() {
          return TEST_CAPABILITIES;
        },
        listModels(): ModelInfo[] {
          return [
            {
              id: TEST_MODEL,
              displayName: "Codex",
              provider: "codex",
              capabilities: TEST_CAPABILITIES,
            },
          ];
        },
        async *stream(request: StreamRequest) {
          streamCalls.push(request);
          yield { type: "text_delta", text: "ok" };
          yield {
            type: "content_blocks",
            blocks: [{ type: "text", text: "ok" }],
          };
          yield {
            type: "usage",
            inputTokens: 20,
            outputTokens: 5,
            providerResponseId: "resp_media2",
          };
          yield { type: "done" };
        },
        async complete() {
          return { text: "ok" };
        },
      };

      const session = await makeSession({
        ...testConfig,
        model: TEST_MODEL,
      });
      session.providerId = "codex";

      // Build a session with prior history: user → assistant → runtime-error → user+image
      // The runtime-error message gets filtered by getMessages(), shifting indices.
      session.addUserMessage("hello");
      session.appendAssistantTurn([{ type: "text", text: "hi there" }]);
      // Simulate a runtime error that got appended (filtered out by getMessages)
      session.appendRuntimeError({
        message: "previous error",
        retryable: true,
      });
      // Now add the user message with an image
      session.addUserMessage("what's in this image?", {
        images: [
          { name: "paste.png", mimeType: "image/png", base64: "abc123" },
        ],
      });

      const engine = new AgentEngine(makeRegistry(provider));
      await collectEvents(engine.run(session));

      expect(streamCalls).toHaveLength(1);
      // The image should be present in the last user message
      const lastMsg =
        streamCalls[0]?.messages[streamCalls[0].messages.length - 1];
      expect(lastMsg).toEqual({
        role: "user",
        content: [
          { type: "text", text: "what's in this image?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "abc123",
            },
          },
        ],
      });
    });

    it("re-sends pasted image media on subsequent API requests", async () => {
      const streamCalls: StreamRequest[] = [];
      let callCount = 0;
      const provider: ModelProvider = {
        id: "codex",
        displayName: "Codex",
        condenseModel: "gpt-5.4",
        async isAuthenticated() {
          return true;
        },
        getCapabilities() {
          return TEST_CAPABILITIES;
        },
        listModels(): ModelInfo[] {
          return [
            {
              id: TEST_MODEL,
              displayName: "Codex",
              provider: "codex",
              capabilities: TEST_CAPABILITIES,
            },
          ];
        },
        async *stream(request: StreamRequest) {
          streamCalls.push(request);
          callCount += 1;
          if (callCount === 1) {
            yield {
              type: "content_blocks",
              blocks: [
                {
                  type: "tool_use",
                  id: "call_read",
                  name: "read_file",
                  input: { path: "src/a.ts" },
                },
              ],
            };
          } else {
            yield {
              type: "content_blocks",
              blocks: [{ type: "text", text: "done" }],
            };
          }
          yield { type: "usage", inputTokens: 20, outputTokens: 5 };
          yield { type: "done" };
        },
        async complete() {
          return { text: "ok" };
        },
      };

      const session = await makeSession({
        ...testConfig,
        model: TEST_MODEL,
      });
      session.providerId = "codex";
      session.addUserMessage("what's in this image?", {
        images: [
          { name: "paste.png", mimeType: "image/png", base64: "abc123" },
        ],
      });

      const engine = new AgentEngine(makeRegistry(provider));
      const toolCtx: ToolDispatchContext = {
        approvalManager: {} as ToolDispatchContext["approvalManager"],
        approvalPanel: {} as ToolDispatchContext["approvalPanel"],
        sessionId: "seed-session",
        extensionUri: {} as ToolDispatchContext["extensionUri"],
      };
      setEngineToolContext(engine, toolCtx, async () => ({
        content: [{ type: "text", text: "file contents" }],
      }));

      await collectEvents(engine.run(session));

      const expectedImageMessage = {
        role: "user",
        content: [
          { type: "text", text: "what's in this image?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "abc123",
            },
          },
        ],
      };
      expect(streamCalls).toHaveLength(2);
      expect(streamCalls[0]?.messages[0]).toEqual(expectedImageMessage);
      // Regression: the API is stateless, so the image must be re-sent after
      // the tool round-trip or the model loses access to it mid-conversation.
      expect(streamCalls[1]?.messages[0]).toEqual(expectedImageMessage);
    });

    it("does not count tool-result image base64 as raw text for auto-condense estimates", async () => {
      let callCount = 0;
      let estimateBeforeSecondRequest = 0;
      let session: AgentSession;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        callCount += 1;
        if (callCount === 1) {
          yield {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id: "call_image",
                name: "call_mcp_tool",
                input: { server: "image", tool: "snapshot", input: {} },
              },
            ],
          };
        } else {
          estimateBeforeSecondRequest = session.estimatedAccumulatedTokens;
          yield {
            type: "content_blocks",
            blocks: [{ type: "text", text: "done" }],
          };
        }
        yield { type: "usage", inputTokens: 20, outputTokens: 5 };
        yield { type: "done" };
      };

      session = await makeSession();
      session.addUserMessage("inspect this image");
      const engine = new AgentEngine(makeRegistry(provider));
      const condenseSpy = vi.spyOn(engine, "condenseSession");
      setEngineToolContext(engine, {
        approvalManager: {} as ToolDispatchContext["approvalManager"],
        approvalPanel: {} as ToolDispatchContext["approvalPanel"],
        sessionId: "seed-session",
        extensionUri: {} as ToolDispatchContext["extensionUri"],
        mcpHub: {
          getToolDefs() {
            return [];
          },
          getServerConfig() {
            return { toolPolicy: "allow" };
          },
          callTool: vi.fn().mockResolvedValue({
            content: [
              {
                type: "image",
                data: "a".repeat(900_000),
                mimeType: "image/png",
              },
            ],
          }),
        } as unknown as ToolDispatchContext["mcpHub"],
      });

      await collectEvents(engine.run(session));

      expect(callCount).toBe(2);
      expect(condenseSpy).not.toHaveBeenCalled();
      expect(estimateBeforeSecondRequest).toBeGreaterThan(0);
      expect(estimateBeforeSecondRequest).toBeLessThan(1_000);
    });

    it("auto-retries Codex processing errors and still marks exhausted failures retryable", async () => {
      let attempts = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        attempts += 1;
        yield* [];
        throw new Error(
          "Codex API error: An error occurred while processing your request. Please include the request ID req-123 in your message.",
        );
      };

      const timerSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((fn: TimerHandler) => {
          if (typeof fn === "function") fn();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        });

      try {
        const session = await makeSession();
        session.addUserMessage("hello");
        const engine = new AgentEngine(makeRegistry(provider));

        const events = await collectEvents(engine.run(session));
        const warnings = events.filter((e) => e.type === "warning");
        const errorEvent = events.find((e) => e.type === "error");

        expect(attempts).toBe(5);
        expect(warnings).toHaveLength(4);
        expect(errorEvent).toBeDefined();
        expect(errorEvent).toMatchObject({
          type: "error",
          retryable: true,
        });
      } finally {
        timerSpy.mockRestore();
      }
    });

    it("auto-retries 503 upstream connect errors with backoff", async () => {
      let attempts = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        attempts += 1;
        if (attempts <= 2) {
          yield* [];
          throw new Error(
            "Codex API error 503: 503 upstream connect error or disconnect/reset before headers. reset reason: connection termination",
          );
        }
        yield* makeProviderStream({ text: "Recovered after 503" });
      };

      const timerSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((fn: TimerHandler) => {
          if (typeof fn === "function") fn();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        });
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

      try {
        const session = await makeSession();
        session.addUserMessage("hello");
        const engine = new AgentEngine(makeRegistry(provider));

        const events = await collectEvents(engine.run(session));
        const warnings = events.filter((e) => e.type === "warning");

        expect(attempts).toBe(3);
        expect(warnings).toHaveLength(2);
        expect(warnings[0]?.message).toContain("retrying request in 0.5s");
        expect(warnings[1]?.message).toContain("retrying request in 1s");
        expect(warnings[0]).toMatchObject({
          type: "warning",
          retryDelayMs: 500,
          retryAttempt: 1,
          retryMaxAttempts: 8,
        });
        expect(warnings[1]).toMatchObject({
          type: "warning",
          retryDelayMs: 1000,
          retryAttempt: 2,
          retryMaxAttempts: 8,
        });
        expect((warnings[0] as { retryAt?: number }).retryAt).toBeTypeOf(
          "number",
        );
        expect((warnings[1] as { retryAt?: number }).retryAt).toBeTypeOf(
          "number",
        );
        // Should recover successfully
        expect(events.find((e) => e.type === "error")).toBeUndefined();
      } finally {
        randomSpy.mockRestore();
        timerSpy.mockRestore();
      }
    });

    it("retries Cloudflare 520 HTML errors as server failures, not auth", async () => {
      // The SVG path digits ("10.4013") in Cloudflare's error page previously
      // matched the "401" auth classifier, skipping retries and showing a
      // sign-in prompt for what is a transient provider-side 5xx.
      const cloudflareHtml =
        '520 <html><head></head><body><svg viewBox="0 0 41 41">' +
        '<path d="M8.19885 10.4013C8.19491 10.5228 8.19491 10.6071Z" /></svg>' +
        '<div class="cf-error-details"><h1>Web server is returning an unknown error</h1>' +
        "<ul><li>Ray ID: a1b6948b6bd432a1</li></ul></div></body></html>";
      let attempts = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        attempts += 1;
        if (attempts === 1) {
          yield* [];
          throw Object.assign(
            new Error(`Codex API error 520: ${cloudflareHtml}`),
            { status: 520 },
          );
        }
        yield* makeProviderStream({ text: "Recovered after 520" });
      };

      const timerSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((fn: TimerHandler) => {
          if (typeof fn === "function") fn();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        });
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

      try {
        const session = await makeSession();
        session.addUserMessage("hello");
        const engine = new AgentEngine(makeRegistry(provider));

        const events = await collectEvents(engine.run(session));
        const warnings = events.filter((e) => e.type === "warning");

        expect(attempts).toBe(2);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.message).toContain("retrying request");
        expect(warnings[0]?.message).toContain(
          "Web server is returning an unknown error",
        );
        expect(warnings[0]?.message).not.toContain("<html");
        expect(events.find((e) => e.type === "error")).toBeUndefined();
        expect(session.getLastAssistantText()).toBe("Recovered after 520");
      } finally {
        randomSpy.mockRestore();
        timerSpy.mockRestore();
      }
    });

    it("honors Retry-After metadata for request retries", async () => {
      let attempts = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("rate limited"), {
            status: 429,
            headers: new Headers({ "retry-after-ms": "1250" }),
          });
        }
        yield* makeProviderStream({ text: "Recovered after rate limit" });
      };
      const timerSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((fn: TimerHandler) => {
          if (typeof fn === "function") fn();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        });

      try {
        const session = await makeSession();
        session.addUserMessage("hello");
        const engine = new AgentEngine(makeRegistry(provider));

        const events = await collectEvents(engine.run(session));
        const warning = events.find((event) => event.type === "warning");

        expect(warning).toMatchObject({
          type: "warning",
          retryDelayMs: 1250,
          retryAttempt: 1,
          retryMaxAttempts: 8,
        });
        expect(session.getLastAssistantText()).toBe(
          "Recovered after rate limit",
        );
      } finally {
        timerSpy.mockRestore();
      }
    });

    it("uses the stream reconnect budget and suppresses replayed text", async () => {
      let attempts = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        attempts += 1;
        if (attempts === 1) {
          yield { type: "text_delta", text: "Recovered " };
          throw new Error("Connection error: stream terminated");
        }
        yield* makeProviderStream({ text: "Recovered response" });
      };
      const timerSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((fn: TimerHandler) => {
          if (typeof fn === "function") fn();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        });

      try {
        const session = await makeSession();
        session.addUserMessage("hello");
        const engine = new AgentEngine(makeRegistry(provider));

        const events = await collectEvents(engine.run(session));
        const visibleText = events
          .filter((event) => event.type === "text_delta")
          .map((event) => event.text)
          .join("");
        const warning = events.find((event) => event.type === "warning");

        expect(attempts).toBe(2);
        expect(visibleText).toBe("Recovered response");
        expect(warning).toMatchObject({
          type: "warning",
          retryAttempt: 1,
          retryMaxAttempts: 5,
        });
        expect((warning as { message: string }).message).toContain(
          "retrying stream",
        );
        expect(session.getLastAssistantText()).toBe("Recovered response");
      } finally {
        timerSpy.mockRestore();
      }
    });

    it("uses the shared request retry policy for background agents", async () => {
      let attempts = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        attempts += 1;
        if (attempts <= 4) {
          yield* [];
          throw new Error(
            "Connection error.: fetch failed: Client network socket disconnected before secure TLS connection was established",
          );
        }
        yield* makeProviderStream({ text: "Recovered after TLS disconnect" });
      };

      const timerSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((fn: TimerHandler) => {
          if (typeof fn === "function") fn();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        });

      try {
        const session = await makeSession();
        session.addUserMessage("hello");
        const engine = new AgentEngine(makeRegistry(provider));

        const events = await collectEvents(
          engine.run(session, { isBackground: true }),
        );
        const warnings = events.filter((event) => event.type === "warning");

        expect(attempts).toBe(5);
        expect(warnings).toHaveLength(4);
        expect(warnings.at(-1)).toMatchObject({
          type: "warning",
          retryAttempt: 4,
          retryMaxAttempts: 4,
        });
        expect(events.find((event) => event.type === "error")).toBeUndefined();
        expect(session.getLastAssistantText()).toBe(
          "Recovered after TLS disconnect",
        );
      } finally {
        timerSpy.mockRestore();
      }
    });

    it("retries Anthropic invalid thinking signature errors once", async () => {
      let attempts = 0;
      const provider = makeMockProvider();
      Object.defineProperty(provider, "id", { value: "anthropic" });
      provider.stream = async function* () {
        attempts += 1;
        if (attempts === 1) {
          throw new Error(
            '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block"}}',
          );
        }
        yield* makeProviderStream({ text: "Recovered response" });
      };

      const session = await makeSession();
      session.addUserMessage("hello");
      const engine = new AgentEngine(makeRegistry(provider));

      const events = await collectEvents(engine.run(session));
      const warnings = events.filter((e) => e.type === "warning");
      const errorEvent = events.find((e) => e.type === "error");
      const lastMessage =
        session.getAllMessages()[session.getAllMessages().length - 1];

      expect(attempts).toBe(2);
      expect(warnings).toContainEqual(
        expect.objectContaining({
          type: "warning",
          message:
            "Anthropic rejected a thinking replay signature — retrying with sanitized replay history.",
        }),
      );
      expect(errorEvent).toBeUndefined();
      expect(lastMessage).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Recovered response" }],
      });
    });

    it("does not loop on repeated Anthropic invalid thinking signature errors", async () => {
      let attempts = 0;
      const provider = makeMockProvider();
      Object.defineProperty(provider, "id", { value: "anthropic" });
      provider.stream = async function* () {
        // Keep this mock typed as an async generator while always throwing.
        if (attempts < 0) yield* makeProviderStream();
        attempts += 1;
        throw new Error(
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block"}}',
        );
      };

      const session = await makeSession();
      session.addUserMessage("hello");
      const engine = new AgentEngine(makeRegistry(provider));

      const events = await collectEvents(engine.run(session));
      const warnings = events.filter((e) => e.type === "warning");
      const errorEvent = events.find((e) => e.type === "error");

      expect(attempts).toBe(2);
      expect(
        warnings.filter(
          (e) =>
            e.message ===
            "Anthropic rejected a thinking replay signature — retrying with sanitized replay history.",
        ),
      ).toHaveLength(1);
      expect(errorEvent).toBeDefined();
    });

    it("recovers silently on the first empty response retry", async () => {
      let attempts = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        attempts += 1;
        if (attempts === 1) {
          yield {
            type: "usage",
            inputTokens: 100,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          };
          yield { type: "content_blocks", blocks: [] };
          yield { type: "done" };
          return;
        }
        yield* makeProviderStream({ text: "Recovered response" });
      };

      const session = await makeSession();
      session.addUserMessage("hello");
      const engine = new AgentEngine(makeRegistry(provider));

      const events = await collectEvents(engine.run(session));
      const warnings = events.filter((e) => e.type === "warning");
      const doneEvent = events.find((e) => e.type === "done");
      const errorEvent = events.find((e) => e.type === "error");
      const lastMessage =
        session.getAllMessages()[session.getAllMessages().length - 1];

      expect(attempts).toBe(2);
      expect(warnings).toEqual([
        expect.objectContaining({
          type: "warning",
          message: "Provider returned an empty response — retrying…",
          visible: false,
        }),
      ]);
      expect(doneEvent).toBeDefined();
      expect(errorEvent).toBeUndefined();
      expect(lastMessage).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Recovered response" }],
      });
      // First retry is silent — no nudge message injected into history
      expect(session.getAllMessages()).not.toContainEqual(
        expect.objectContaining({
          content:
            "Your previous response was empty. Continue from where you left off and provide the full response.",
        }),
      );
    });

    it("treats whitespace-only visible blocks as empty responses", async () => {
      let attempts = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        attempts += 1;
        if (attempts === 1) {
          yield {
            type: "usage",
            inputTokens: 100,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          };
          yield {
            type: "content_blocks",
            blocks: [{ type: "text", text: "   " }],
          };
          yield { type: "done" };
          return;
        }
        yield* makeProviderStream({ text: "Recovered response" });
      };

      const session = await makeSession();
      session.addUserMessage("hello");
      const engine = new AgentEngine(makeRegistry(provider));

      const events = await collectEvents(engine.run(session));
      const warnings = events.filter((e) => e.type === "warning");

      expect(attempts).toBe(2);
      expect(warnings).toEqual([
        expect.objectContaining({
          type: "warning",
          message: "Provider returned an empty response — retrying…",
          visible: false,
        }),
      ]);
    });

    it("sends the empty-response nudge only to the provider request", async () => {
      const requests: StreamRequest[] = [];
      let attempts = 0;
      const provider = makeMockProvider();
      provider.stream = async function* (request: StreamRequest) {
        requests.push(request);
        attempts += 1;
        if (attempts <= 2) {
          yield { type: "content_blocks", blocks: [] };
          yield { type: "usage", inputTokens: 100, outputTokens: 0 };
          yield { type: "done" };
          return;
        }
        yield* makeProviderStream({ text: "Recovered response" });
      };

      const session = await makeSession();
      session.addUserMessage("hello");
      const engine = new AgentEngine(makeRegistry(provider));

      await collectEvents(engine.run(session));

      expect(requests).toHaveLength(3);
      expect(requests[2].messages.at(-1)).toEqual({
        role: "user",
        content:
          "Your previous response was empty. Continue from where you left off and provide the full response.",
      });
      expect(session.getAllMessages()).not.toContainEqual(
        expect.objectContaining({
          content:
            "Your previous response was empty. Continue from where you left off and provide the full response.",
        }),
      );
    });

    it("bounds provider streams that never establish transport activity", async () => {
      let attempts = 0;
      const requestSignals: AbortSignal[] = [];
      const provider = makeMockProvider();
      provider.stream = async function* (request: StreamRequest) {
        attempts += 1;
        if (request.signal) requestSignals.push(request.signal);
        await new Promise<never>(() => undefined);
        yield { type: "done" };
      };
      const backoffSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((fn: TimerHandler) => {
          if (typeof fn === "function") fn();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        });

      try {
        const session = await makeSession();
        session.addUserMessage("hello");
        const engine = new AgentEngine(makeRegistry(provider));

        const events = await collectEvents(
          engine.run(session, { providerFirstEventTimeoutMs: 5 }),
        );
        const error = events.find((event) => event.type === "error");

        expect(attempts).toBe(5);
        expect(requestSignals).toHaveLength(5);
        expect(requestSignals.every((signal) => signal.aborted)).toBe(true);
        expect(error).toEqual(
          expect.objectContaining({
            type: "error",
            retryable: true,
          }),
        );
        expect((error as { error?: string }).error).toContain(
          "connection timed out",
        );
      } finally {
        backoffSpy.mockRestore();
      }
    });

    it("keeps a semantically quiet stream alive while transport activity continues", async () => {
      const provider = makeMockProvider();
      provider.stream = async function* (request: StreamRequest) {
        const heartbeat = setInterval(() => {
          request.onTransportActivity?.({
            kind: "body",
            at: Date.now(),
            bytes: 1,
          });
        }, 2);
        try {
          await new Promise((resolve) => setTimeout(resolve, 20));
          yield* makeProviderStream({ text: "Alive after heartbeats" });
        } finally {
          clearInterval(heartbeat);
        }
      };

      const session = await makeSession();
      session.addUserMessage("hello");
      const engine = new AgentEngine(makeRegistry(provider));

      const events = await collectEvents(
        engine.run(session, {
          providerFirstEventTimeoutMs: 5,
          providerInactivityTimeoutMs: 5,
        }),
      );

      expect(events.find((event) => event.type === "error")).toBeUndefined();
      expect(session.getLastAssistantText()).toBe("Alive after heartbeats");
    });

    it("surfaces a retryable error after consecutive empty responses", async () => {
      let attempts = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        attempts += 1;
        yield {
          type: "usage",
          inputTokens: 100,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };
        yield { type: "content_blocks", blocks: [] };
        yield { type: "done" };
      };

      const session = await makeSession();
      // Disable auto-condense so we test the pure empty-response error path
      session.autoCondense = false;
      session.addUserMessage("hello");
      const engine = new AgentEngine(makeRegistry(provider));

      const events = await collectEvents(engine.run(session));
      const warnings = events.filter((e) => e.type === "warning");
      const doneEvent = events.find((e) => e.type === "done");
      const errorEvent = events.find((e) => e.type === "error");

      // 3 attempts: initial + 2 retries (MAX_EMPTY_RESPONSE_RETRIES = 2)
      expect(attempts).toBe(3);
      expect(warnings).toContainEqual(
        expect.objectContaining({
          type: "warning",
          message: "Provider returned an empty response — retrying…",
          visible: false,
        }),
      );
      expect(warnings).toContainEqual(
        expect.objectContaining({
          type: "warning",
          message:
            "Provider returned an empty response — asking it to continue…",
          visible: false,
        }),
      );
      expect(doneEvent).toBeUndefined();
      expect(errorEvent).toEqual(
        expect.objectContaining({
          type: "error",
          error:
            "Provider returned empty responses 3 times in a row. Please retry.",
          retryable: true,
          actions: { condense: true },
        }),
      );
      // The nudge message injected during retry should be cleaned up
      expect(session.getAllMessages()).not.toContainEqual(
        expect.objectContaining({
          content:
            "Your previous response was empty. Continue from where you left off and provide the full response.",
        }),
      );
    });

    it("auto-condenses and recovers after consecutive empty responses", async () => {
      let attempts = 0;
      let condenseCalled = false;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        attempts += 1;
        if (!condenseCalled) {
          // Return empty before condense
          yield {
            type: "usage",
            inputTokens: 100,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          };
          yield { type: "content_blocks", blocks: [] };
          yield { type: "done" };
          return;
        }
        // After condense, return a real response
        yield* makeProviderStream({ text: "Recovered after condense" });
      };

      // Mock successful condense
      mocks.mockSummarizeConversation.mockResolvedValueOnce({
        messages: [
          { role: "user", content: "condensed summary", isSummary: true },
        ],
        summary: "condensed summary",
        prevInputTokens: 100,
        newInputTokens: 50,
      });

      const session = await makeSession();
      session.addUserMessage("hello");
      const engine = new AgentEngine(makeRegistry(provider));

      // Intercept condenseSession to track it and mark condenseCalled
      const originalCondense = (engine as any).condenseSession;
      (engine as any).condenseSession = async function* (...args: any[]) {
        const result = yield* originalCondense.apply(engine, args);
        condenseCalled = true;
        return result;
      };

      const events = await collectEvents(engine.run(session));
      const doneEvent = events.find((e) => e.type === "done");
      const errorEvent = events.find((e) => e.type === "error");
      const condenseWarning = events.find(
        (e) =>
          e.type === "warning" &&
          (e as any).message.includes("condensing conversation"),
      );

      expect(condenseCalled).toBe(true);
      expect(condenseWarning).toBeDefined();
      expect(doneEvent).toBeDefined();
      expect(errorEvent).toBeUndefined();
    });
  });

  describe("condenseSession", () => {
    it("clears stale token accounting after successful condense", async () => {
      mocks.mockSummarizeConversation.mockResolvedValue({
        messages: [{ role: "user", content: "summary", isSummary: true }],
        summary: "summary",
        prevInputTokens: 180_000,
        newInputTokens: 12_000,
      });

      const session = await makeSession();
      session.addUserMessage("hello");
      session.lastInputTokens = 180_000;
      session.lastOutputTokens = 5_000;
      session.lastCacheReadTokens = 100_000;
      session.addEstimatedTokens(120_000);

      const engine = new AgentEngine(makeRegistry());
      const events = await collectEvents(engine.condenseSession(session, true));

      expect(events.some((e) => e.type === "condense")).toBe(true);
      expect(session.lastInputTokens).toBe(12_000);
      expect(session.lastOutputTokens).toBe(0);
      expect(session.lastCacheReadTokens).toBe(0);
      expect(session.estimatedAccumulatedTokens).toBe(0);
      expect(session.estimatedInputUsed).toBe(12_000);
    });

    it("propagates structured condense error metadata", async () => {
      mocks.mockSummarizeConversation.mockResolvedValue({
        messages: [],
        summary: "",
        prevInputTokens: 1000,
        newInputTokens: 1000,
        error:
          "Condensing API call failed: Codex API error 429: The usage limit has been reached",
        errorRetryable: true,
        errorCode: "oauth_usage_limit_exhausted",
        errorActions: { signInAnotherAccount: true },
      });

      const session = await makeSession();
      session.addUserMessage("hello");

      const engine = new AgentEngine(makeRegistry());
      const events = await collectEvents(engine.condenseSession(session, true));

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "condense_error",
          error:
            "Condensing API call failed: Codex API error 429: The usage limit has been reached",
          retryable: true,
          code: "oauth_usage_limit_exhausted",
          actions: { signInAnotherAccount: true },
        }),
      );
    });
  });
});
