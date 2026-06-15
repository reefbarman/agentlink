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
      getConfiguration: (...args: unknown[]) => mocks.getConfiguration(...args),
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
    approvalManager: {} as ToolDispatchContext["approvalManager"],
    approvalPanel: {} as ToolDispatchContext["approvalPanel"],
    extensionUri: {} as ToolDispatchContext["extensionUri"],
    sessionId: "fg",
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
});
