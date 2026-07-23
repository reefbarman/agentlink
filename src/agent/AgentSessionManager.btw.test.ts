import type {
  CompleteRequest,
  CompleteResult,
  ModelCapabilities,
  ModelInfo,
  ModelProvider,
  ProviderStreamEvent,
  StreamRequest,
} from "./providers/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentConfig } from "./types.js";
import { AgentSessionManager } from "./AgentSessionManager.js";
import type { ToolDispatchContext } from "./toolAdapter.js";
import { providerRegistry } from "./providers/index.js";

const mocks = vi.hoisted(() => ({
  mockBuildPromptArtifacts: vi.fn().mockResolvedValue({
    systemPrompt: "mock system prompt",
    skills: [],
    promptBreakdown: {
      sections: [{ label: "test", chars: 18, estimatedTokens: 5 }],
      totalChars: 18,
      estimatedTokens: 5,
    },
  }),
  getConfiguration: vi.fn(),
}));

vi.mock("vscode", async () => {
  const actual = await vi.importActual<typeof import("../__mocks__/vscode.js")>(
    "../__mocks__/vscode.js",
  );
  return {
    ...actual,
    workspace: {
      ...actual.workspace,
      getConfiguration: (...args: unknown[]) => {
        const config = mocks.getConfiguration(...args);
        return {
          ...config,
          get: (key: string, ...getArgs: unknown[]) => {
            if (
              key === "webAccess.searchBackend" ||
              key === "webAccess.fetchBackend"
            ) {
              return "disabled";
            }
            return config.get(key, ...getArgs);
          },
        };
      },
    },
  };
});

vi.mock("./systemPrompt.js", () => ({
  buildPromptArtifacts: mocks.mockBuildPromptArtifacts,
}));

const TEST_MODEL = "btw-test-model";

const TEST_CAPABILITIES: ModelCapabilities = {
  supportsThinking: false,
  supportsCaching: true,
  supportsImages: true,
  supportsToolUse: true,
  contextWindow: 200_000,
  maxOutputTokens: 8192,
};

const config: AgentConfig = {
  model: TEST_MODEL,
  maxTokens: 8192,
  thinkingBudget: 0,
  showThinking: false,
  autoCondense: true,
  autoCondenseThreshold: 0.9,
};

function makeToolCtx(): ToolDispatchContext {
  return {
    approvalManager: {
      bindSessionProject: vi.fn(),
    } as unknown as ToolDispatchContext["approvalManager"],
    approvalPanel: {} as ToolDispatchContext["approvalPanel"],
    extensionUri: {} as ToolDispatchContext["extensionUri"],
    sessionId: "fg",
    worktreeAgentLaunchProvider: {
      start: vi.fn(),
    },
  };
}

function makeProvider(
  stream: (request: StreamRequest, callIndex: number) => ProviderStreamEvent[],
): ModelProvider & { requests: StreamRequest[] } {
  let callIndex = 0;
  const requests: StreamRequest[] = [];
  return {
    id: "btw-test-provider",
    displayName: "BTW Test Provider",
    condenseModel: TEST_MODEL,
    requests,
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
          displayName: "BTW Test Model",
          provider: "btw-test-provider",
          capabilities: TEST_CAPABILITIES,
        },
      ];
    },
    async *stream(request: StreamRequest) {
      requests.push(request);
      const events = stream(request, callIndex++);
      for (const event of events) {
        yield event;
      }
    },
    async complete(_request: CompleteRequest): Promise<CompleteResult> {
      return { text: "unused" };
    },
  };
}

function textResponse(text: string): ProviderStreamEvent[] {
  return [
    { type: "text_delta", text },
    { type: "content_blocks", blocks: [{ type: "text", text }] },
    { type: "usage", inputTokens: 10, outputTokens: 5 },
    { type: "done" },
  ];
}

