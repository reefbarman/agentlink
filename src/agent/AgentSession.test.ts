import type { AgentConfig, AgentMessage } from "./types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPromptArtifacts, buildSystemPrompt } from "./systemPrompt.js";

import { AgentSession } from "./AgentSession.js";
import type { ContentBlock } from "./providers/types.js";
import type { SessionProjectScope } from "../core/workspaceProjects.js";

function makePromptArtifacts(systemPrompt: string) {
  return {
    systemPrompt,
    skills: [],
    advertisedRules: [],
    promptBreakdown: {
      sections: [
        { label: "test", chars: systemPrompt.length, estimatedTokens: 1 },
      ],
      totalChars: systemPrompt.length,
      estimatedTokens: 1,
    },
  };
}

// Mock prompt builders so create() doesn't hit the filesystem
vi.mock("./systemPrompt.js", () => {
  const buildSystemPromptMock = vi.fn().mockResolvedValue("mock system prompt");
  const buildPromptArtifactsMock = vi
    .fn()
    .mockResolvedValue(makePromptArtifacts("mock system prompt"));
  return {
    buildSystemPrompt: buildSystemPromptMock,
    buildPromptArtifacts: buildPromptArtifactsMock,
  };
});

const mockedBuildSystemPrompt = vi.mocked(buildSystemPrompt);
const mockedBuildPromptArtifacts = vi.mocked(buildPromptArtifacts);

const testProjectScope: SessionProjectScope = {
  schemaVersion: 1,
  kind: "project",
  projectId: "project-test",
  workspaceFolderUri: "file:///test",
  displayName: "test",
  rootPath: "/test",
};

const testConfig: AgentConfig = {
  model: "claude-sonnet-4-6",
  maxTokens: 8192,
  thinkingBudget: 0,
  showThinking: false,
  autoCondense: true,
  autoCondenseThreshold: 0.9,
};

async function makeSession(
  opts: Partial<Parameters<typeof AgentSession.createForLegacyCwd>[0]> = {},
): Promise<AgentSession> {
  return AgentSession.createForLegacyCwd({
    mode: "code",
    config: testConfig,
    cwd: "/test",
    ...opts,
  });
}

