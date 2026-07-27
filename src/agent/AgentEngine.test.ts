import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { AgentConfig, AgentEvent, AgentMessage } from "./types.js";
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

import {
  AgentEngine,
  buildSessionTranscriptSnapshot,
  measureToolResultContentForAttribution,
  toolResultToContent,
  truncateToolText,
} from "./AgentEngine.js";
import { AgentSession } from "./AgentSession.js";
import { ProviderRegistry } from "./providers/index.js";
import type { SkillEntry } from "./skillLoader.js";
import { AgentToolCallTracker } from "./AgentToolCallTracker.js";
import { todoTool } from "./todoTool.js";
import type {
  AgentToolExecutionRequest,
  SkillAuthoritySnapshot,
} from "../core/tools/types.js";
import type { CoreModelContentBlock } from "../core/modelRuntime.js";
import { CORE_NATIVE_WEB_MAX_PAUSE_TURNS } from "../core/nativeWebTools.js";
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
    promptProfile: {
      profile: "compatibility",
      source: "compatibility-default",
      policyRevision: "prompt-profile-policy-v1",
      providerId: "mock",
      modelId: "claude-sonnet-4-6",
    },
    skills: [],
    promptBreakdown: {
      sections: [{ label: "test", chars: 18, estimatedTokens: 5 }],
      totalChars: 18,
      estimatedTokens: 5,
      profile: "compatibility",
      profileSource: "compatibility-default",
      profilePolicyRevision: "prompt-profile-policy-v1",
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
  buildModeInstructionBlock: vi
    .fn()
    .mockResolvedValue(
      '<current_mode mode="mock">mock mode block</current_mode>',
    ),
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
    async *stream(request: StreamRequest) {
      request.onProviderRequestAttempt?.({ model: request.model });
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
  return AgentSession.createForLegacyCwd({
    mode: "code",
    config,
    cwd: "/test",
  });
}

function makeSkillEntry(
  name: string,
  revision: string,
  allowedTools: string[],
): SkillEntry {
  const skillDirectory = `/test/.agentlink/skills/${name}`;
  const skillPath = `${skillDirectory}/SKILL.md`;
  return {
    id: `project:agentlink:.agentlink/skills/${name}`,
    name,
    description: `${name} skill`,
    revision,
    sourceChars: 128,
    provenance: {
      scope: "project",
      namespace: "agentlink",
      sourceRoot: "/test/.agentlink/skills",
      skillDirectory,
      realSkillPath: skillPath,
      priority: 1,
    },
    skillPath,
    allowedTools,
    restrictions: { allowedTools },
    permissions: { requestedTools: [] },
    dependencies: [],
    recommendations: [],
    resolvedDependencies: [],
    enabled: true,
  };
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

describe("buildSessionTranscriptSnapshot", () => {
  it("clones raw messages and derives source kinds and condensed flags consistently", () => {
    const sourceContent = [
      { type: "text" as const, text: "original evidence" },
    ];
    const messages: AgentMessage[] = [
      { role: "user", content: "task", condenseParent: "summary-1" },
      {
        role: "assistant",
        content: sourceContent,
        condenseParent: "summary-1",
      },
      {
        role: "user",
        content: "summary",
        isSummary: true,
        condenseId: "summary-1",
      },
      { role: "user", content: "resume", isResumeContext: true },
      { role: "assistant", content: [{ type: "text", text: "current" }] },
    ];

    const snapshot = buildSessionTranscriptSnapshot(messages);
    sourceContent[0]!.text = "mutated after projection";
    messages[0]!.content = "mutated task";

    expect(snapshot.messages.map((message) => message.sourceKind)).toEqual([
      "source",
      "source",
      "summary",
      "resume",
      "source",
    ]);
    expect(snapshot.messages.map((message) => message.condensed)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(snapshot.messages[0]?.content).toBe("task");
    expect(snapshot.messages[1]?.content).toEqual([
      { type: "text", text: "original evidence" },
    ]);
  });
});

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
      const todos = [
        {
          id: "inspect",
          content: "Inspect the failure",
          activeForm: "Inspecting the failure",
          status: "completed" as const,
        },
        {
          id: "fix",
          content: "Fix the failure",
          activeForm: "Fixing the failure",
          status: "in_progress" as const,
        },
      ];
      session.replaceMessages([
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "todo-1",
              name: "todo_write",
              input: { todos },
            },
          ],
        },
      ]);
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
      expect(condenseSpy).toHaveBeenCalledWith(
        session,
        true,
        expect.anything(),
        expect.objectContaining({ todos }),
        TEST_MODEL,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
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

  describe("parallel tool dispatch", () => {
    it("applies a loaded skill only after the current batch boundary", async () => {
      const broad = makeSkillEntry("broad", "a".repeat(64), [
        "load_skill",
        "read_file",
        "search_files",
      ]);
      const narrow = makeSkillEntry("narrow", "b".repeat(64), ["read_file"]);
      let streamCount = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        streamCount += 1;
        if (streamCount === 1) {
          yield {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id: "before-read",
                name: "read_file",
                input: { path: "src/a.ts" },
              },
              {
                type: "tool_use",
                id: "load-skill",
                name: "load_skill",
                input: { path: narrow.skillPath },
              },
              {
                type: "tool_use",
                id: "after-search",
                name: "search_files",
                input: { regex: "AgentEngine", path: "src" },
              },
            ],
          };
          yield { type: "usage", inputTokens: 20, outputTokens: 5 };
          yield { type: "done" };
          return;
        }
        yield* makeProviderStream({ text: "done" });
      };

      const dispatchedPolicies: Array<{
        name: string;
        allowedTools: readonly string[] | undefined;
      }> = [];
      const session = await makeSession();
      session.addUserMessage("load the skill and inspect files");
      session.setAdvertisedSkills([broad, narrow]);
      expect(
        session.trackLoadedSkill({
          id: broad.id,
          name: broad.name,
          revision: broad.revision,
          skillPath: broad.skillPath,
        }),
      ).toBe(true);
      const engine = new AgentEngine(makeRegistry(provider));
      engine.setToolRuntime({
        listTools: () => [
          {
            name: "load_skill",
            description: "load skill",
            input_schema: { type: "object" },
          },
          {
            name: "read_file",
            description: "read file",
            input_schema: { type: "object" },
          },
          {
            name: "search_files",
            description: "search files",
            input_schema: { type: "object" },
          },
        ],
        isParallelSafe: () => false,
        executeTool: async (request) => {
          dispatchedPolicies.push({
            name: request.name,
            allowedTools: request.context.skillAllowedTools
              ? [...request.context.skillAllowedTools]
              : undefined,
          });
          if (request.name === "load_skill") {
            request.context.onSkillLoad?.({
              id: narrow.id,
              name: narrow.name,
              revision: narrow.revision,
              skillPath: narrow.skillPath,
            });
          }
          return { content: [{ type: "text", text: "ok" }] };
        },
      });

      await collectEvents(engine.run(session));

      expect(dispatchedPolicies).toEqual([
        { name: "read_file", allowedTools: broad.allowedTools },
        { name: "load_skill", allowedTools: broad.allowedTools },
        { name: "search_files", allowedTools: broad.allowedTools },
      ]);
      expect(session.getActiveSkillAllowedTools()).toEqual(["read_file"]);
    });

    it("preserves the request skill policy when session policy changes during streaming", async () => {
      const broad = makeSkillEntry("broad", "a".repeat(64), [
        "read_file",
        "search_files",
      ]);
      const narrow = makeSkillEntry("narrow", "b".repeat(64), ["read_file"]);
      const session = await makeSession();
      session.addUserMessage("search under the current skill policy");
      session.setAdvertisedSkills([broad, narrow]);
      expect(
        session.trackLoadedSkill({
          id: broad.id,
          name: broad.name,
          revision: broad.revision,
          skillPath: broad.skillPath,
        }),
      ).toBe(true);

      let streamCount = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        streamCount += 1;
        if (streamCount === 1) {
          expect(
            session.trackLoadedSkill({
              id: narrow.id,
              name: narrow.name,
              revision: narrow.revision,
              skillPath: narrow.skillPath,
            }),
          ).toBe(true);
          yield {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id: "request-search",
                name: "search_files",
                input: { regex: "AgentEngine", path: "src" },
              },
            ],
          };
          yield { type: "usage", inputTokens: 20, outputTokens: 5 };
          yield { type: "done" };
          return;
        }
        yield* makeProviderStream({ text: "done" });
      };

      let dispatchedPolicy: readonly string[] | undefined;
      const engine = new AgentEngine(makeRegistry(provider));
      engine.setToolRuntime({
        listTools: () => [
          {
            name: "read_file",
            description: "read file",
            input_schema: { type: "object" },
          },
          {
            name: "search_files",
            description: "search files",
            input_schema: { type: "object" },
          },
        ],
        isParallelSafe: () => false,
        executeTool: async (request) => {
          dispatchedPolicy = request.context.skillAllowedTools
            ? [...request.context.skillAllowedTools]
            : undefined;
          return { content: [{ type: "text", text: "ok" }] };
        },
      });

      await collectEvents(engine.run(session));

      expect(dispatchedPolicy).toEqual(broad.allowedTools);
      expect(session.getActiveSkillAllowedTools()).toEqual(["read_file"]);
    });

    it("intersects inherited skill authority with child skill restrictions", async () => {
      const childSkill = makeSkillEntry("child-broad", "b".repeat(64), [
        "read_file",
        "search_files",
      ]);
      const inheritedSkillAuthority: SkillAuthoritySnapshot = {
        schemaVersion: 1,
        sources: [
          {
            catalogRevision: "parent-catalog",
            activations: [
              {
                id: "project:agentlink:.agentlink/skills/parent-narrow",
                name: "parent-narrow",
                revision: "a".repeat(64),
              },
            ],
            policyRevision: "parent-policy",
          },
        ],
        allowedTools: ["read_file"],
      };
      let streamCount = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        streamCount += 1;
        if (streamCount === 1) {
          yield {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id: "request-read",
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

      const session = await makeSession();
      session.addUserMessage("read under inherited authority");
      session.setAdvertisedSkills([childSkill]);
      session.setSkillCatalogProjection({
        schemaVersion: 1,
        revision: "child-catalog",
        budgetChars: 1_024,
        renderedChars: 0,
        discoveredCount: 1,
        enabledCount: 1,
        advertisedCount: 1,
        truncatedCount: 0,
        omittedCount: 0,
        sourceChars: 0,
        deferredChars: 0,
        retrievalFallbackRequired: false,
        advertised: [],
        omissions: [],
        catalogXml: "",
      });
      expect(
        session.trackLoadedSkill({
          id: childSkill.id,
          name: childSkill.name,
          revision: childSkill.revision,
          skillPath: childSkill.skillPath,
        }),
      ).toBe(true);

      const listedPolicies: Array<readonly string[] | undefined> = [];
      let dispatchedAuthority: Readonly<SkillAuthoritySnapshot> | undefined;
      const engine = new AgentEngine(makeRegistry(provider));
      engine.setToolRuntime({
        listTools: (request) => {
          listedPolicies.push(request.skillAllowedTools);
          return [
            {
              name: "read_file",
              description: "read file",
              input_schema: { type: "object" },
            },
          ];
        },
        isParallelSafe: () => false,
        executeTool: async (request) => {
          dispatchedAuthority = request.context.skillAuthority;
          return { content: [{ type: "text", text: "ok" }] };
        },
      });

      await collectEvents(engine.run(session, { inheritedSkillAuthority }));

      expect(
        listedPolicies.every((policy) => policy?.join() === "read_file"),
      ).toBe(true);
      expect(dispatchedAuthority).toMatchObject({
        schemaVersion: 1,
        allowedTools: ["read_file"],
        sources: [
          inheritedSkillAuthority.sources[0],
          {
            catalogRevision: "child-catalog",
            activations: [
              {
                id: childSkill.id,
                name: childSkill.name,
                revision: childSkill.revision,
              },
            ],
            policyRevision: session.getActiveSkillPolicy().revision,
          },
        ],
      });
      expect(Object.isFrozen(dispatchedAuthority)).toBe(true);
      expect(Object.isFrozen(dispatchedAuthority?.sources)).toBe(true);
      expect(
        Object.isFrozen(dispatchedAuthority?.sources[1]?.activations),
      ).toBe(true);
    });

    it("runs adjacent safe calls concurrently without crossing ordered barriers", async () => {
      const toolCalls = [
        { id: "read-before-a", name: "read", input: {} },
        { id: "read-before-b", name: "read", input: {} },
        { id: "write-barrier", name: "write", input: {} },
        { id: "read-after-a", name: "read", input: {} },
        { id: "read-after-b", name: "read", input: {} },
      ];
      let streamCount = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        streamCount += 1;
        if (streamCount === 1) {
          yield {
            type: "content_blocks",
            blocks: toolCalls.map((call) => ({
              type: "tool_use" as const,
              ...call,
            })),
          };
          yield { type: "usage", inputTokens: 20, outputTokens: 5 };
          yield { type: "done" };
          return;
        }
        yield* makeProviderStream({ text: "done" });
      };

      const releases = new Map<string, () => void>();
      const gates = new Map(
        toolCalls.map((call) => [
          call.id,
          new Promise<void>((resolve) => releases.set(call.id, resolve)),
        ]),
      );
      const started: string[] = [];
      const session = await makeSession();
      session.addUserMessage("run an ordered mixed batch");
      const engine = new AgentEngine(makeRegistry(provider));
      engine.setToolRuntime({
        listTools: () => [
          {
            name: "read",
            description: "read",
            input_schema: { type: "object" },
          },
          {
            name: "write",
            description: "write",
            input_schema: { type: "object" },
          },
        ],
        isParallelSafe: (name) => name === "read",
        executeTool: async (request) => {
          started.push(request.context.toolCallId ?? request.name);
          await gates.get(request.context.toolCallId ?? "");
          return { content: [{ type: "text", text: "ok" }] };
        },
      });

      const run = collectEvents(engine.run(session));
      await vi.waitFor(() =>
        expect(started).toEqual(["read-before-a", "read-before-b"]),
      );
      releases.get("read-before-a")?.();
      releases.get("read-before-b")?.();
      await vi.waitFor(() =>
        expect(started).toEqual([
          "read-before-a",
          "read-before-b",
          "write-barrier",
        ]),
      );
      releases.get("write-barrier")?.();
      await vi.waitFor(() =>
        expect(started).toEqual([
          "read-before-a",
          "read-before-b",
          "write-barrier",
          "read-after-a",
          "read-after-b",
        ]),
      );
      releases.get("read-after-a")?.();
      releases.get("read-after-b")?.();
      await expect(run).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "done" })]),
      );
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
        events
          .filter(
            (e): e is Extract<AgentEvent, { type: "tool_start" }> =>
              e.type === "tool_start",
          )
          .map((e) => ({ toolName: e.toolName, input: e.input })),
      ).toEqual([
        { toolName: "read_file", input: { path: "src/a.ts" } },
        {
          toolName: "write_file",
          input: { path: "src/x.ts", content: "x" },
        },
      ]);

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

      const session = await AgentSession.createForLegacyCwd({
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

    it("injects queued image path attachments as image media instead of text", async () => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-engine-"));
      const imageBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00,
      ]);
      await fs.writeFile(path.join(cwd, "canteen.png"), imageBytes);

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

      const session = await AgentSession.createForLegacyCwd({
        mode: "code",
        config: testConfig,
        cwd,
      });
      session.addUserMessage("read then inspect the image");
      const engine = new AgentEngine(makeRegistry(provider));
      const toolCtx: ToolDispatchContext = {
        approvalManager: {} as ToolDispatchContext["approvalManager"],
        approvalPanel: {} as ToolDispatchContext["approvalPanel"],
        sessionId: "seed-session",
        extensionUri: {} as ToolDispatchContext["extensionUri"],
      };
      setEngineToolContext(engine, toolCtx, async () => {
        session.setPendingInterjection(
          "[Attached: canteen.png]\n\ninspect this image",
          "queue-image",
          undefined,
          undefined,
          false,
          undefined,
          ["canteen.png"],
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
        };
      });

      await collectEvents(engine.run(session));

      expect(requests).toHaveLength(2);
      expect(requests[1].messages.at(-1)).toEqual({
        role: "user",
        content: [
          { type: "text", text: "inspect this image" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: imageBytes.toString("base64"),
            },
          },
        ],
      });
    });

    it("injects multiple pending interjections FIFO at the same tool-batch break", async () => {
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

      const session = await makeSession();
      session.addUserMessage("read then follow up");
      const engine = new AgentEngine(makeRegistry(provider));
      const toolCtx: ToolDispatchContext = {
        approvalManager: {} as ToolDispatchContext["approvalManager"],
        approvalPanel: {} as ToolDispatchContext["approvalPanel"],
        sessionId: "seed-session",
        extensionUri: {} as ToolDispatchContext["extensionUri"],
      };
      setEngineToolContext(engine, toolCtx, async () => {
        session.setPendingInterjection("first follow up", "queue-1");
        session.setPendingInterjection("second follow up", "queue-2");
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
        };
      });

      const events = await collectEvents(engine.run(session));

      const interjections = events.filter(
        (e): e is Extract<AgentEvent, { type: "user_interjection" }> =>
          e.type === "user_interjection",
      );
      expect(interjections.map((e) => e.queueId)).toEqual([
        "queue-1",
        "queue-2",
      ]);

      expect(requests).toHaveLength(2);
      expect(requests[1].messages.slice(-2)).toEqual([
        { role: "user", content: "first follow up" },
        { role: "user", content: "second follow up" },
      ]);
    });

    it("propagates the active tool profile into tool execution context", async () => {
      let streamCall = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id: "call_command",
                name: "execute_command",
                input: { command: "pwd" },
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
      };

      const session = await makeSession();
      session.addUserMessage("inspect the workspace");
      const engine = new AgentEngine(makeRegistry(provider));
      const executeTool = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));
      engine.setToolRuntime({
        listTools: () => [
          {
            name: "execute_command",
            description: "read-only command",
            input_schema: { type: "object", properties: {} },
          },
        ],
        isParallelSafe: () => false,
        executeTool,
      });

      await collectEvents(
        engine.run(session, {
          isBackground: true,
          toolProfile: "readonly-research",
        }),
      );

      expect(executeTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "execute_command",
          context: expect.objectContaining({
            mode: "code",
            toolProfile: "readonly-research",
            commandExecutionPolicy: "read-only",
          }),
        }),
      );
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

    it("injects a pending interjection instead of ending the turn at set_task_status", async () => {
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
              { type: "text", text: "All done." },
              {
                type: "tool_use",
                id: "call_final",
                name: "set_task_status",
                input: { status: "completed" },
              },
            ],
          };
          yield { type: "usage", inputTokens: 20, outputTokens: 5 };
          yield { type: "done" };
          return;
        }
        yield* makeProviderStream({ text: "continuing with follow up" });
      };

      const session = await makeSession();
      session.addUserMessage("do the task");
      const engine = new AgentEngine(makeRegistry(provider));
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
            // Simulate a message queued while the final tool was executing.
            session.setPendingInterjection("also fix the tests", "queue-1");
            request.context.onFinalStatus?.({
              status: "completed",
              source: "tool",
            });
          }
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
          };
        },
      );

      const events = await collectEvents(engine.run(session));

      // The final marker is still applied, but the turn continues with the
      // queued user message instead of stopping.
      expect(events.find((e) => e.type === "final_marker")).toBeDefined();
      const interjections = events.filter(
        (e): e is Extract<AgentEvent, { type: "user_interjection" }> =>
          e.type === "user_interjection",
      );
      expect(interjections.map((e) => e.queueId)).toEqual(["queue-1"]);
      expect(requests).toHaveLength(2);
      expect(requests[1].messages.at(-1)).toEqual({
        role: "user",
        content: "also fix the tests",
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

  describe("pending tool-turn persistence", () => {
    it("snapshots a provider-complete tool turn before dispatch and clears it after commit", async () => {
      let streamCall = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "content_blocks",
            blocks: [
              { type: "text", text: "I’ll inspect that." },
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
            blocks: [{ type: "text", text: "Done." }],
          };
        }
        yield { type: "usage", inputTokens: 20, outputTokens: 5 };
        yield { type: "done" };
      };

      const session = await makeSession();
      session.addUserMessage("inspect the file");
      const engine = new AgentEngine(makeRegistry(provider));
      engine.setToolRuntime({
        listTools: () => [
          {
            name: "read_file",
            description: "read",
            input_schema: { type: "object" },
          },
        ],
        isParallelSafe: () => true,
        executeTool: async () => ({
          content: [{ type: "text", text: "file contents" }],
        }),
      });
      const pendingSnapshots: AgentMessage[] = [];
      const canonicalCountsAtSnapshot: number[] = [];
      const committedTurns = vi.fn();

      await collectEvents(
        engine.run(session, {
          onPendingToolTurn: (assistantMessage) => {
            pendingSnapshots.push(assistantMessage);
            canonicalCountsAtSnapshot.push(session.messageCount);
          },
          onAssistantTurnCommitted: committedTurns,
        }),
      );

      expect(canonicalCountsAtSnapshot).toEqual([1]);
      expect(pendingSnapshots).toEqual([
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_use",
              id: "call_read",
            }),
          ]),
        }),
      ]);
      expect(committedTurns).toHaveBeenCalledTimes(2);
      expect(session.getAllMessages()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: [
              expect.objectContaining({
                type: "tool_result",
                tool_use_id: "call_read",
                content: "file contents",
              }),
            ],
          }),
        ]),
      );
    });
  });

  describe("pending question recovery arming", () => {
    const runAskUserTurn = async (blocks: CoreModelContentBlock[]) => {
      let streamCall = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "content_blocks", blocks };
        } else {
          yield {
            type: "content_blocks",
            blocks: [{ type: "text", text: "done" }],
          };
        }
        yield { type: "usage", inputTokens: 20, outputTokens: 5 };
        yield { type: "done" };
      };

      const session = await makeSession();
      session.addUserMessage("configure providers");
      const engine = new AgentEngine(makeRegistry(provider));
      const executeTool = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));
      engine.setToolRuntime({
        listTools: () => [
          {
            name: "ask_user",
            description: "ask the user",
            input_schema: { type: "object", properties: {} },
          },
          {
            name: "get_context",
            description: "read a file",
            input_schema: { type: "object", properties: {} },
          },
        ],
        isParallelSafe: () => true,
        executeTool,
      });
      await collectEvents(engine.run(session));
      return executeTool;
    };

    it("arms recovery for an ask_user call even when the turn has sibling tool calls", async () => {
      const executeTool = await runAskUserTurn([
        {
          type: "tool_use",
          id: "call_ctx",
          name: "get_context",
          input: { path: "a.ts" },
        },
        {
          type: "tool_use",
          id: "call_ask",
          name: "ask_user",
          input: { questions: [] },
        },
      ]);

      expect(executeTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "ask_user",
          context: expect.objectContaining({
            pendingQuestionRecovery: expect.objectContaining({
              toolUseId: "call_ask",
              toolName: "ask_user",
              assistantContent: [
                expect.objectContaining({ id: "call_ctx" }),
                expect.objectContaining({ id: "call_ask" }),
              ],
            }),
          }),
        }),
      );
    });

    it("does not arm recovery when a turn contains multiple ask_user calls", async () => {
      const executeTool = await runAskUserTurn([
        {
          type: "tool_use",
          id: "call_ask_1",
          name: "ask_user",
          input: { questions: [] },
        },
        {
          type: "tool_use",
          id: "call_ask_2",
          name: "ask_user",
          input: { questions: [] },
        },
      ]);

      for (const call of executeTool.mock.calls as unknown as Array<
        [AgentToolExecutionRequest]
      >) {
        expect(call[0].context.pendingQuestionRecovery).toBeUndefined();
      }
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

    it("preserves provider bridge replay while executing and rendering the canonical native tool", async () => {
      const streamCalls: StreamRequest[] = [];
      let streamCount = 0;
      const provider = makeMockProvider();
      const bridgeInput = {
        name: "get_call_hierarchy",
        input: {
          path: "src/file.ts",
          line: 1,
          column: 1,
          direction: "both",
        },
      };
      provider.stream = async function* (request: StreamRequest) {
        streamCalls.push(request);
        streamCount += 1;
        if (streamCount === 1) {
          yield {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id: "native-call-1",
                name: "call_native_tool",
                input: bridgeInput,
              },
            ],
          };
          yield { type: "usage", inputTokens: 10, outputTokens: 5 };
          yield { type: "done" };
          return;
        }
        yield* makeProviderStream({ text: "done" });
      };

      const session = await makeSession();
      session.addUserMessage("inspect the call graph");
      const engine = new AgentEngine(makeRegistry(provider));
      const executeTool = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "hierarchy" }],
      }));
      const toolCtx: ToolDispatchContext = {
        approvalManager: {} as ToolDispatchContext["approvalManager"],
        approvalPanel: {} as ToolDispatchContext["approvalPanel"],
        sessionId: "seed-session",
        extensionUri: {} as ToolDispatchContext["extensionUri"],
      };
      setEngineToolContext(engine, toolCtx, executeTool);

      const events = await collectEvents(engine.run(session));

      const providerToolNames = streamCalls[0]?.tools?.map((tool) => tool.name);
      expect(providerToolNames).toContain("call_native_tool");
      expect(providerToolNames).toContain("find_native_tools");
      expect(providerToolNames).not.toContain("get_call_hierarchy");
      expect(executeTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "get_call_hierarchy",
          input: bridgeInput.input,
          context: expect.objectContaining({
            providerToolName: "call_native_tool",
            providerToolInput: bridgeInput,
          }),
        }),
      );
      expect(
        events.filter(
          (event): event is Extract<AgentEvent, { type: "tool_start" }> =>
            event.type === "tool_start",
        ),
      ).toEqual([
        expect.objectContaining({
          toolCallId: "native-call-1",
          toolName: "get_call_hierarchy",
          input: bridgeInput.input,
        }),
      ]);
      expect(
        events.find(
          (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
            event.type === "tool_result" &&
            event.toolCallId === "native-call-1",
        ),
      ).toMatchObject({ toolName: "get_call_hierarchy" });

      const storedToolUse = session
        .getAllMessages()
        .flatMap((message) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .find(
          (block) => block.type === "tool_use" && block.id === "native-call-1",
        );
      expect(storedToolUse).toEqual({
        type: "tool_use",
        id: "native-call-1",
        name: "call_native_tool",
        input: bridgeInput,
      });
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

      // Two API turns × two listTools calls each (union advertisement plus
      // the current-mode dispatch gate set).
      expect(listCalls).toBe(4);
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

    it("advertises the mode union while gating dispatch to the current mode", async () => {
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
              { type: "tool_use", id: "call-1", name: "read_file", input: {} },
            ],
          };
          yield { type: "usage", inputTokens: 10, outputTokens: 5 };
          yield { type: "done" };
          return;
        }
        yield* makeProviderStream({ text: "done" });
      };

      const session = await AgentSession.createForLegacyCwd({
        mode: "ask",
        config: testConfig,
        cwd: "/test",
      });
      session.addUserMessage("look something up");
      const engine = new AgentEngine(makeRegistry(provider));
      const capturedGateSets: Array<ReadonlySet<string> | undefined> = [];
      engine.setToolRuntime({
        listTools: (request: { mode?: { slug: string } }) =>
          request.mode?.slug === "all-modes"
            ? [
                {
                  name: "read_file",
                  description: "read",
                  input_schema: { type: "object" },
                },
                {
                  name: "write_file",
                  description: "write",
                  input_schema: { type: "object" },
                },
              ]
            : [
                {
                  name: "read_file",
                  description: "read",
                  input_schema: { type: "object" },
                },
              ],
        isParallelSafe: () => true,
        executeTool: async (request: {
          context: { modeAllowedToolNames?: ReadonlySet<string> };
        }) => {
          capturedGateSets.push(request.context.modeAllowedToolNames);
          return { content: [{ type: "text", text: "ok" }] };
        },
      } as any);

      await collectEvents(engine.run(session));

      // The provider request advertises the union (cache-stable tool list)…
      const advertisedNames = streamCalls[0]?.tools?.map((t) => t.name) ?? [];
      expect(advertisedNames).toContain("write_file");
      // …while the dispatch seam receives the current mode's real allowance.
      expect(capturedGateSets).toHaveLength(1);
      expect(capturedGateSets[0]).toBeDefined();
      expect(capturedGateSets[0]!.has("read_file")).toBe(true);
      expect(capturedGateSets[0]!.has("write_file")).toBe(false);
      expect(capturedGateSets[0]!.has("todo_write")).toBe(true);
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

  describe("reasoning effort normalization", () => {
    it("downgrades an unsupported effort to the model default and logs it once", async () => {
      const capabilities: ModelCapabilities = {
        ...TEST_CAPABILITIES,
        supportsThinking: true,
        reasoningEfforts: ["none", "low", "medium", "high"],
        defaultReasoningEffort: "medium",
      };
      const provider = {
        ...makeMockProvider(),
        getCapabilities: () => capabilities,
      };
      const session = await makeSession();
      session.reasoningEffort = "max";
      session.addUserMessage("hello");
      const logs: string[] = [];
      const engine = new AgentEngine(makeRegistry(provider), (msg) =>
        logs.push(msg),
      );

      const events = await collectEvents(engine.run(session));

      const apiRequest = events.find((e) => e.type === "api_request");
      expect(apiRequest).toMatchObject({
        type: "api_request",
        reasoningEffort: "medium",
      });
      expect(logs.filter((msg) => msg.includes("reasoning effort"))).toEqual([
        `[agent] reasoning effort "max" is not supported by ${TEST_MODEL}; sending "medium" instead`,
      ]);
      expect(session.reasoningEffort).toBe("max");
    });

    it("does not log when the selected effort is supported", async () => {
      const capabilities: ModelCapabilities = {
        ...TEST_CAPABILITIES,
        supportsThinking: true,
        reasoningEfforts: ["none", "low", "medium", "high", "max"],
      };
      const provider = {
        ...makeMockProvider(),
        getCapabilities: () => capabilities,
      };
      const session = await makeSession();
      session.reasoningEffort = "max";
      session.addUserMessage("hello");
      const logs: string[] = [];
      const engine = new AgentEngine(makeRegistry(provider), (msg) =>
        logs.push(msg),
      );

      const events = await collectEvents(engine.run(session));

      const apiRequest = events.find((e) => e.type === "api_request");
      expect(apiRequest).toMatchObject({
        type: "api_request",
        reasoningEffort: "max",
      });
      expect(logs.filter((msg) => msg.includes("reasoning effort"))).toEqual(
        [],
      );
    });
  });

  describe("token accounting", () => {
    it("measures canonical mixed-media size separately from provider token pressure", () => {
      const content = toolResultToContent(
        {
          content: [
            { type: "text", text: "😀 caption" },
            { type: "image", data: "YWJj", mimeType: "image/png" },
          ],
        },
        "call-media",
        "call_mcp_tool",
      );
      expect(Array.isArray(content)).toBe(true);
      const measurement = measureToolResultContentForAttribution(content);

      expect(measurement.retainedContent).toBe(JSON.stringify(content));
      expect([...measurement.retainedContent].length).toBeLessThan(
        Buffer.byteLength(measurement.retainedContent, "utf8"),
      );
      expect(measurement.estimatedTokens).toBe(262);
    });

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
      const apiRequestStart = events.find(
        (event) => event.type === "api_request_start",
      );
      const apiRequest = events.find((e) => e.type === "api_request");
      expect(apiRequestStart).toMatchObject({
        type: "api_request_start",
        provider: "mock",
        model: TEST_MODEL,
        schedulerQueued: false,
      });
      expect(apiRequest).toBeDefined();
      if (!apiRequest || apiRequest.type !== "api_request") return;

      expect(apiRequest.inputTokens).toBe(10_050);
      expect(apiRequest.uncachedInputTokens).toBe(50);
      expect(apiRequest.cacheReadTokens).toBe(9000);
      expect(apiRequest.cacheCreationTokens).toBe(1000);
      expect(apiRequest.reasoningEffort).toBe("none");
      expect(apiRequest.providerQueueWaitMs).toBe(0);
      expect(session.lastInputTokens).toBe(10_050);
      expect(session.totalInputTokens).toBe(50);
      expect(session.totalCacheReadTokens).toBe(9000);
      expect(session.totalCacheCreationTokens).toBe(1000);
      expect(apiRequest.contextBreakdown?.prompt).toMatchObject({
        totalChars: 18,
        estimatedTokens: 5,
      });
    });

    it("reuses automatic memory request-locally across tool turns without persisting it", async () => {
      const requests: StreamRequest[] = [];
      let streamCount = 0;
      const provider = makeMockProvider();
      provider.stream = async function* (request: StreamRequest) {
        requests.push(request);
        request.onProviderRequestAttempt?.({ model: request.model });
        streamCount += 1;
        if (streamCount === 1) {
          yield {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id: "call-read-memory",
                name: "read_file",
                input: { path: "src/memory.ts" },
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
      session.addUserMessage("earlier stable question");
      session.appendAssistantTurn([
        { type: "text", text: "earlier stable answer" },
      ]);
      session.addUserMessage("follow the project preference");
      const canonicalBefore = structuredClone(session.getAllMessages());
      const engine = new AgentEngine(makeRegistry(provider));
      engine.setToolRuntime({
        listTools: () => [
          {
            name: "read_file",
            description: "read",
            input_schema: { type: "object" },
          },
        ],
        isParallelSafe: () => true,
        executeTool: async () => ({
          content: [{ type: "text", text: "file contents" }],
        }),
      });
      const automaticMemoryContext = Object.freeze({
        rendering:
          '<memory-evidence authority="low" instruction="false">\nStatement: Use focused tests.\n</memory-evidence>',
        estimatedTokens: 27,
        memoryCount: 1,
        query: "project preference",
        scopes: ["project", "global"] as const,
        authority: "low-authority-evidence" as const,
        canAuthorizeTools: false as const,
      });

      const events = await collectEvents(
        engine.run(session, { automaticMemoryContext }),
      );

      expect(requests).toHaveLength(2);
      for (const request of requests) {
        const stableQuestionIndex = request.messages.findIndex(
          (message) => message.content === "earlier stable question",
        );
        expect(stableQuestionIndex).toBeGreaterThanOrEqual(0);
        expect(request.messages[stableQuestionIndex + 1]).toEqual({
          role: "assistant",
          content: [{ type: "text", text: "earlier stable answer" }],
        });
        const currentUserIndex = request.messages.findIndex(
          (message) => message.content === "follow the project preference",
        );
        expect(currentUserIndex).toBeGreaterThan(0);
        expect(request.messages[currentUserIndex - 1]).toEqual({
          role: "user",
          content: automaticMemoryContext.rendering,
        });
      }
      expect(requests[1]!.messages.slice(0, 3)).toEqual(
        requests[0]!.messages.slice(0, 3),
      );
      const secondRequestToolUseIndex = requests[1]!.messages.findIndex(
        (message) =>
          message.role === "assistant" &&
          Array.isArray(message.content) &&
          message.content.some((block) => block.type === "tool_use"),
      );
      expect(secondRequestToolUseIndex).toBeGreaterThan(0);
      expect(requests[1]!.messages[secondRequestToolUseIndex + 1]).toEqual(
        expect.objectContaining({ role: "user" }),
      );
      expect(canonicalBefore).not.toContainEqual(
        expect.objectContaining({ content: automaticMemoryContext.rendering }),
      );
      expect(session.getAllMessages()).not.toContainEqual(
        expect.objectContaining({ content: automaticMemoryContext.rendering }),
      );
      const attributions = events.filter(
        (
          event,
        ): event is Extract<
          AgentEvent,
          { type: "request_context_attribution" }
        > => event.type === "request_context_attribution",
      );
      const apiRequests = events.filter(
        (event): event is Extract<AgentEvent, { type: "api_request" }> =>
          event.type === "api_request",
      );
      expect(attributions.map((event) => event.retrievedMemoryTokens)).toEqual([
        27, 27,
      ]);
      expect(
        attributions.map(
          (event) =>
            event.contextLedger?.layers.find(
              (layer) => layer.layer === "retrieved_context",
            )?.allocatedTokens,
        ),
      ).toEqual([27, 27]);
      expect(apiRequests.map((event) => event.retrievedMemoryTokens)).toEqual([
        27, 27,
      ]);
      expect(session.contextBreakdown.contextLedger).toEqual(
        apiRequests.at(-1)?.contextBreakdown?.contextLedger,
      );
    });

    it("retains large exact tool results by content and references only successful artifacts", async () => {
      const largeResult = "same large result\n".repeat(500);
      const changedResult = "changed large result\n".repeat(500);
      const smallResult = "small result";
      const calls = [
        { id: "call-first", path: "same.ts" },
        { id: "call-repeat", path: "same.ts" },
        { id: "call-changed", path: "changed.ts" },
        { id: "call-small", path: "small.ts" },
        { id: "call-media", path: "image.ts" },
      ];
      let streamCount = 0;
      const provider = makeMockProvider();
      provider.stream = async function* (request: StreamRequest) {
        request.onProviderRequestAttempt?.({ model: request.model });
        const call = calls[streamCount++];
        if (call) {
          yield {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id: call.id,
                name: "read_file",
                input: { path: call.path },
              },
            ],
          };
          yield { type: "usage", inputTokens: 20, outputTokens: 5 };
          yield { type: "done" };
          return;
        }
        yield* makeProviderStream({ text: "done" });
      };
      mocks.mockMkdir.mockResolvedValue(undefined);
      mocks.mockWriteFile.mockResolvedValue(undefined);

      const session = await makeSession();
      session.addUserMessage("read repeatedly");
      const engine = new AgentEngine(makeRegistry(provider));
      engine.setToolRuntime({
        listTools: () => [
          {
            name: "read_file",
            description: "read",
            input_schema: { type: "object" },
          },
        ],
        isParallelSafe: () => true,
        executeTool: async ({ context }) => {
          if (context.toolCallId === "call-changed") {
            return { content: [{ type: "text", text: changedResult }] };
          }
          if (context.toolCallId === "call-small") {
            return { content: [{ type: "text", text: smallResult }] };
          }
          if (context.toolCallId === "call-media") {
            return {
              content: [
                { type: "text", text: largeResult },
                {
                  type: "image",
                  data: "YWJj",
                  mimeType: "image/png",
                },
              ],
            };
          }
          return { content: [{ type: "text", text: largeResult }] };
        },
      });

      const events = await collectEvents(engine.run(session));
      const emittedResults = events.filter(
        (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
          event.type === "tool_result" && event.parentCallId === undefined,
      );
      const storedResults = session
        .getAllMessages()
        .flatMap((message) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .filter((block) => block.type === "tool_result");

      expect(storedResults).toHaveLength(5);
      expect(storedResults[0]?.content).toBe(largeResult);
      expect(storedResults[1]?.content).toMatch(
        /^\[Unchanged large tool result; exact content retained from read_file call call-first\.\]/,
      );
      expect(storedResults[1]?.content).toContain(
        "Full output: /tmp/agentlink-results/retained/",
      );
      expect(storedResults[1]?.content).toMatch(/SHA-256: [a-f0-9]{64}/);
      expect(storedResults[2]?.content).toBe(changedResult);
      expect(storedResults[3]?.content).toBe(smallResult);
      expect(Array.isArray(storedResults[4]?.content)).toBe(true);
      // Completion events remain responsive and carry the full UI result. The
      // ordered retained history form is finalized only before canonical commit.
      expect(emittedResults.map((event) => event.historyContent)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      expect(emittedResults[1]?.result).toEqual([
        { type: "text", text: largeResult },
      ]);
      expect(mocks.mockWriteFile).toHaveBeenCalledTimes(2);
      expect(mocks.mockWriteFile).toHaveBeenNthCalledWith(
        1,
        expect.stringMatching(
          /^\/tmp\/agentlink-results\/retained\/[a-f0-9-]+\/[a-f0-9]{64}\.txt$/,
        ),
        largeResult,
        { encoding: "utf-8", mode: 0o600 },
      );
      expect(mocks.mockWriteFile).toHaveBeenNthCalledWith(
        2,
        expect.stringMatching(
          /^\/tmp\/agentlink-results\/retained\/[a-f0-9-]+\/[a-f0-9]{64}\.txt$/,
        ),
        changedResult,
        { encoding: "utf-8", mode: 0o600 },
      );
      for (let index = 0; index < calls.length; index += 1) {
        const assistantIndex = index * 2 + 1;
        expect(session.getAllMessages()[assistantIndex]?.role).toBe(
          "assistant",
        );
        expect(session.getAllMessages()[assistantIndex + 1]?.role).toBe("user");
      }
    });

    it("chooses the first model-ordered parallel result as the retained source", async () => {
      const largeResult = "parallel exact result\n".repeat(500);
      let releaseFirst!: () => void;
      const firstCanFinish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const provider = makeMockProvider();
      let streamCount = 0;
      provider.stream = async function* (request: StreamRequest) {
        request.onProviderRequestAttempt?.({ model: request.model });
        if (streamCount++ === 0) {
          yield {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id: "call-model-first",
                name: "read_file",
                input: { path: "first.ts" },
              },
              {
                type: "tool_use",
                id: "call-finishes-first",
                name: "read_file",
                input: { path: "second.ts" },
              },
            ],
          };
          yield { type: "usage", inputTokens: 20, outputTokens: 5 };
          yield { type: "done" };
          return;
        }
        yield* makeProviderStream({ text: "done" });
      };
      mocks.mockMkdir.mockResolvedValue(undefined);
      mocks.mockWriteFile.mockResolvedValue(undefined);

      const completionOrder: string[] = [];
      const session = await makeSession();
      session.addUserMessage("read in parallel");
      const engine = new AgentEngine(makeRegistry(provider));
      engine.setToolRuntime({
        listTools: () => [
          {
            name: "read_file",
            description: "read",
            input_schema: { type: "object" },
          },
        ],
        isParallelSafe: () => true,
        executeTool: async ({ context }) => {
          if (context.toolCallId === "call-model-first") {
            await firstCanFinish;
            completionOrder.push("call-model-first");
          } else {
            completionOrder.push("call-finishes-first");
            releaseFirst();
          }
          return { content: [{ type: "text", text: largeResult }] };
        },
      });

      const events = await collectEvents(engine.run(session));
      const storedResults = session
        .getAllMessages()
        .flatMap((message) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .filter((block) => block.type === "tool_result");

      expect(completionOrder).toEqual([
        "call-finishes-first",
        "call-model-first",
      ]);
      expect(
        events
          .filter(
            (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
              event.type === "tool_result" && event.parentCallId === undefined,
          )
          .map((event) => event.toolCallId),
      ).toEqual(["call-finishes-first", "call-model-first"]);
      expect(storedResults[0]?.content).toBe(largeResult);
      expect(storedResults[1]?.content).toContain(
        "retained from read_file call call-model-first",
      );
      expect(mocks.mockWriteFile).toHaveBeenCalledTimes(1);
    });

    it("never deduplicates when retained artifact writes fail", async () => {
      const largeResult = "unavailable artifact\n".repeat(500);
      let streamCount = 0;
      const provider = makeMockProvider();
      provider.stream = async function* (request: StreamRequest) {
        request.onProviderRequestAttempt?.({ model: request.model });
        if (streamCount < 2) {
          const id = streamCount++ === 0 ? "call-first" : "call-repeat";
          yield {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id,
                name: "read_file",
                input: { path: "same.ts" },
              },
            ],
          };
          yield { type: "usage", inputTokens: 20, outputTokens: 5 };
          yield { type: "done" };
          return;
        }
        yield* makeProviderStream({ text: "done" });
      };
      mocks.mockMkdir.mockResolvedValue(undefined);
      mocks.mockWriteFile.mockRejectedValue(new Error("disk unavailable"));

      const session = await makeSession();
      session.addUserMessage("read repeatedly");
      const engine = new AgentEngine(makeRegistry(provider));
      engine.setToolRuntime({
        listTools: () => [
          {
            name: "read_file",
            description: "read",
            input_schema: { type: "object" },
          },
        ],
        isParallelSafe: () => true,
        executeTool: async () => ({
          content: [{ type: "text", text: largeResult }],
        }),
      });

      await collectEvents(engine.run(session));
      const storedResults = session
        .getAllMessages()
        .flatMap((message) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .filter((block) => block.type === "tool_result");

      expect(storedResults.map((block) => block.content)).toEqual([
        largeResult,
        largeResult,
      ]);
      expect(mocks.mockWriteFile).toHaveBeenCalledTimes(2);
    });

    it("clears retained-result deduplication after successful condensation", async () => {
      const largeResult = "pre-condense result\n".repeat(500);
      let streamCount = 0;
      const provider = makeMockProvider();
      provider.stream = async function* (request: StreamRequest) {
        request.onProviderRequestAttempt?.({ model: request.model });
        if (streamCount < 2) {
          const id = streamCount++ === 0 ? "call-before" : "call-after";
          yield {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id,
                name: "read_file",
                input: { path: "same.ts" },
              },
            ],
          };
          yield { type: "usage", inputTokens: 20, outputTokens: 5 };
          yield { type: "done" };
          return;
        }
        yield* makeProviderStream({ text: "done" });
      };
      mocks.mockMkdir.mockResolvedValue(undefined);
      mocks.mockWriteFile.mockResolvedValue(undefined);

      const session = await makeSession({
        ...testConfig,
        autoCondenseThreshold: 0.01,
      });
      session.addUserMessage("read across condensation");
      const engine = new AgentEngine(makeRegistry(provider));
      const condenseSpy = vi
        .spyOn(engine, "condenseSession")
        .mockImplementation(async function* () {
          yield { type: "condense_start", isAutomatic: true };
          yield {
            type: "condense",
            summary: "summary",
            prevInputTokens: 20,
            newInputTokens: 10,
          };
          return true;
        });
      engine.setToolRuntime({
        listTools: () => [
          {
            name: "read_file",
            description: "read",
            input_schema: { type: "object" },
          },
        ],
        isParallelSafe: () => true,
        executeTool: async () => ({
          content: [{ type: "text", text: largeResult }],
        }),
      });

      await collectEvents(engine.run(session));
      const storedResults = session
        .getAllMessages()
        .flatMap((message) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .filter((block) => block.type === "tool_result");

      expect(condenseSpy).toHaveBeenCalled();
      expect(storedResults.map((block) => block.content)).toEqual([
        largeResult,
        largeResult,
      ]);
      expect(mocks.mockWriteFile).toHaveBeenCalledTimes(2);
    });

    it("carries exact tool-result attribution through the next api_request", async () => {
      let streamCount = 0;
      const provider = makeMockProvider();
      provider.stream = async function* (request: StreamRequest) {
        streamCount += 1;
        request.onProviderRequestAttempt?.({ model: request.model });
        if (streamCount === 1) {
          yield {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id: "call-read",
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

      const session = await makeSession();
      session.addUserMessage("read the file");
      const engine = new AgentEngine(makeRegistry(provider));
      engine.setToolRuntime({
        listTools: () => [
          {
            name: "read_file",
            description: "read",
            input_schema: { type: "object" },
          },
        ],
        isParallelSafe: () => true,
        executeTool: async () => ({
          content: [{ type: "text", text: "😀".repeat(400) }],
        }),
      });

      const events = await collectEvents(engine.run(session));
      const apiRequests = events.filter(
        (event): event is Extract<AgentEvent, { type: "api_request" }> =>
          event.type === "api_request",
      );

      const requestAttributions = events.filter(
        (
          event,
        ): event is Extract<
          AgentEvent,
          { type: "request_context_attribution" }
        > => event.type === "request_context_attribution",
      );
      expect(apiRequests).toHaveLength(2);
      expect(requestAttributions).toHaveLength(2);
      expect(requestAttributions[1]).toMatchObject({
        requestKind: "agent",
        model: TEST_MODEL,
        toolResultContextAttributions: [
          {
            toolCallId: "call-read",
            toolName: "read_file",
            chars: 400,
            bytes: 1_600,
            estimatedTokens: 200,
          },
        ],
        omittedToolResultContextAttributions: 0,
        pinnedMemoryTokens: 0,
        retrievedMemoryTokens: 0,
      });
      expect(apiRequests[1]).toMatchObject({
        accumulatedEstimatedTokens: 200,
        accumulatedEstimatedTokensBySource: { "tool:read_file": 200 },
        toolResultContextAttributions: [
          {
            toolCallId: "call-read",
            toolName: "read_file",
            chars: 400,
            bytes: 1_600,
            estimatedTokens: 200,
          },
        ],
        omittedToolResultContextAttributions: 0,
        pinnedMemoryTokens: 0,
        retrievedMemoryTokens: 0,
      });
      expect(session.toolResultContextAttributions).toEqual([]);
      expect(session.omittedToolResultContextAttributions).toBe(0);
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
          expect.stringMatching(
            /^\[perf\] tool setup \d+ms tools=0 deferred=0 mcp=0$/,
          ),
          expect.stringMatching(/^\[perf\] getMessages \d+ms messages=1$/),
          expect.stringMatching(
            /^\[perf\] message assembly \d+ms apiMessages=2$/,
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

    it("exposes native web tools without passing hosted tools to the main request", async () => {
      const streamCalls: StreamRequest[] = [];
      const provider = makeMockProvider();
      provider.stream = async function* (request: StreamRequest) {
        streamCalls.push(request);
        yield* makeProviderStream();
      };
      const session = await makeSession();
      session.addUserMessage("search");
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
              name: "searxng__search",
              description: "Search",
              input_schema: { type: "object", properties: {} },
            },
          ],
          getServerConfig: () => ({ toolDisclosure: "inline" }),
        } as any,
      });

      await collectEvents(
        engine.run(session, {
          webAccessPolicy: {
            backend: "provider",
            available: true,
            routes: {
              search: {
                kind: "search",
                backend: "provider",
                available: true,
                reason: "native_selected",
                hostedTool: { type: "web_search" },
              },
              fetch: {
                kind: "fetch",
                backend: "disabled",
                available: false,
                reason: "disabled",
              },
            },
            settings: {
              searchBackend: "native",
              fetchBackend: "disabled",
              nativeSearchMode: "cached",
              allowedDomains: [],
              blockedDomains: [],
              maxSearchUsesPerTurn: 5,
              maxFetchUsesPerTurn: 3,
              maxFetchContentTokens: 25_000,
              maxReplayBytesPerTurn: 5_242_880,
            },
            hostedTools: [{ type: "web_search" }],
            enabledKinds: ["search"],
            diagnostics: {
              providerSearchSupported: true,
              providerFetchSupported: false,
              domainRestrictionsRequested: false,
              maxSearchUsesEnforced: false,
              maxFetchUsesEnforced: false,
              maxFetchContentTokensEnforced: false,
            },
          },
          mcpToolDefinitions: [],
          mcpToolDisclosure: {
            inlineTools: [],
            deferredTools: [],
            catalog: [],
          },
        }),
      );

      expect(streamCalls).toHaveLength(1);
      expect(streamCalls[0]?.hostedTools).toBeUndefined();
      expect(streamCalls[0]?.tools?.map((tool) => tool.name)).toContain(
        "web_search",
      );
      expect(streamCalls[0]?.tools?.map((tool) => tool.name)).not.toContain(
        "searxng__search",
      );
    });

    it("keeps hosted web details out of public events while preserving assistant content", async () => {
      const provider = makeMockProvider();
      provider.stream = async function* () {
        yield {
          type: "web_activity",
          activity: {
            id: "search-1",
            kind: "search",
            status: "started",
            backend: "provider",
            query: "AgentLink docs",
          },
        };
        yield {
          type: "web_activity",
          activity: {
            id: "search-1",
            kind: "search",
            status: "completed",
            backend: "provider",
            query: "AgentLink docs",
          },
        };
        yield { type: "text_delta", text: "Found it." };
        yield {
          type: "content_blocks",
          blocks: [
            {
              type: "text",
              text: "Found it.",
              citations: [
                {
                  url: "https://example.com/agentlink",
                  title: "AgentLink docs",
                  citedText: "Found it.",
                  startIndex: 0,
                  endIndex: 9,
                },
              ],
            },
          ],
        };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "done" };
      };
      const session = await makeSession();
      session.addUserMessage("search");
      const engine = new AgentEngine(makeRegistry(provider));

      const events = await collectEvents(engine.run(session));

      const publicEventTypes = events.map((event) => String(event.type));
      expect(publicEventTypes).not.toContain("web_activity");
      expect(publicEventTypes).not.toContain("web_citations");
      expect(session.getMessages().at(-1)).toMatchObject({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Found it.",
            citations: [
              expect.objectContaining({
                url: "https://example.com/agentlink",
                startIndex: 0,
                endIndex: 9,
              }),
            ],
          },
        ],
      });
    });

    it("preserves exact assistant replay and immediately continues pause_turn", async () => {
      const streamCalls: StreamRequest[] = [];
      const pausedMessage: AgentMessage = {
        role: "assistant",
        content: [
          {
            type: "web_activity",
            activity: {
              id: "srvtoolu_search",
              kind: "search",
              status: "started",
              backend: "provider",
              query: "AgentLink",
            },
          },
        ],
        providerReplay: {
          providerId: "anthropic",
          codecVersion: 1,
          payload: {
            content: [
              {
                type: "server_tool_use",
                id: "srvtoolu_search",
                name: "web_search",
                input: { query: "AgentLink" },
              },
            ],
          },
          serializedBytes: 1,
        },
      };
      const provider = makeMockProvider();
      provider.stream = async function* (request: StreamRequest) {
        streamCalls.push(request);
        if (streamCalls.length === 1) {
          yield {
            type: "content_blocks",
            blocks: pausedMessage.content as Exclude<
              AgentMessage["content"],
              string
            >,
          };
          yield {
            type: "model_stop",
            reason: "pause_turn",
            assistantMessage: pausedMessage,
          };
        } else {
          yield { type: "text_delta", text: "done" };
          yield {
            type: "content_blocks",
            blocks: [{ type: "text", text: "done" }],
          };
          yield {
            type: "model_stop",
            reason: "end_turn",
            assistantMessage: {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
            },
          };
        }
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "done" };
      };
      const session = await makeSession();
      session.addUserMessage("search");
      const engine = new AgentEngine(makeRegistry(provider));
      const committedTurns = vi.fn();
      await collectEvents(
        engine.run(session, {
          onAssistantTurnCommitted: committedTurns,
        }),
      );

      expect(streamCalls).toHaveLength(2);
      expect(committedTurns).toHaveBeenCalledTimes(2);
      expect(streamCalls[1].messages).toEqual([
        {
          role: "user",
          content: '<current_mode mode="mock">mock mode block</current_mode>',
        },
        { role: "user", content: "search" },
        pausedMessage,
      ]);
      expect(session.getAllMessages()).toEqual([
        { role: "user", content: "search" },
        pausedMessage,
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ]);
    });

    it("caps consecutive provider pause_turn continuations", async () => {
      const pausedMessage: AgentMessage = {
        role: "assistant",
        content: [
          {
            type: "web_activity",
            activity: {
              id: "srvtoolu_search",
              kind: "search",
              status: "started",
              backend: "provider",
              query: "AgentLink",
            },
          },
        ],
        providerReplay: {
          providerId: "anthropic",
          codecVersion: 1,
          payload: { encrypted_content: "private" },
          serializedBytes: 1,
        },
      };
      let streamCalls = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        streamCalls += 1;
        yield {
          type: "content_blocks",
          blocks: pausedMessage.content as Exclude<
            AgentMessage["content"],
            string
          >,
        };
        yield {
          type: "model_stop",
          reason: "pause_turn",
          assistantMessage: pausedMessage,
        };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "done" };
      };
      const session = await makeSession();
      session.addUserMessage("search");
      const engine = new AgentEngine(makeRegistry(provider));

      const events = await collectEvents(engine.run(session));

      expect(streamCalls).toBe(CORE_NATIVE_WEB_MAX_PAUSE_TURNS + 1);
      expect(
        session
          .getAllMessages()
          .filter((message) => message.role === "assistant"),
      ).toHaveLength(CORE_NATIVE_WEB_MAX_PAUSE_TURNS);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "error",
          error: `Provider native web continuation exceeded ${CORE_NATIVE_WEB_MAX_PAUSE_TURNS} pause turns.`,
          retryable: false,
        }),
      );
      expect(events.some((event) => event.type === "done")).toBe(false);
    });

    it("surfaces a safety refusal instead of retrying it as an empty response", async () => {
      let streamCalls = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        streamCalls += 1;
        yield { type: "content_blocks", blocks: [] };
        yield {
          type: "model_stop",
          reason: "refusal",
          assistantMessage: { role: "assistant", content: [] },
        };
        yield { type: "usage", inputTokens: 10, outputTokens: 0 };
        yield { type: "done" };
      };
      const session = await makeSession();
      session.addUserMessage("review this patch");
      const engine = new AgentEngine(makeRegistry(provider));

      const events = await collectEvents(engine.run(session));

      expect(streamCalls).toBe(1);
      expect(
        session
          .getAllMessages()
          .filter((message) => message.role === "assistant"),
      ).toHaveLength(0);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "warning",
          message: expect.stringContaining("declined this request"),
        }),
      );
    });

    it("closes dangling tool calls when a refusal interrupts mid-turn", async () => {
      const refusedMessage: AgentMessage = {
        role: "assistant",
        content: [
          { type: "text", text: "Starting the review" },
          { type: "tool_use", id: "tool_1", name: "read_file", input: {} },
        ],
      };
      const provider = makeMockProvider();
      provider.stream = async function* () {
        yield {
          type: "content_blocks",
          blocks: refusedMessage.content as Exclude<
            AgentMessage["content"],
            string
          >,
        };
        yield {
          type: "model_stop",
          reason: "refusal",
          assistantMessage: refusedMessage,
        };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "done" };
      };
      const session = await makeSession();
      session.addUserMessage("review this patch");
      const engine = new AgentEngine(makeRegistry(provider));

      const events = await collectEvents(engine.run(session));

      const serialized = JSON.stringify(session.getAllMessages());
      expect(serialized).toContain("Starting the review");
      expect(serialized).toContain('"tool_use_id":"tool_1"');
      expect(serialized).toContain("Not executed");
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "warning",
          message: expect.stringContaining("declined this request"),
        }),
      );
    });

    it("keeps a running turn on the model resolved at its boundary", async () => {
      const requests: StreamRequest[] = [];
      let streamCount = 0;
      const provider = makeMockProvider();
      provider.getCapabilities = (model: string) => {
        if (model !== TEST_MODEL) {
          throw new Error(`Unknown model "${model}" for provider "mock"`);
        }
        return TEST_CAPABILITIES;
      };
      provider.stream = async function* (request: StreamRequest) {
        requests.push(request);
        streamCount += 1;
        if (streamCount === 1) {
          session.model = "other-model";
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

      const session = await makeSession();
      session.addUserMessage("run one tool");
      const engine = new AgentEngine(makeRegistry(provider));
      engine.setToolRuntime({
        listTools: () => [
          {
            name: "read_file",
            description: "read",
            input_schema: { type: "object" },
          },
        ],
        isParallelSafe: () => true,
        executeTool: async () => ({
          content: [{ type: "text", text: "file contents" }],
        }),
      });

      const events = await collectEvents(engine.run(session));

      expect(requests.map((request) => request.model)).toEqual([
        TEST_MODEL,
        TEST_MODEL,
      ]);
      expect(
        events
          .filter((event) => event.type === "api_request")
          .map((event) => event.model),
      ).toEqual([TEST_MODEL, TEST_MODEL]);
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(session.model).toBe("other-model");
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

    it("awaits fallback prompt reconciliation before the next provider request", async () => {
      const requests: StreamRequest[] = [];
      const ordering: string[] = [];
      let streamCount = 0;
      const provider = makeMockProvider();
      provider.listModels = () =>
        ["gpt-5.6-luna", "gpt-5.4-mini"].map((id) => ({
          id,
          displayName: id,
          provider: provider.id,
          capabilities: TEST_CAPABILITIES,
        }));
      provider.stream = async function* (request: StreamRequest) {
        requests.push(request);
        streamCount += 1;
        if (streamCount === 1) {
          yield {
            type: "model_fallback",
            requestedModel: "gpt-5.6-luna",
            effectiveModel: "gpt-5.4-mini",
          };
          yield {
            type: "content_blocks",
            blocks: [
              {
                type: "tool_use",
                id: "fallback-tool",
                name: "read_file",
                input: { path: "README.md" },
              },
            ],
          };
          yield { type: "usage", inputTokens: 20, outputTokens: 5 };
          yield { type: "done" };
          return;
        }
        ordering.push("second-request");
        yield* makeProviderStream({ text: "done" });
      };
      const session = await makeSession();
      session.model = "gpt-5.6-luna";
      session.systemPrompt = "requested prompt";
      session.addUserMessage("read the file");
      const engine = new AgentEngine(makeRegistry(provider));
      engine.setToolRuntime({
        listTools: () => [
          {
            name: "read_file",
            description: "read",
            input_schema: { type: "object" },
          },
        ],
        isParallelSafe: () => true,
        executeTool: async () => ({
          content: [{ type: "text", text: "file contents" }],
        }),
      });

      await collectEvents(
        engine.run(session, {
          onModelFallback: async ({ effectiveModel }) => {
            await Promise.resolve();
            ordering.push(`reconciled:${effectiveModel}`);
            session.systemPrompt = "fallback prompt";
          },
        }),
      );

      expect(ordering).toEqual(["reconciled:gpt-5.4-mini", "second-request"]);
      expect(requests.map((request) => request.model)).toEqual([
        "gpt-5.6-luna",
        "gpt-5.4-mini",
      ]);
      expect(requests.map((request) => request.systemPrompt)).toEqual([
        "requested prompt",
        "fallback prompt",
      ]);
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
          content: '<current_mode mode="mock">mock mode block</current_mode>',
        },
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
      // messages[0] is the injected mode instruction block.
      expect(streamCalls[0]?.messages[1]).toEqual(expectedImageMessage);
      // Regression: the API is stateless, so the image must be re-sent after
      // the tool round-trip or the model loses access to it mid-conversation.
      expect(streamCalls[1]?.messages[1]).toEqual(expectedImageMessage);
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
      provider.stream = async function* (request: StreamRequest) {
        attempts += 1;
        request.onProviderRequestAttempt?.({ model: request.model });
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
        const requestAttributions = events.filter(
          (
            event,
          ): event is Extract<
            AgentEvent,
            { type: "request_context_attribution" }
          > => event.type === "request_context_attribution",
        );
        expect(requestAttributions).toHaveLength(3);
        expect(
          new Set(requestAttributions.map((event) => event.requestId)).size,
        ).toBe(3);
        for (const attribution of requestAttributions) {
          expect(attribution).toMatchObject({
            requestKind: "agent",
            model: TEST_MODEL,
            estimatedInputTokens: expect.any(Number),
          });
        }
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

    it("does not publish or charge a provisional tool call from an interrupted stream", async () => {
      let attempts = 0;
      const provider = makeMockProvider();
      provider.stream = async function* () {
        attempts += 1;
        if (attempts === 1) {
          yield {
            type: "tool_start",
            toolCallId: "partial-read",
            toolName: "read_file",
          };
          yield {
            type: "tool_input_delta",
            toolCallId: "partial-read",
            partialJson: '{"path":"src/Agent',
          };
          throw new Error("Connection error: stream terminated");
        }
        yield* makeProviderStream({ text: "Recovered without a tool" });
      };
      const timerSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((fn: TimerHandler) => {
          if (typeof fn === "function") fn();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        });

      try {
        const session = await makeSession();
        session.addUserMessage("inspect the code");
        const engine = new AgentEngine(makeRegistry(provider));

        const events = await collectEvents(engine.run(session));

        expect(attempts).toBe(2);
        expect(events.filter((event) => event.type === "tool_start")).toEqual(
          [],
        );
        expect(
          events.filter((event) => event.type === "tool_input_delta"),
        ).toEqual([]);
        expect(session.currentTool).toBeUndefined();
        expect(session.getLastAssistantText()).toBe("Recovered without a tool");
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

    it("aborts and retries a stream that stays transport-active but never yields events", async () => {
      let attempts = 0;
      const requestSignals: AbortSignal[] = [];
      const provider = makeMockProvider();
      provider.stream = async function* (request: StreamRequest) {
        attempts += 1;
        if (request.signal) requestSignals.push(request.signal);
        // Warm-but-dead stream: keepalive bytes flow, but no parsed events
        // ever arrive. Before the no-progress watchdog this hung forever.
        const heartbeat = setInterval(() => {
          request.onTransportActivity?.({
            kind: "body",
            at: Date.now(),
            bytes: 1,
          });
        }, 2);
        try {
          await new Promise((_, reject) => {
            request.signal?.addEventListener(
              "abort",
              () => reject(new Error("request aborted")),
              { once: true },
            );
          });
        } finally {
          clearInterval(heartbeat);
        }
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
          engine.run(session, { providerNoProgressTimeoutMs: 10 }),
        );
        const error = events.find((event) => event.type === "error");

        // Transport activity classifies these as stream failures:
        // 1 initial attempt + MAX_STREAM_RETRIES (5).
        expect(attempts).toBe(6);
        expect(requestSignals.every((signal) => signal.aborted)).toBe(true);
        expect(error).toEqual(
          expect.objectContaining({
            type: "error",
            retryable: true,
          }),
        );
        expect((error as { error?: string }).error).toContain("no progress");
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
    it("projects the complete first post-condense provider ledger", async () => {
      const originalTask = "original task ".repeat(200);
      const summary = "condensed summary ".repeat(80);
      const retainedFirstMessage: AgentMessage = {
        role: "user",
        content: originalTask,
        media: {
          images: [
            {
              name: "context.png",
              mimeType: "image/png",
              base64: "retained-image-data",
            },
          ],
          documents: [],
        },
      };
      mocks.mockSummarizeConversation.mockResolvedValueOnce({
        messages: [
          retainedFirstMessage,
          { role: "user", content: summary, isSummary: true },
        ],
        summary,
        prevInputTokens: 180_000,
        newInputTokens: 1,
        metadata: {
          inputMessageCount: 2,
          sourceUserMessageCount: 1,
          hadPriorSummaryInInput: false,
          sourceHash: "source-hash",
          providerId: "mock",
          condenseModel: "mock-fast",
          modelCandidates: ["mock-fast"],
          selectedModel: "mock-fast",
          latestUserMessage: originalTask,
          currentTask: originalTask,
          pendingTasks: [],
          canonicalUserMessages: [originalTask],
          requestMessageCount: 2,
          effectiveHistoryMessageCount: 2,
          effectiveHistoryRoles: ["user", "user:summary"],
        },
      });
      const runtimeTools: ToolDefinition[] = [
        {
          name: "read_file",
          description: "Read a project file",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
        {
          name: "linear__get_issue",
          description: "Fetch a Linear issue",
          input_schema: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
      ];
      const providerTools = [...runtimeTools, todoTool];
      const session = await makeSession();
      session.addUserMessage(originalTask, {
        images: retainedFirstMessage.media?.images,
      });
      const provider = makeMockProvider();
      const providerRequests: StreamRequest[] = [];
      provider.stream = async function* (request) {
        providerRequests.push(request);
        request.onProviderRequestAttempt?.({ model: request.model });
        yield* makeProviderStream();
      };
      const engine = new AgentEngine(makeRegistry(provider));

      const events = await collectEvents(
        engine.condenseSession(
          session,
          true,
          undefined,
          undefined,
          session.model,
          { tools: providerTools },
        ),
      );
      const condense = events.find(
        (event): event is Extract<AgentEvent, { type: "condense" }> =>
          event.type === "condense",
      );
      const projection = condense?.metadata?.postCondenseProjection;

      expect(projection).toBeDefined();
      expect(projection?.historyTokens).toBeGreaterThan(1);
      expect(projection?.toolTokens).toBeGreaterThan(0);
      expect(projection?.nativeToolTokens).toBeGreaterThan(0);
      expect(projection?.mcpToolTokens).toBeGreaterThan(0);
      expect(projection?.pinnedMemoryTokens).toBe(0);
      expect(projection?.retrievedMemoryTokens).toBe(0);
      expect(projection?.outputReservationTokens).toBe(8192);
      expect(projection?.safetyBufferTokens).toBe(9590);
      expect(projection?.estimatedInputTokens).toBeLessThan(
        (projection?.estimatedInputTokens ?? 0) +
          (projection?.outputReservationTokens ?? 0) +
          (projection?.safetyBufferTokens ?? 0),
      );
      expect(condense?.newInputTokens).toBe(projection?.estimatedInputTokens);
      expect(session.lastInputTokens).toBe(projection?.estimatedInputTokens);
      expect(
        session.getAllMessages()[1]?.uiHint?.condense?.newInputTokens,
      ).toBe(projection?.estimatedInputTokens);
      expect(session.getMessages()[0]?.content).toBe(originalTask);

      engine.setToolRuntime({
        listTools: () => runtimeTools,
        executeTool: vi.fn(),
        isParallelSafe: () => true,
      });
      const requestEvents = await collectEvents(engine.run(session));
      const requestAttribution = requestEvents.find(
        (
          event,
        ): event is Extract<
          AgentEvent,
          { type: "request_context_attribution" }
        > => event.type === "request_context_attribution",
      );
      expect(requestAttribution?.estimatedInputTokens).toBe(
        projection?.estimatedInputTokens,
      );
      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0]?.tools?.map((tool) => tool.name)).toEqual(
        providerTools.map((tool) => tool.name),
      );
      const retainedImageMessage = providerRequests[0]?.messages.find(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some(
            (block) =>
              block.type === "image" &&
              block.source.data === "retained-image-data",
          ),
      );
      expect(retainedImageMessage).toBeDefined();
    });

    it("clears stale token accounting after successful condense", async () => {
      mocks.mockSummarizeConversation.mockImplementation(async (options) => {
        options.onProviderRequest?.({
          requestId: "condense-request-1",
          model: "mock-fast",
          estimatedInputTokens: 11_000,
        });
        return {
          messages: [{ role: "user", content: "summary", isSummary: true }],
          summary: "summary",
          prevInputTokens: 180_000,
          newInputTokens: 12_000,
        };
      });

      const session = await makeSession();
      session.addUserMessage("hello");
      session.lastInputTokens = 180_000;
      session.lastOutputTokens = 5_000;
      session.lastCacheReadTokens = 100_000;
      session.addEstimatedTokens(120_000);
      session.addToolResultContextAttribution(
        "stale-call",
        "read_file",
        "stale result",
      );

      const engine = new AgentEngine(makeRegistry());
      const events = await collectEvents(engine.condenseSession(session, true));

      expect(events).toContainEqual({
        type: "request_context_attribution",
        requestId: "condense-request-1",
        requestKind: "condense",
        model: "mock-fast",
        estimatedInputTokens: 11_000,
        toolResultContextAttributions: [],
        omittedToolResultContextAttributions: 0,
        pinnedMemoryTokens: 0,
        retrievedMemoryTokens: 0,
      });
      const condense = events.find(
        (event): event is Extract<AgentEvent, { type: "condense" }> =>
          event.type === "condense",
      );
      expect(condense).toBeDefined();
      expect(condense?.newInputTokens).not.toBe(12_000);
      expect(condense?.metadata?.postCondenseProjection).toBeDefined();
      expect(
        condense?.metadata?.postCondenseProjection?.estimatedInputTokens,
      ).toBe(condense?.newInputTokens);
      expect(session.lastInputTokens).toBe(condense?.newInputTokens);
      expect(session.lastOutputTokens).toBe(0);
      expect(session.lastCacheReadTokens).toBe(0);
      expect(session.estimatedAccumulatedTokens).toBe(0);
      expect(session.estimatedAccumulationBySource).toEqual({});
      expect(session.toolResultContextAttributions).toEqual([]);
      expect(session.omittedToolResultContextAttributions).toBe(0);
      expect(session.estimatedInputUsed).toBe(condense?.newInputTokens);
    });

    it("admits foreground condense immediately on a saturated provider and releases its permit", async () => {
      mocks.mockSummarizeConversation.mockResolvedValue({
        messages: [{ role: "user", content: "summary", isSummary: true }],
        summary: "summary",
        prevInputTokens: 1000,
        newInputTokens: 100,
      });
      const registry = makeRegistry();
      registry.requestScheduler.setMaxConcurrentPerProvider(1);
      const blocker = await registry.requestScheduler.acquire(
        "mock",
        "background",
      );
      const session = await makeSession();
      session.addUserMessage("hello");
      const phases: Array<"queued_for_provider" | "running"> = [];
      const engine = new AgentEngine(registry);

      // Foreground condense is interactive-priority work: it bypasses the
      // provider cap instead of waiting behind the background permit.
      await collectEvents(
        engine.condenseSession(
          session,
          true,
          undefined,
          undefined,
          session.model,
          {
            signal: new AbortController().signal,
            onProviderAdmissionPhase: (phase) => phases.push(phase),
          },
        ),
      );
      expect(phases).toEqual(["running", "running"]);
      expect(mocks.mockSummarizeConversation).toHaveBeenCalledTimes(1);

      blocker.release();
      const nextPermit = await registry.requestScheduler.acquire(
        "mock",
        "background",
      );
      expect(nextPermit.queued).toBe(false);
      nextPermit.release();
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