describe("AgentSessionManager /btw side questions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfiguration.mockReturnValue({
      get: () => ({}),
      inspect: () => undefined,
    });
  });

  it("runs a transient side question through the tool loop", async () => {
    const provider = makeProvider((_request, callIndex) => {
      if (callIndex === 0) {
        return [
          {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "read_file",
                input: { path: "src/agent/ChatViewProvider.ts" },
              },
            ],
          },
          { type: "usage", inputTokens: 20, outputTokens: 2 },
          { type: "done" },
        ];
      }
      return textResponse("The handler can now use tools.");
    });
    providerRegistry.register(provider);

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(makeToolCtx());
    const fg = await mgr.createSession("code");
    fg.addUserMessage("Prior context");

    const result = await mgr.runBtwQuestion("can you inspect this?");

    expect(result.answer).toBe("The handler can now use tools.");
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ toolName: "read_file" }),
    ]);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.tools?.map((t) => t.name)).toContain(
      "read_file",
    );
    expect(provider.requests[0]?.tools?.map((t) => t.name)).not.toContain(
      "write_file",
    );
    expect(fg.getAllMessages()).toHaveLength(1);
    expect(fg.getAllMessages()[0]).toMatchObject({
      role: "user",
      content: "Prior context",
    });
  });

  it("deep-clones foreground context before running the side question", async () => {
    const provider = makeProvider((request) => {
      const firstContent = request.messages[0]?.content;
      if (Array.isArray(firstContent)) {
        firstContent.push({ type: "text", text: "mutated by provider" });
      }
      return textResponse("done");
    });
    providerRegistry.register(provider);

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(makeToolCtx());
    const fg = await mgr.createSession("code");
    fg.appendAssistantTurn([{ type: "text", text: "nested context" }]);

    await mgr.runBtwQuestion("side question");

    expect(fg.getAllMessages()[0]?.content).toEqual([
      { type: "text", text: "nested context" },
    ]);
  });

  it("allows /btw while the foreground session is running", async () => {
    const provider = makeProvider(() => textResponse("side answer"));
    providerRegistry.register(provider);

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(makeToolCtx());
    const fg = await mgr.createSession("code");
    fg.status = "streaming";
    fg.addUserMessage("Foreground context");

    const result = await mgr.runBtwQuestion("can you check?");

    expect(result.answer).toBe("side answer");
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "Foreground context",
        }),
        expect.objectContaining({ role: "user", content: "can you check?" }),
      ]),
    );
    expect(fg.status).toBe("streaming");
    expect(fg.getAllMessages()).toHaveLength(1);
  });

  it("runs /worktree setup as a minimal session while foreground work continues", async () => {
    const provider = makeProvider(() =>
      textResponse(
        'Ready. <worktree-config>{"task":"Alternative auth","prompt":"Prototype alternative auth"}</worktree-config>',
      ),
    );
    providerRegistry.register(provider);

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(makeToolCtx());
    const fg = await mgr.createSession("code");
    fg.status = "streaming";
    fg.addUserMessage("Unrelated foreground task");
    const onSessionStarted = vi.fn();

    const result = await mgr.runWorktreeSetup(
      {},
      {
        onSessionStarted,
      },
    );

    expect(result.answer).toContain("<worktree-config>");
    expect(onSessionStarted).toHaveBeenCalledWith(result.sessionId);
    expect(provider.requests[0]?.systemPrompt).toContain(
      "temporary setup agent",
    );
    expect(provider.requests[0]?.systemPrompt).not.toContain(
      "mock system prompt",
    );
    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["execute_command", "read_file"]),
    );
    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).not.toContain(
      "ask_user",
    );
    expect(fg.status).toBe("streaming");
    expect(fg.getAllMessages()).toEqual([
      expect.objectContaining({ content: "Unrelated foreground task" }),
    ]);
  });

  it("carries text-only setup conversation into a later minimal turn", async () => {
    const provider = makeProvider(() =>
      textResponse("Which authentication approach should it prototype?"),
    );
    providerRegistry.register(provider);
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(makeToolCtx());

    const result = await mgr.runWorktreeSetup(
      {},
      {
        conversation: [
          {
            role: "assistant",
            text: "What should the worktree agent do?",
          },
          { role: "user", text: "Prototype passkeys" },
        ],
      },
    );

    expect(result.answer).toBe(
      "Which authentication approach should it prototype?",
    );
    expect(provider.requests[0]?.messages.at(-1)?.content).toContain(
      '"text": "Prototype passkeys"',
    );
  });

  it("passes an inline shelf approval through to the worktree launch provider", async () => {
    const start = vi.fn().mockResolvedValue({ content: [] });
    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext({
      ...makeToolCtx(),
      worktreeAgentLaunchProvider: { start },
    });
    const request = { task: "Alternative", prompt: "Try the alternative" };

    await mgr.startWorktreeAgent(request, {
      approvalDecision: "approve-prefill",
    });

    expect(start).toHaveBeenCalledWith(request, {
      approvalDecision: "approve-prefill",
    });
  });

  it("streams incremental progress events while running", async () => {
    const provider = makeProvider((_request, callIndex) => {
      if (callIndex === 0) {
        return [
          {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "read_file",
                input: { path: "src/agent/ChatViewProvider.ts" },
              },
            ],
          },
          { type: "usage", inputTokens: 20, outputTokens: 2 },
          { type: "done" },
        ];
      }
      return textResponse("streamed answer");
    });
    providerRegistry.register(provider);

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(makeToolCtx());
    await mgr.createSession("code");

    const events: string[] = [];
    let lastBudget: { apiTurns: number; toolCalls: number } | undefined;
    const result = await mgr.runBtwQuestion("stream please", {
      onProgress: (event) => {
        events.push(event.type);
        if (event.type === "budget") {
          lastBudget = {
            apiTurns: event.apiTurns,
            toolCalls: event.toolCalls,
          };
        }
      },
    });

    expect(result.answer).toBe("streamed answer");
    expect(result.cancelled).toBe(false);
    expect(events).toContain("text_delta");
    expect(events).toContain("tool");
    expect(events).toContain("budget");
    expect(result.toolCallCount).toBe(1);
    expect(result.maxApiTurns).toBe(5);
    expect(result.maxToolCalls).toBe(10);
    expect(lastBudget?.toolCalls).toBe(1);
    expect(lastBudget?.apiTurns).toBeGreaterThanOrEqual(1);
  });

  it("returns a cancelled result without running when the signal is pre-aborted", async () => {
    const provider = makeProvider(() => textResponse("should not run"));
    providerRegistry.register(provider);

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(makeToolCtx());
    await mgr.createSession("code");

    const controller = new AbortController();
    controller.abort();
    const result = await mgr.runBtwQuestion("never mind", {
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(result.answer).toBe("");
    expect(provider.requests).toHaveLength(0);
  });

  it("aborts the side session mid-run when the signal fires", async () => {
    const controller = new AbortController();
    const provider = makeProvider((_request, callIndex) => {
      // Abort partway through: after the first turn requests a tool, the run
      // should stop before issuing a second API request.
      if (callIndex === 0) {
        controller.abort();
        return [
          {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "read_file",
                input: { path: "src/agent/ChatViewProvider.ts" },
              },
            ],
          },
          { type: "usage", inputTokens: 20, outputTokens: 2 },
          { type: "done" },
        ];
      }
      return textResponse("second turn should not happen");
    });
    providerRegistry.register(provider);

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(makeToolCtx());
    await mgr.createSession("code");

    const result = await mgr.runBtwQuestion("cancel me", {
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    // Only the first turn ran; the abort stopped the loop before a second call.
    expect(provider.requests).toHaveLength(1);
  });

  it("clears the in-flight guard so a second /btw can run after the first", async () => {
    const provider = makeProvider(() => textResponse("ok"));
    providerRegistry.register(provider);

    const mgr = new AgentSessionManager(config, "/tmp");
    mgr.setToolContext(makeToolCtx());
    await mgr.createSession("code");

    const first = await mgr.runBtwQuestion("first");
    expect(first.answer).toBe("ok");
    // Would throw "Another /btw question is already running" if not cleared.
    const second = await mgr.runBtwQuestion("second");
    expect(second.answer).toBe("ok");
  });

  it("can append queued follow-ups as separate user messages before one run", async () => {
    const provider = makeProvider(() => textResponse("batch answer"));
    providerRegistry.register(provider);

    const mgr = new AgentSessionManager(config, "/tmp");
    const fg = await mgr.createSession("code");

    await mgr.sendMessage(fg.id, "first queued", "code", {
      displayText: "first queued",
      additionalMessages: [
        {
          text: "second queued",
          displayText: "second queued",
        },
      ],
    });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "first queued" }),
      expect.objectContaining({ role: "user", content: "second queued" }),
    ]);
    expect(
      fg
        .getAllMessages()
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["first queued", "second queued"]);
  });
});