describe("AgentSession", () => {
  beforeEach(() => {
    mockedBuildSystemPrompt.mockClear();
    mockedBuildPromptArtifacts.mockClear();
    mockedBuildSystemPrompt.mockResolvedValue("mock system prompt");
    mockedBuildPromptArtifacts.mockResolvedValue(
      makePromptArtifacts("mock system prompt"),
    );
  });

  describe("creation", () => {
    it("starts with no messages", async () => {
      const session = await makeSession();
      expect(session.getMessages()).toHaveLength(0);
      expect(session.messageCount).toBe(0);
    });

    it("assigns a unique id", async () => {
      const a = await makeSession();
      const b = await makeSession();
      expect(a.id).not.toBe(b.id);
      expect(a.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("owns an immutable project scope and derives its root from that scope", async () => {
      const session = await AgentSession.create({
        mode: "code",
        config: testConfig,
        projectScope: testProjectScope,
      });

      expect(session.projectScope).toEqual(testProjectScope);
      expect(session.requireProjectRoot()).toBe("/test");
      expect(Object.isFrozen(session.projectScope)).toBe(true);
      expect(() => {
        (session.projectScope as { displayName: string }).displayName =
          "changed";
      }).toThrow();
    });

    it("restores unavailable transcripts without assembling a prompt or inventing a root", () => {
      const unavailableScope: SessionProjectScope = {
        ...testProjectScope,
        rootPath: undefined,
      };
      const session = AgentSession.createTranscriptOnly({
        mode: "code",
        config: testConfig,
        projectScope: unavailableScope,
        projectAvailability: "missing",
      });

      expect(session.systemPrompt).toBe("");
      expect(session.contextBreakdown.prompt.sections).toEqual([]);
      expect(mockedBuildPromptArtifacts).not.toHaveBeenCalled();
      expect(() => session.requireProjectRoot()).toThrow(
        "Project 'test' is unavailable for local execution.",
      );
    });

    it("refuses executable construction for a scope without an available root", async () => {
      await expect(
        AgentSession.create({
          mode: "code",
          config: testConfig,
          projectScope: { ...testProjectScope, rootPath: undefined },
        }),
      ).rejects.toThrow("Project 'test' is unavailable for local execution.");
      expect(mockedBuildPromptArtifacts).not.toHaveBeenCalled();
    });

    it("stores the mode and model", async () => {
      const session = await makeSession({ mode: "ask" });
      expect(session.mode).toBe("ask");
      expect(session.model).toBe("claude-sonnet-4-6");
    });

    it("uses the system prompt from buildSystemPrompt", async () => {
      const session = await makeSession();
      expect(session.systemPrompt).toBe("mock system prompt");
    });

    it("defaults background to false", async () => {
      const session = await makeSession();
      expect(session.background).toBe(false);
    });

    it("sets background flag when specified", async () => {
      const session = await makeSession({ background: true });
      expect(session.background).toBe(true);
    });

    it("starts with idle status", async () => {
      const session = await makeSession();
      expect(session.status).toBe("idle");
    });

    it("starts with New Chat title", async () => {
      const session = await makeSession();
      expect(session.title).toBe("New Chat");
    });

    it("stores providerId when specified", async () => {
      const session = await makeSession({ providerId: "codex" });
      expect(session.providerId).toBe("codex");
    });

    it("providerId is undefined when not specified", async () => {
      const session = await makeSession();
      expect(session.providerId).toBeUndefined();
    });

    it("passes MCP disclosure catalog to buildPromptArtifacts and stores the snapshot", async () => {
      const mcpToolDisclosure = {
        inlineTools: [],
        deferredTools: [],
        catalog: [
          {
            serverName: "linear",
            toolCount: 46,
            estimatedTokens: 10_214,
            representativeTools: ["list_issues"],
          },
        ],
      };

      const session = await makeSession({ mcpToolDisclosure });

      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "code",
        "/test",
        expect.objectContaining({
          mcpToolCatalog: mcpToolDisclosure.catalog,
        }),
      );
      expect(session.mcpToolDisclosure).toBe(mcpToolDisclosure);
    });

    it("passes providerId to buildPromptArtifacts on create", async () => {
      await makeSession({ providerId: "codex" });
      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "code",
        "/test",
        expect.objectContaining({ providerId: "codex" }),
      );
    });

    it("defaults autoCondenseThreshold to 0.9 when not provided", async () => {
      const configWithoutThreshold: AgentConfig = {
        ...testConfig,
        autoCondenseThreshold: undefined as unknown as number,
      };
      const session = await AgentSession.createForLegacyCwd({
        mode: "code",
        config: configWithoutThreshold,
        cwd: "/test",
      });
      expect(session.autoCondenseThreshold).toBe(0.9);
    });

    it("defaults codexStatefulResponses to true when not provided", async () => {
      const session = await makeSession();
      expect(session.codexStatefulResponses).toBe(true);
    });

    it("defaults codexStoreResponses to false when not provided", async () => {
      const session = await makeSession();
      expect(session.codexStoreResponses).toBe(false);
    });

    it("stores codexStoreResponses when configured", async () => {
      const session = await makeSession({
        config: { ...testConfig, codexStoreResponses: true },
      });
      expect(session.codexStoreResponses).toBe(true);
    });
  });

  describe("messages", () => {
    it("clears active skill tool restrictions when a new user message starts", async () => {
      mockedBuildPromptArtifacts.mockResolvedValue({
        ...makePromptArtifacts("mock system prompt"),
        skills: [
          {
            name: "safe-review",
            description: "Safe review",
            skillPath: "/test/.agentlink/skills/safe-review/SKILL.md",
            allowedTools: ["read_file"],
          },
        ],
      });
      const session = await makeSession();

      session.trackLoadedSkill("safe-review");
      expect(session.getActiveSkillAllowedTools()).toEqual(["read_file"]);

      session.addUserMessage("new task");
      expect(session.getActiveSkillAllowedTools()).toBeUndefined();
      expect(session.getLoadedSkills()).toEqual(["safe-review"]);
    });

    it("addUserMessage appends a user message", async () => {
      const session = await makeSession();
      session.addUserMessage("hello");
      const messages = session.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ role: "user", content: "hello" });
    });

    it("persists user-message origin metadata in uiHint", async () => {
      const session = await makeSession();
      session.addUserMessage("hello from phone", { origin: "browser" });
      const messages = session.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        role: "user",
        content: "hello from phone",
        uiHint: {
          userMessage: {
            origin: "browser",
          },
        },
      });
    });

    it("appendAssistantTurn appends an assistant message", async () => {
      const session = await makeSession();
      const blocks: ContentBlock[] = [{ type: "text", text: "response" }];
      session.appendAssistantTurn(blocks);
      const messages = session.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ role: "assistant", content: blocks });
    });

    it("appendAssistantMessage preserves provider-private replay", async () => {
      const session = await makeSession();
      const message: AgentMessage = {
        role: "assistant",
        content: [{ type: "text", text: "response" }],
        providerReplay: {
          providerId: "anthropic",
          codecVersion: 1,
          payload: {
            content: [
              {
                type: "server_tool_use",
                id: "srvtoolu_1",
                name: "web_search",
                input: { query: "AgentLink" },
              },
            ],
          },
          serializedBytes: 1,
        },
      };

      session.appendAssistantMessage(message);

      expect(session.getMessages()).toEqual([message]);
      expect(session.getMessages()[0]).toBe(message);
    });

    it("appendToolResults appends tool results as a user message", async () => {
      const session = await makeSession();
      session.appendAssistantTurn([
        { type: "tool_use", id: "tu_123", name: "read_file", input: {} },
      ]);
      const results: Parameters<typeof session.appendToolResults>[0] = [
        {
          type: "tool_result" as const,
          tool_use_id: "tu_123",
          content: "file contents",
          mcpApprovalPromotion: {
            serverName: "linear",
            bareToolName: "list_issues",
            scopes: ["session", "project", "global"] as const,
          },
        },
      ];
      session.appendToolResults(results);
      const messages = session.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[1]).toEqual({ role: "user", content: results });
    });

    it("getMessages drops tool results whose tool_use is missing from the prior assistant turn", async () => {
      const session = await makeSession();
      session.appendToolResults([
        {
          type: "tool_result" as const,
          tool_use_id: "tu_orphan",
          content: "stale",
        },
      ]);
      expect(session.getMessages()).toHaveLength(0);
      // Raw history is untouched — only the API view is sanitized.
      expect(session.getAllMessages()).toHaveLength(1);
    });

    it("messageCount reflects added messages", async () => {
      const session = await makeSession();
      expect(session.messageCount).toBe(0);
      session.addUserMessage("one");
      expect(session.messageCount).toBe(1);
      session.appendAssistantTurn([{ type: "text", text: "two" }]);
      expect(session.messageCount).toBe(2);
    });

    it("getMessages returns all messages in order", async () => {
      const session = await makeSession();
      session.addUserMessage("user msg");
      session.appendAssistantTurn([{ type: "text", text: "assistant msg" }]);
      const msgs = session.getMessages();
      expect(msgs[0].role).toBe("user");
      expect(msgs[1].role).toBe("assistant");
    });

    it("keeps runtime errors in full history but excludes them from provider history", async () => {
      const session = await makeSession();
      session.addUserMessage("user msg");
      session.appendRuntimeError({
        message:
          "Codex API error: An error occurred while processing your request.",
        retryable: true,
      });

      expect(session.getAllMessages()).toHaveLength(2);
      expect(session.getAllMessages()[1]?.runtimeError).toEqual({
        message:
          "Codex API error: An error occurred while processing your request.",
        retryable: true,
      });

      const msgs = session.getMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toEqual({ role: "user", content: "user msg" });
    });

    it("dedupes consecutive identical runtime errors", async () => {
      const session = await makeSession();
      session.appendRuntimeError({ message: "same error", retryable: false });
      session.appendRuntimeError({ message: "same error", retryable: true });

      expect(session.getAllMessages()).toHaveLength(1);
      expect(session.getAllMessages()[0]?.runtimeError).toEqual({
        message: "same error",
        retryable: true,
      });
    });

    it("injects canonical resume context into provider history after a condense summary", async () => {
      const session = await makeSession();
      session.replaceMessages([
        {
          role: "user",
          isSummary: true,
          condenseId: "condense-1",
          preservedContext: {
            toolNames: ["read_file"],
            mcpServerNames: ["linear"],
          },
          content: [
            {
              type: "text",
              text: '<system-reminder>\n## Resume Anchor (deterministic)\n- Latest user message: "Fix issue"\n- Continue from this task: "Fix issue"\n\n## Canonical User Messages (deterministic)\n1. "Fix issue"\n\n## Pending Tasks (deterministic heuristic)\n- Fix issue\n\n## Preserved Runtime Context (reattached outside transcript)\n### Available tool names\n- read_file\n\n### MCP servers with exposed tools\n- linear\n</system-reminder>',
            },
            { type: "text", text: "## Conversation Summary\n\nSummary body" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Need a bit more context." }],
        },
        { role: "user", content: "Continue fixing the issue." },
      ]);

      const msgs = session.getMessages();
      expect(msgs).toHaveLength(4);
      expect(msgs[0]?.isSummary).toBe(true);
      expect(msgs[1]?.role).toBe("assistant");
      expect(msgs[2]?.role).toBe("user");
      expect(msgs[2]?.isResumeContext).toBe(true);
      expect(Array.isArray(msgs[2]?.content)).toBe(true);
      const injected = msgs[2]?.content as Array<{
        type: string;
        text?: string;
      }>;
      expect(injected[0]?.text).toContain("## Resume Anchor (deterministic)");
      expect(msgs[3]).toEqual({
        role: "user",
        content: "Continue fixing the issue.",
      });
    });
  });

  describe("autoTitle", () => {
    it("sets title from first user message text", async () => {
      const session = await makeSession();
      session.addUserMessage("Fix the login bug");
      session.autoTitle();
      expect(session.title).toBe("Fix the login bug");
    });

    it("truncates long messages to 80 chars", async () => {
      const session = await makeSession();
      const longMsg = "x".repeat(100);
      session.addUserMessage(longMsg);
      session.autoTitle();
      expect(session.title).toHaveLength(80);
    });

    it("omits attachment markers from generated title", async () => {
      const session = await makeSession();
      session.addUserMessage(
        "Fix this regression\n[Attached: src/app.ts]\n[Attached: README.md]",
      );
      session.autoTitle();
      expect(session.title).toBe("Fix this regression");
    });

    it("omits injected file blocks and file contents from generated title", async () => {
      const session = await makeSession();
      session.addUserMessage(
        `<file path="src/secret.ts">\n\`\`\`ts\nconst token = "abc123";\n\`\`\`\n</file>\n\nSummarize the bug and propose a fix`,
      );
      session.autoTitle();
      expect(session.title).toBe("Summarize the bug and propose a fix");
    });

    it("keeps default title when sanitized text is empty", async () => {
      const session = await makeSession();
      session.addUserMessage(
        `<file path="src/only.ts">\n\`\`\`ts\nexport const x = 1;\n\`\`\`\n</file>`,
      );
      session.autoTitle();
      expect(session.title).toBe("New Chat");
    });

    it("does nothing when there are no messages", async () => {
      const session = await makeSession();
      session.autoTitle();
      expect(session.title).toBe("New Chat");
    });

    it("does nothing when first message has non-string content", async () => {
      const session = await makeSession();
      session.appendAssistantTurn([{ type: "text", text: "hello" }]);
      session.autoTitle();
      expect(session.title).toBe("New Chat");
    });
  });

  describe("token tracking", () => {
    it("starts at zero", async () => {
      const session = await makeSession();
      expect(session.totalInputTokens).toBe(0);
      expect(session.totalOutputTokens).toBe(0);
    });

    it("accumulates across multiple calls", async () => {
      const session = await makeSession();
      session.addUsage(100, 50);
      session.addUsage(200, 75);
      expect(session.totalInputTokens).toBe(300);
      expect(session.totalOutputTokens).toBe(125);
    });

    it("lastInputTokens includes cache tokens for context window tracking", async () => {
      const session = await makeSession();
      // Simulate an API response where most tokens were cache reads:
      // input_tokens=50 (uncached), cache_read=9000, cache_creation=1000
      session.addUsage(50, 200, 9000, 1000);
      // lastInputTokens should be the TOTAL context window usage
      expect(session.lastInputTokens).toBe(50 + 9000 + 1000);
      // totalInputTokens accumulates just the raw API input_tokens (uncached)
      expect(session.totalInputTokens).toBe(50);
      expect(session.lastCacheReadTokens).toBe(9000);
    });

    it("tracks projected input separately from output-inclusive total usage", async () => {
      const session = await makeSession();
      session.addUsage(1000, 500, 200, 300);
      session.addEstimatedTokens(400);

      expect(session.estimatedInputUsed).toBe(1600);
      expect(session.estimatedTotalUsed).toBe(2100);
    });

    it("attributes estimated accumulation per source and resets on fresh usage", async () => {
      const session = await makeSession();
      session.addEstimatedTokens(400, "tool:read_file");
      session.addEstimatedTokens(800, "tool:read_file");
      session.addEstimatedTokens(400);

      // 4 chars ≈ 1 token
      expect(session.estimatedAccumulationBySource).toEqual({
        "tool:read_file": 300,
        other: 100,
      });
      expect(session.estimatedAccumulatedTokens).toBe(400);

      session.addUsage(1000, 500);
      expect(session.estimatedAccumulatedTokens).toBe(0);
      expect(session.estimatedAccumulationBySource).toEqual({});
    });

    it("restoreFromStore restores cache totals and last token snapshot", async () => {
      const session = await makeSession();
      session.restoreFromStore({
        id: "session-1",
        title: "Restored",
        createdAt: 1,
        lastActiveAt: 2,
        totalInputTokens: 100,
        totalOutputTokens: 200,
        totalCacheReadTokens: 300,
        totalCacheCreationTokens: 400,
        lastInputTokens: 500,
        lastCacheReadTokens: 600,
        messages: [{ role: "user", content: "hello" }],
      });

      expect(session.totalInputTokens).toBe(100);
      expect(session.totalOutputTokens).toBe(200);
      expect(session.totalCacheReadTokens).toBe(300);
      expect(session.totalCacheCreationTokens).toBe(400);
      expect(session.lastInputTokens).toBe(500);
      expect(session.lastCacheReadTokens).toBe(600);
    });

    it("restoreFromStore defaults cache and last-token fields for older data", async () => {
      const session = await makeSession();
      session.restoreFromStore({
        id: "session-2",
        title: "Restored",
        createdAt: 1,
        lastActiveAt: 2,
        totalInputTokens: 10,
        totalOutputTokens: 20,
        messages: [{ role: "user", content: "hello" }],
      });

      expect(session.totalCacheReadTokens).toBe(0);
      expect(session.totalCacheCreationTokens).toBe(0);
      expect(session.lastInputTokens).toBe(0);
      expect(session.lastCacheReadTokens).toBe(0);
    });
  });

  describe("mode switching", () => {
    it("setMode updates mode metadata and preserves message history", async () => {
      const session = await makeSession({ mode: "code" });
      session.addUserMessage("keep this context");
      const priorMessageCount = session.messageCount;

      mockedBuildPromptArtifacts.mockResolvedValueOnce(
        makePromptArtifacts("mock ask prompt"),
      );
      await session.setMode("ask");

      expect(session.mode).toBe("ask");
      expect(session.agentMode.slug).toBe("ask");
      expect(session.systemPrompt).toBe("mock ask prompt");
      expect(session.messageCount).toBe(priorMessageCount);
      expect(session.getMessages()[0]).toEqual({
        role: "user",
        content: "keep this context",
      });
    });

    it("setMode preserves pinned active-file context and its diagnostic", async () => {
      const activeFilePath = "/test/src/index.ts";
      const session = await makeSession({ activeFilePath });
      mockedBuildPromptArtifacts.mockClear();
      mockedBuildPromptArtifacts.mockResolvedValueOnce({
        ...makePromptArtifacts("mock ask prompt"),
        activeFileContext: {
          status: "accepted",
          activeFilePath,
        },
      });

      await session.setMode("ask");

      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "ask",
        "/test",
        expect.objectContaining({ activeFilePath }),
      );
      expect(session.activeFileContext).toEqual({
        status: "accepted",
        activeFilePath,
      });
    });

    it("setMode passes stored providerId to buildPromptArtifacts", async () => {
      const session = await makeSession({ providerId: "codex" });
      mockedBuildPromptArtifacts.mockClear();
      mockedBuildPromptArtifacts.mockResolvedValueOnce(
        makePromptArtifacts("mock ask prompt"),
      );
      await session.setMode("ask");
      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "ask",
        "/test",
        expect.objectContaining({ providerId: "codex" }),
      );
    });

    it("setMode preserves background prompt identity", async () => {
      const session = await makeSession({
        background: true,
        isBackground: true,
      });
      mockedBuildPromptArtifacts.mockClear();

      await session.setMode("debug");

      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "debug",
        "/test",
        expect.objectContaining({ isBackground: true }),
      );
    });
  });

  describe("rebuildSystemPrompt", () => {
    it("passes stored providerId to buildPromptArtifacts", async () => {
      const session = await makeSession({ providerId: "codex" });
      mockedBuildPromptArtifacts.mockClear();
      mockedBuildPromptArtifacts.mockResolvedValueOnce(
        makePromptArtifacts("rebuilt prompt"),
      );
      await session.rebuildSystemPrompt();
      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "code",
        "/test",
        expect.objectContaining({ providerId: "codex" }),
      );
      expect(session.systemPrompt).toBe("rebuilt prompt");
    });

    it("preserves background prompt identity", async () => {
      const session = await makeSession({
        background: true,
        isBackground: true,
      });
      mockedBuildPromptArtifacts.mockClear();

      await session.rebuildSystemPrompt();

      expect(mockedBuildPromptArtifacts).toHaveBeenCalledWith(
        "code",
        "/test",
        expect.objectContaining({ isBackground: true }),
      );
    });
  });

  describe("abort", () => {
    it("starts not aborted", async () => {
      const session = await makeSession();
      expect(session.isAborted).toBe(false);
    });

    it("abortSignal is undefined before createAbortController", async () => {
      const session = await makeSession();
      expect(session.abortSignal).toBeUndefined();
    });

    it("creates an AbortController and exposes the signal", async () => {
      const session = await makeSession();
      const ac = session.createAbortController();
      expect(ac).toBeInstanceOf(AbortController);
      expect(session.abortSignal).toBe(ac.signal);
      expect(session.isAborted).toBe(false);
    });

    it("abort() signals the controller", async () => {
      const session = await makeSession();
      session.createAbortController();
      expect(session.isAborted).toBe(false);
      session.abort();
      expect(session.isAborted).toBe(true);
    });

    it("isAborted is false after abort() when no controller was created", async () => {
      const session = await makeSession();
      session.abort(); // no-op
      expect(session.isAborted).toBe(false);
    });
  });

  describe("pending interjections", () => {
    it("accepts multiple interjections and consumes them FIFO", async () => {
      const session = await makeSession();
      expect(session.setPendingInterjection("first", "q1")).toBe(true);
      expect(session.setPendingInterjection("second", "q2")).toBe(true);
      expect(session.setPendingInterjection("third", "q3")).toBe(true);

      expect(session.consumePendingInterjection()?.text).toBe("first");
      expect(session.consumePendingInterjection()?.text).toBe("second");
      expect(session.consumePendingInterjection()?.text).toBe("third");
      expect(session.consumePendingInterjection()).toBeNull();
    });

    it("re-registering an existing queueId replaces the entry in place", async () => {
      const session = await makeSession();
      session.setPendingInterjection("first", "q1");
      session.setPendingInterjection("second", "q2");
      session.setPendingInterjection("first edited", "q1");

      const first = session.consumePendingInterjection();
      expect(first?.queueId).toBe("q1");
      expect(first?.text).toBe("first edited");
      expect(session.consumePendingInterjection()?.queueId).toBe("q2");
      expect(session.consumePendingInterjection()).toBeNull();
    });

    it("updatePendingInterjection edits only the matching entry", async () => {
      const session = await makeSession();
      session.setPendingInterjection("first", "q1");
      session.setPendingInterjection("second", "q2");

      expect(session.updatePendingInterjection("q2", { text: "edited" })).toBe(
        true,
      );
      expect(session.updatePendingInterjection("missing", { text: "x" })).toBe(
        false,
      );

      expect(session.consumePendingInterjection()?.text).toBe("first");
      expect(session.consumePendingInterjection()?.text).toBe("edited");
    });

    it("clearPendingInterjectionIf removes only the matching entry", async () => {
      const session = await makeSession();
      session.setPendingInterjection("first", "q1");
      session.setPendingInterjection("second", "q2");
      session.setPendingInterjection("third", "q3");

      expect(session.clearPendingInterjectionIf("q2")?.text).toBe("second");
      expect(session.clearPendingInterjectionIf("q2")).toBeNull();

      expect(session.consumePendingInterjection()?.queueId).toBe("q1");
      expect(session.consumePendingInterjection()?.queueId).toBe("q3");
      expect(session.consumePendingInterjection()).toBeNull();
    });

    it("hasPendingInterjections reflects the queue state", async () => {
      const session = await makeSession();
      expect(session.hasPendingInterjections).toBe(false);
      session.setPendingInterjection("first", "q1");
      expect(session.hasPendingInterjections).toBe(true);
      session.consumePendingInterjection();
      expect(session.hasPendingInterjections).toBe(false);
    });
  });

  describe("queued UI messages", () => {
    it("tracks per-surface counts and clears on zero", async () => {
      const session = await makeSession();
      expect(session.hasQueuedUiMessages).toBe(false);

      session.setQueuedUiMessageCount("vscode", 2);
      expect(session.hasQueuedUiMessages).toBe(true);

      session.setQueuedUiMessageCount("browser", 1);
      session.setQueuedUiMessageCount("vscode", 0);
      expect(session.hasQueuedUiMessages).toBe(true);

      session.setQueuedUiMessageCount("browser", 0);
      expect(session.hasQueuedUiMessages).toBe(false);
    });
  });
});
