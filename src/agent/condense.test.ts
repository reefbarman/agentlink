import type {
  CompleteRequest,
  CompleteResult,
  ModelCapabilities,
  ModelInfo,
  ModelProvider,
  ProviderStreamEvent,
  StreamRequest,
} from "./providers/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  enforceToolResultAdjacency,
  extractCondenseRecallAnchors,
  getEffectiveHistory,
  injectSyntheticToolResults,
  summarizeConversation,
} from "./condense.js";

import type { AgentMessage } from "./types.js";
import { CODEX_CONDENSE_MODEL } from "../core/model/providers/codex/models.js";

const TEST_MODEL = "claude-sonnet-4-6";

const TEST_CAPABILITIES: ModelCapabilities = {
  supportsThinking: false,
  supportsCaching: true,
  supportsImages: true,
  supportsToolUse: true,
  contextWindow: 200_000,
  maxOutputTokens: 8192,
};

function makeProvider(
  onComplete?: (request: CompleteRequest) => CompleteResult,
) {
  const complete = vi.fn(async (request: CompleteRequest) =>
    onComplete
      ? onComplete(request)
      : {
          text: `<summary>
1. **Primary Request and Intent**: Keep working.
2. **Key Technical Concepts**: TypeScript.
3. **Files and Code Sections**: src/agent/condense.ts.
4. **Errors and Fixes**: None.
5. **Problem Solving**: Preserved context.
6. **All User Messages**: "Investigate condense"
7. **User Corrections & Behavioral Directives**: None.
8. **Pending Tasks**: None.
9. **Current Work**: Inspecting condense behavior.
10. **Optional Next Step**: Continue.
</summary>`,
        },
  );

  const provider: ModelProvider = {
    id: "mock",
    displayName: "Mock",
    condenseModel: "mock-condense",
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
          displayName: "Test Model",
          provider: "mock",
          capabilities: TEST_CAPABILITIES,
        },
      ];
    },
    async *stream(
      _request: StreamRequest,
    ): AsyncGenerator<ProviderStreamEvent> {
      yield* [];
    },
    complete,
  };

  return { provider, complete };
}

function requestMessageText(
  message: CompleteRequest["messages"][number],
): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}

function makeMessages(): AgentMessage[] {
  return [
    { role: "user", content: "Investigate condense" } as AgentMessage,
    { role: "assistant", content: [{ type: "text", text: "Looking now." }] },
  ];
}

function makeCodexProvider(
  onComplete?: (request: CompleteRequest) => CompleteResult,
) {
  const complete = vi.fn(async (request: CompleteRequest) =>
    onComplete
      ? onComplete(request)
      : {
          text: `<summary>
1. **Primary Request and Intent**: Keep working.
2. **Key Technical Concepts**: TypeScript.
3. **Files and Code Sections**: src/agent/condense.ts.
4. **Errors and Fixes**: None.
5. **Problem Solving**: Preserved context.
6. **All User Messages**: "Investigate condense"
7. **User Corrections & Behavioral Directives**: None.
8. **Pending Tasks**: None.
9. **Current Work**: Inspecting condense behavior.
10. **Optional Next Step**: Continue.
</summary>`,
        },
  );

  const provider: ModelProvider = {
    id: "codex",
    displayName: "Codex",
    condenseModel: CODEX_CONDENSE_MODEL,
    async isAuthenticated() {
      return true;
    },
    getCapabilities(model: string) {
      const contextWindow =
        model === CODEX_CONDENSE_MODEL ? 1_050_000 : 400_000;
      return {
        ...TEST_CAPABILITIES,
        contextWindow,
        maxOutputTokens: 128_000,
      };
    },
    listModels(): ModelInfo[] {
      return [
        {
          id: "gpt-5.4",
          displayName: "GPT-5.4",
          provider: "codex",
          capabilities: {
            ...TEST_CAPABILITIES,
            contextWindow: 400_000,
            maxOutputTokens: 128_000,
          },
        },
      ];
    },
    async *stream(
      _request: StreamRequest,
    ): AsyncGenerator<ProviderStreamEvent> {
      yield* [];
    },
    complete,
  };

  return { provider, complete };
}

describe("extractCondenseRecallAnchors", () => {
  it("extracts stable bounded files, errors, tools, and command failure markers", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "read-1",
            name: "read_file",
            input: { path: "src/agent/condense.ts" },
          },
          {
            type: "tool_use",
            id: "command-1",
            name: "execute_command",
            input: { command: "npm test -- src/agent/condense.test.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "command-1",
            content: '{"exit_code":1,"output":"Error: assertion failed"}',
            is_error: false,
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "command-duplicate",
            name: "execute_command",
            input: { command: "npm test -- src/agent/condense.test.ts" },
          },
          {
            type: "text",
            text: "Error: assertion failed in src/agent/condense.ts",
          },
        ],
      },
    ];

    expect(extractCondenseRecallAnchors(messages)).toEqual({
      filePaths: ["src/agent/condense.ts", "src/agent/condense.test.ts"],
      errors: [
        '{"exit_code":1,"output":"Error: assertion failed"}',
        "Error: assertion failed in src/agent/condense.ts",
      ],
      commands: ["[failed] npm test -- src/agent/condense.test.ts"],
      toolNames: ["read_file", "execute_command"],
    });
  });

  it("deduplicates anchors and enforces category and total caps", () => {
    const content = Array.from({ length: 20 }, (_, index) => ({
      type: "tool_use" as const,
      id: `call-${index}`,
      name: `tool_${index}`,
      input: { path: `src/generated/file-${index}.ts` },
    }));
    const errors = Array.from(
      { length: 10 },
      (_, index) => `Error ${index}: ${"x".repeat(300)}`,
    ).join("\n");
    const anchors = extractCondenseRecallAnchors([
      { role: "assistant", content },
      { role: "assistant", content: [{ type: "text", text: errors }] },
      { role: "assistant", content: [{ type: "text", text: errors }] },
    ] as AgentMessage[]);

    expect(anchors.filePaths).toHaveLength(8);
    expect(anchors.errors).toHaveLength(6);
    expect(anchors.toolNames).toHaveLength(8);
    expect(new Set(anchors.errors).size).toBe(anchors.errors.length);
    expect(
      [
        ...anchors.filePaths,
        ...anchors.errors,
        ...anchors.commands,
        ...anchors.toolNames,
      ].reduce((total, value) => total + value.length + 2, 0),
    ).toBeLessThanOrEqual(2_000);
  });
});

describe("summarizeConversation", () => {
  it("carries the prior checkpoint summary into a repeated condense", async () => {
    let completion = 0;
    const { provider, complete } = makeProvider(() => {
      completion += 1;
      return {
        text:
          completion === 1
            ? "<summary>Prior assistant conclusion: the stale cache key is the root cause.</summary>"
            : "<summary>The stale cache key remains the root cause; continue with the invalidation fix.</summary>",
      };
    });

    const first = await summarizeConversation({
      messages: [
        { role: "user", content: "Investigate the cache bug" } as AgentMessage,
        {
          role: "assistant",
          content: [{ type: "text", text: "I found the root cause." }],
        },
      ],
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
    });
    const second = await summarizeConversation({
      messages: [
        ...first.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: "Preparing the fix." }],
        },
        {
          role: "user",
          content: "Continue implementing the fix",
        } as AgentMessage,
      ],
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
    });

    expect(second.error).toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(2);
    const secondRequest = complete.mock.calls[1][0] as CompleteRequest;
    const finalMessage = secondRequest.messages.at(-1);
    expect(requestMessageText(finalMessage!)).toContain(
      "<prior-checkpoint-summary>",
    );
    expect(requestMessageText(finalMessage!)).toContain(
      "the stale cache key is the root cause",
    );
    expect(second.metadata?.hadPriorSummaryInInput).toBe(true);
    expect(second.summary).toContain("stale cache key remains the root cause");
    const effective = getEffectiveHistory(second.messages);
    expect(effective[0]?.isSummary).toBe(true);
    expect(JSON.stringify(effective[0]?.content)).toContain(
      "stale cache key remains the root cause",
    );
  });

  it("retains the prior checkpoint when shrinking a repeated condense request", async () => {
    let completion = 0;
    const { provider, complete } = makeProvider(() => {
      completion += 1;
      if (completion === 1) {
        throw new Error("maximum context length exceeded");
      }
      return { text: "<summary>Consolidated after shrinking.</summary>" };
    });
    const messages: AgentMessage[] = [
      { role: "user", content: "Original task", condenseParent: "summary-1" },
      {
        role: "user",
        isSummary: true,
        condenseId: "summary-1",
        content: [
          {
            type: "text",
            text: "## Conversation Summary\n\nCarry this exact prior conclusion.",
          },
        ],
      },
      ...Array.from({ length: 20 }, (_, index): AgentMessage[] => [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `Delta ${index} ${"x".repeat(20_000)}`,
            },
          ],
        },
        { role: "user", content: `Continue ${index}` } as AgentMessage,
      ]).flat(),
    ] as AgentMessage[];

    const result = await summarizeConversation({
      messages,
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
    });

    expect(result.error).toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(2);
    for (const call of complete.mock.calls) {
      expect(
        requestMessageText((call[0] as CompleteRequest).messages.at(-1)!),
      ).toContain("Carry this exact prior conclusion.");
    }
    expect(result.metadata?.hadPriorSummaryInInput).toBe(true);
    expect(result.metadata?.inputMessageCount).toBeLessThan(
      messages.length - 2,
    );
    expect(result.metadata?.sourceHash).toMatch(/^[a-f0-9]{16}$/);
    expect(result.validationWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining("64,000-token budget")]),
    );
  });

  it("preserves the prior checkpoint in the empty-output fallback", async () => {
    const { provider } = makeProvider(() => ({ text: "" }));
    const result = await summarizeConversation({
      messages: [
        { role: "user", content: "Original task", condenseParent: "summary-1" },
        {
          role: "user",
          isSummary: true,
          condenseId: "summary-1",
          content: [
            {
              type: "text",
              text: "## Conversation Summary\n\nPrior checkpoint conclusion.",
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "New work" }] },
        { role: "user", content: "Continue the fix" },
      ] as AgentMessage[],
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.summary).toContain("Prior checkpoint conclusion.");
    expect(result.validationWarnings).toContain(
      "Model returned empty summary; using deterministic fallback.",
    );
  });

  it("passes preserved runtime context into the condense prompt", async () => {
    const { provider, complete } = makeProvider();

    await summarizeConversation({
      messages: makeMessages(),
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
      preservedContext: {
        toolNames: ["read_file", "codebase_search", "linear__get_issue"],
        mcpServerNames: ["linear", "notion"],
      },
    });

    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0][0] as CompleteRequest;
    const finalMessage = request.messages[request.messages.length - 1];
    expect(finalMessage.role).toBe("user");
    expect(String(finalMessage.content)).toContain(
      "## Preserved Runtime Context (reattached outside transcript)",
    );
    expect(String(finalMessage.content)).toContain("- read_file");
    expect(String(finalMessage.content)).toContain("- codebase_search");
    expect(String(finalMessage.content)).toContain("- linear");
    expect(String(finalMessage.content)).toContain("- notion");
  });

  it("strips memory candidate reminders from condense canonical user messages", async () => {
    const { provider, complete } = makeProvider();
    const result = await summarizeConversation({
      messages: [
        {
          role: "user",
          content:
            "Fix issue\n\n<system-reminder>\n[memory-candidate] hidden nudge\nNever store this meta text.\n</system-reminder>",
        } as AgentMessage,
        {
          role: "assistant",
          content: [{ type: "text", text: "Looking now." }],
        } as AgentMessage,
      ],
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
      preservedContext: {
        toolNames: ["read_file"],
        mcpServerNames: [],
      },
    });

    const request = complete.mock.calls[0][0] as CompleteRequest;
    const finalMessage = request.messages[request.messages.length - 1];
    expect(String(finalMessage.content)).toContain(
      'Latest user message: "Fix issue"',
    );
    expect(String(finalMessage.content)).not.toContain("[memory-candidate]");
    expect(String(finalMessage.content)).not.toContain("hidden nudge");

    const summary = result.messages[result.messages.length - 1];
    const content = summary.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain('Latest user message: "Fix issue"');
    expect(content[0]?.text).not.toContain("[memory-candidate]");
  });

  it("includes preserved runtime context in post-condense token estimates", async () => {
    const messages = makeMessages();
    const { provider } = makeProvider();

    const withoutContext = await summarizeConversation({
      messages,
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
    });

    const withContext = await summarizeConversation({
      messages,
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
      preservedContext: {
        toolNames: [
          "read_file",
          "codebase_search",
          "search_files",
          "notion__notion-fetch",
          "linear__get_issue",
        ],
        mcpServerNames: ["notion", "linear"],
      },
    });

    expect(withContext.error).toBeUndefined();
    expect(withContext.newInputTokens).toBeGreaterThan(
      withoutContext.newInputTokens,
    );
  });

  it("still appends a summary message and tags prior messages on success", async () => {
    const { provider } = makeProvider();
    const result = await summarizeConversation({
      messages: makeMessages(),
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
      preservedContext: {
        toolNames: ["read_file"],
        mcpServerNames: [],
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.validationWarnings ?? []).toHaveLength(0);
    expect(result.messages).toHaveLength(3);
    const summary = result.messages[result.messages.length - 1];
    expect(summary.isSummary).toBe(true);
    expect(summary.condenseId).toBeTruthy();
    expect(result.messages[1].condenseParent).toBe(summary.condenseId);
    expect(Array.isArray(summary.content)).toBe(true);
    const content = summary.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("## Resume Anchor (deterministic)");
    expect(content[0]?.text).toContain("## Session Transcript Recall");
    expect(content[0]?.text).toContain("`search_session_history`");
    expect(content[0]?.text).toContain(
      "### Retired-window recall anchors (deterministic, bounded)",
    );
    expect(content[1]?.text).toContain("## Conversation Summary");
  });

  it("accepts model summary without validation retry", async () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Investigate condense" } as AgentMessage,
      { role: "assistant", content: [{ type: "text", text: "Looking now." }] },
      {
        role: "user",
        content:
          "Continue fixing the condense resume bug for Codex after summarization.",
      } as AgentMessage,
    ];

    const { provider, complete } = makeProvider(() => {
      return {
        text: `<summary>
Working on condense improvements. Key files: src/agent/condense.ts.
User wants to fix the condense resume bug for Codex after summarization.
</summary>`,
      };
    });

    const result = await summarizeConversation({
      messages,
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
    });

    expect(result.error).toBeUndefined();
    // No validation retry — single API call.
    expect(complete).toHaveBeenCalledTimes(1);
    const summary = result.messages[result.messages.length - 1];
    expect(summary.isSummary).toBe(true);
    const content = summary.content as Array<{ type: string; text?: string }>;
    expect(content[1]?.text).toContain("## Conversation Summary");
    expect(content[1]?.text).toContain("condense improvements");
  });

  it("uses an honest resume anchor when no pending task heuristic matches", async () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Investigate condense" } as AgentMessage,
      { role: "assistant", content: [{ type: "text", text: "Looking now." }] },
      {
        role: "user",
        content: "What likely caused the context loss after summarization?",
      } as AgentMessage,
    ];

    const { provider } = makeProvider();
    const result = await summarizeConversation({
      messages,
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
      preservedContext: {
        toolNames: ["read_file"],
        mcpServerNames: [],
      },
    });

    expect(result.error).toBeUndefined();
    const summary = result.messages[result.messages.length - 1];
    const content = summary.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain(
      'Latest user message: "What likely caused the context loss after summarization?"',
    );
    expect(content[0]?.text).toContain(
      'Continue from this task: "Unknown from transcript"',
    );
  });

  it("injects a canonical resume-context message into effective history after the summary", async () => {
    const { provider } = makeProvider();
    const result = await summarizeConversation({
      messages: [
        { role: "user", content: "Investigate condense" } as AgentMessage,
        {
          role: "assistant",
          content: [{ type: "text", text: "Looking now." }],
        },
        {
          role: "user",
          content:
            "Continue fixing the condense resume bug for Codex after summarization.",
        } as AgentMessage,
      ],
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
      preservedContext: {
        toolNames: ["read_file", "codebase_search"],
        mcpServerNames: ["linear"],
      },
    });

    expect(result.error).toBeUndefined();
    const effective = getEffectiveHistory(result.messages);
    expect(effective).toHaveLength(2);
    expect(effective[0]?.isSummary).toBe(true);
    expect(effective[1]?.isResumeContext).toBe(true);
    expect(Array.isArray(effective[1]?.content)).toBe(true);
    const injected = effective[1]?.content as Array<{
      type: string;
      text?: string;
    }>;
    expect(injected[0]?.text).toContain("## Resume Anchor (deterministic)");
    expect(injected[0]?.text).toContain(
      'Continue from this task: "Continue fixing the condense resume bug for Codex after summarization."',
    );
  });

  it("places the injected resume-context message immediately before the next real user message", () => {
    const messages: AgentMessage[] = [
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
      } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "Need a bit more context." }],
      },
      { role: "user", content: "Continue fixing the issue." } as AgentMessage,
    ];

    const effective = getEffectiveHistory(messages);
    expect(effective).toHaveLength(4);
    expect(effective[0]?.isSummary).toBe(true);
    expect(effective[1]?.role).toBe("assistant");
    expect(effective[2]?.role).toBe("user");
    expect(effective[2]?.isResumeContext).toBe(true);
    expect(Array.isArray(effective[2]?.content)).toBe(true);
    const injected = effective[2]?.content as Array<{
      type: string;
      text?: string;
    }>;
    expect(injected[0]?.text).toContain("## Resume Anchor (deterministic)");
    expect(effective[3]).toEqual({
      role: "user",
      content: "Continue fixing the issue.",
    });
  });

  it("does not insert the resume-context message between a tool_use and its tool_result", () => {
    // Regression: a session condensed right before a tool turn looked like
    // [summary, assistant(tool_use), user(tool_result), user(text)]. The
    // resume-context message was inserted before the first user message —
    // the tool_result carrier — splitting the pair. injectSyntheticToolResults
    // then added a duplicate synthetic result and the API rejected the turn
    // with "unexpected tool_use_id found in tool_result blocks".
    const messages: AgentMessage[] = [
      {
        role: "user",
        isSummary: true,
        condenseId: "condense-1",
        content: [{ type: "text", text: "## Conversation Summary\n\nBody" }],
      } as AgentMessage,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_WySM7rgnznhP3z9b0deikuDm",
            name: "set_task_status",
            input: {},
          },
        ],
      } as AgentMessage,
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_WySM7rgnznhP3z9b0deikuDm",
            content: "ok",
          },
        ],
      } as AgentMessage,
      {
        role: "user",
        content: "You stopped but there are still pending tasks. Continue.",
      } as AgentMessage,
    ];

    const effective = injectSyntheticToolResults(getEffectiveHistory(messages));

    // tool_use must still be immediately followed by its tool_result
    // (allowing for consecutive user messages, which providers merge).
    const assistantIdx = effective.findIndex((m) => m.role === "assistant");
    const next = effective[assistantIdx + 1];
    expect(next?.role).toBe("user");
    const nextBlocks = Array.isArray(next?.content) ? next.content : [];
    expect(nextBlocks.filter((b) => b.type === "tool_result")).toHaveLength(1);

    // Exactly one tool_result for the call across the whole history —
    // no synthetic duplicate.
    const allResults = effective.flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((b) => b.type === "tool_result")
        : [],
    );
    expect(allResults).toHaveLength(1);

    // Resume context still present, after the tool_result.
    const resumeIdx = effective.findIndex((m) => m.isResumeContext);
    expect(resumeIdx).toBeGreaterThan(assistantIdx + 1);
  });

  it("derives canonical user messages from array-content user messages", async () => {
    const { provider } = makeProvider(() => ({
      text: `<summary>
1. **Primary Request and Intent**: Keep working.
2. **Key Technical Concepts**: TypeScript.
3. **Files and Code Sections**: src/agent/condense.ts.
4. **Errors and Fixes**: None.
5. **Problem Solving**: Preserved context.
6. **All User Messages**: "Please investigate the screenshot and continue the fix." 
7. **User Corrections & Behavioral Directives**: None.
8. **Pending Tasks**: - Please investigate the screenshot and continue the fix.
9. **Current Work**: Continue from this task: "Please investigate the screenshot and continue the fix."
10. **Optional Next Step**: Continue.
</summary>`,
    }));

    const result = await summarizeConversation({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Please investigate the screenshot and continue the fix.",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "abc123",
              },
            },
          ],
        } as AgentMessage,
        {
          role: "assistant",
          content: [{ type: "text", text: "Looking now." }],
        },
      ],
      provider,
      systemPrompt: "system prompt",
      isAutomatic: true,
      preservedContext: {
        toolNames: ["read_file"],
        mcpServerNames: [],
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.metadata?.canonicalUserMessages).toEqual([
      "Please investigate the screenshot and continue the fix.",
    ]);
    expect(result.metadata?.latestUserMessage).toBe(
      "Please investigate the screenshot and continue the fix.",
    );
  });

  it("prefers the cheap Codex condense model when the request safely fits", async () => {
    const { provider, complete } = makeCodexProvider();

    const result = await summarizeConversation({
      messages: makeMessages(),
      provider,
      activeModel: "gpt-5.4",
      systemPrompt: "system prompt",
      isAutomatic: true,
    });

    expect(result.error).toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0][0] as CompleteRequest;
    expect(request.model).toBe(CODEX_CONDENSE_MODEL);
    expect(result.metadata?.modelCandidates[0]).toBe(CODEX_CONDENSE_MODEL);
    expect(result.metadata?.selectedModel).toBe(CODEX_CONDENSE_MODEL);
    expect(result.metadata?.skippedModelCandidates).toBeUndefined();
  });

  it("bounds an oversized single message so the cheap Codex model fits safely", async () => {
    const { provider, complete } = makeCodexProvider();
    // Must exceed 80% of Luna's 1.05M context (~840K tokens ~= 3.36M chars).
    const largeUserMessage = "x".repeat(3_400_000);

    const result = await summarizeConversation({
      messages: [
        { role: "user", content: largeUserMessage } as AgentMessage,
        {
          role: "assistant",
          content: [{ type: "text", text: "Looking now." }],
        },
      ],
      provider,
      activeModel: "gpt-5.4",
      systemPrompt: "system prompt",
      isAutomatic: true,
    });

    expect(result.error).toBeUndefined();
    expect(complete).toHaveBeenCalled();
    const request = complete.mock.calls[0][0] as CompleteRequest;
    expect(request.model).toBe(CODEX_CONDENSE_MODEL);
    expect(result.metadata?.modelCandidates[0]).toBe(CODEX_CONDENSE_MODEL);
    expect(result.metadata?.selectedModel).toBe(CODEX_CONDENSE_MODEL);
    expect(result.metadata?.skippedModelCandidates).toBeUndefined();
    expect(requestMessageText(request.messages[0])).toContain(
      "omitted from middle",
    );
    expect(requestMessageText(request.messages[0]).length).toBeLessThan(70_000);
  });

  it("retries the next Codex candidate after a context-window error", async () => {
    const { provider, complete } = makeCodexProvider((request) => {
      if (request.model === CODEX_CONDENSE_MODEL) {
        throw new Error(
          "Codex API error unknown: Your input exceeds the context window of this model.",
        );
      }

      return {
        text: `<summary>
1. **Primary Request and Intent**: Keep working.
2. **Key Technical Concepts**: TypeScript.
3. **Files and Code Sections**: src/agent/condense.ts.
4. **Errors and Fixes**: None.
5. **Problem Solving**: Preserved context.
6. **All User Messages**: "Investigate condense"
7. **User Corrections & Behavioral Directives**: None.
8. **Pending Tasks**: None.
9. **Current Work**: Inspecting condense behavior.
10. **Optional Next Step**: Continue.
</summary>`,
      };
    });

    const result = await summarizeConversation({
      messages: makeMessages(),
      provider,
      activeModel: "gpt-5.4",
      systemPrompt: "system prompt",
      isAutomatic: true,
    });

    expect(result.error).toBeUndefined();
    // Cheap model fails, then falls through to gpt-5.4 (active model), then
    // remaining fallbacks. The first non-cheap candidate that succeeds wins.
    expect(complete).toHaveBeenCalledTimes(2);
    expect((complete.mock.calls[0][0] as CompleteRequest).model).toBe(
      CODEX_CONDENSE_MODEL,
    );
    expect((complete.mock.calls[1][0] as CompleteRequest).model).toBe(
      "gpt-5.4",
    );
    expect(result.metadata?.selectedModel).toBe("gpt-5.4");
  });

  it("shrinks the condense source window after a context-window error", async () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Investigate condense" } as AgentMessage,
      { role: "assistant", content: [{ type: "text", text: "Looking now." }] },
      { role: "user", content: "Step 1" } as AgentMessage,
      { role: "assistant", content: [{ type: "text", text: "Done 1" }] },
      { role: "user", content: "Step 2" } as AgentMessage,
      { role: "assistant", content: [{ type: "text", text: "Done 2" }] },
      { role: "user", content: "Step 3" } as AgentMessage,
      { role: "assistant", content: [{ type: "text", text: "Done 3" }] },
    ];

    let callCount = 0;
    const { provider, complete } = makeCodexProvider(() => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error(
          "Codex API error unknown: Your input exceeds the context window of this model.",
        );
      }
      return {
        text: `<summary>
1. **Primary Request and Intent**: Keep working.
2. **Key Technical Concepts**: TypeScript.
3. **Files and Code Sections**: src/agent/condense.ts.
4. **Errors and Fixes**: None.
5. **Problem Solving**: Preserved context.
6. **All User Messages**: "Investigate condense"
7. **User Corrections & Behavioral Directives**: None.
8. **Pending Tasks**: None.
9. **Current Work**: Inspecting condense behavior.
10. **Optional Next Step**: Continue.
</summary>`,
      };
    });

    const result = await summarizeConversation({
      messages,
      provider,
      activeModel: "gpt-5.4",
      systemPrompt: "system prompt",
      isAutomatic: true,
    });

    expect(result.error).toBeUndefined();
    // Cheap model fails with context error, then gpt-5.4 succeeds.
    // No validation retry — just 2 model candidate calls.
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.summary).toBeTruthy();
  });

  it("bounds transcript-shaped condense requests by estimated input size", async () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "Original terminal implementation request",
      } as AgentMessage,
    ];
    for (let index = 0; index < 600; index += 1) {
      messages.push({
        role: "assistant",
        content: [
          {
            type: "text",
            text: `inspection-${index}-${"x".repeat(20_000)}`,
          },
        ],
      });
      messages.push({
        role: "user",
        content: `Continue terminal package ${index}`,
      } as AgentMessage);
    }
    messages.push({
      role: "user",
      content: "Review the finished sandbox plan",
    } as AgentMessage);
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: "Starting the review." }],
    });

    const { provider, complete } = makeCodexProvider();
    const result = await summarizeConversation({
      messages,
      provider,
      activeModel: "gpt-5.4",
      systemPrompt: "system prompt",
      isAutomatic: true,
    });

    expect(result.error).toBeUndefined();
    expect(complete).toHaveBeenCalledOnce();
    const request = complete.mock.calls[0][0] as CompleteRequest;
    const requestChars = request.messages.reduce(
      (total, message) => total + requestMessageText(message).length,
      0,
    );
    expect(requestChars).toBeLessThanOrEqual(480_000);
    expect(requestMessageText(request.messages.at(-1)!)).toContain(
      "Review the finished sandbox plan",
    );
    expect(result.validationWarnings).toEqual([
      expect.stringContaining("120,000-token request budget"),
    ]);
    expect(result.metadata?.inputMessageCount).toBeLessThan(messages.length);
    expect(result.metadata?.canonicalUserMessages).toEqual(
      expect.arrayContaining([
        "Original terminal implementation request",
        expect.stringContaining("earlier user messages omitted"),
        "Review the finished sandbox plan",
      ]),
    );
  });

  it("falls back deterministically after the minimum bounded request is rejected", async () => {
    const requestSizes: number[] = [];
    const { provider, complete } = makeCodexProvider((request) => {
      requestSizes.push(
        request.messages.reduce(
          (total, message) => total + requestMessageText(message).length,
          0,
        ),
      );
      throw new Error("400 status code (no body)");
    });
    const messages: AgentMessage[] = Array.from(
      { length: 80 },
      (_, index): AgentMessage => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${index}-${"x".repeat(20_000)}`,
      }),
    );
    messages.push({
      role: "user",
      content: "Continue the current implementation",
    } as AgentMessage);
    messages.push({
      role: "assistant",
      content: "Ready to continue",
    } as AgentMessage);

    const result = await summarizeConversation({
      messages,
      provider,
      activeModel: "gpt-5.4",
      systemPrompt: "system prompt",
      isAutomatic: true,
    });

    expect(complete).toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expect(result.summary).toContain("deterministic resume anchor");
    expect(result.validationWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("64,000-token budget"),
        expect.stringContaining("32,000-token budget"),
        expect.stringContaining("using deterministic handoff sections"),
      ]),
    );
    expect(result.validationWarnings).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("Model returned empty summary"),
      ]),
    );
    expect(Math.min(...requestSizes)).toBeLessThan(Math.max(...requestSizes));
    expect(result.messages.at(-1)?.isSummary).toBe(true);
  });

  it("preserves structured error metadata for condense failures", async () => {
    const { provider } = makeCodexProvider(() => {
      const error = new Error(
        "Codex API error 429: The usage limit has been reached",
      );
      (
        error as Error & {
          retryable?: boolean;
          code?: string;
          actions?: { signInAnotherAccount?: boolean };
        }
      ).retryable = true;
      (
        error as Error & {
          retryable?: boolean;
          code?: string;
          actions?: { signInAnotherAccount?: boolean };
        }
      ).code = "oauth_usage_limit_exhausted";
      (
        error as Error & {
          retryable?: boolean;
          code?: string;
          actions?: { signInAnotherAccount?: boolean };
        }
      ).actions = { signInAnotherAccount: true };
      throw error;
    });

    const result = await summarizeConversation({
      messages: makeMessages(),
      provider,
      activeModel: "gpt-5.4",
      systemPrompt: "system prompt",
      isAutomatic: true,
    });

    expect(result.error).toContain("Condensing API call failed");
    expect(result.errorRetryable).toBe(true);
    expect(result.errorCode).toBe("oauth_usage_limit_exhausted");
    expect(result.errorActions).toEqual({ signInAnotherAccount: true });
  });
});

describe("enforceToolResultAdjacency", () => {
  const toolUse = (id: string) => ({
    type: "tool_use" as const,
    id,
    name: "execute_command",
    input: {},
  });
  const toolResult = (id: string, content = "ok") => ({
    type: "tool_result" as const,
    tool_use_id: id,
    content,
  });

  it("keeps valid tool_use/tool_result pairs untouched", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "task" } as AgentMessage,
      { role: "assistant", content: [toolUse("call_1")] } as AgentMessage,
      { role: "user", content: [toolResult("call_1")] } as AgentMessage,
    ];
    expect(enforceToolResultAdjacency(messages)).toEqual(messages);
  });

  it("drops tool_results with no matching tool_use in the preceding assistant turn", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "task" } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      } as AgentMessage,
      {
        role: "user",
        content: [toolResult("call_orphan"), { type: "text", text: "next" }],
      } as AgentMessage,
    ];
    const repaired = enforceToolResultAdjacency(messages);
    expect(repaired).toHaveLength(3);
    expect(repaired[2].content).toEqual([{ type: "text", text: "next" }]);
  });

  it("removes a user message entirely when all its blocks were orphaned tool_results", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "task" } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      } as AgentMessage,
      { role: "user", content: [toolResult("call_orphan")] } as AgentMessage,
      { role: "user", content: "follow-up" } as AgentMessage,
    ];
    const repaired = enforceToolResultAdjacency(messages);
    expect(repaired).toHaveLength(3);
    expect(repaired[2]).toEqual({ role: "user", content: "follow-up" });
  });

  it("dedupes duplicate tool_results for one tool_use, keeping the last", () => {
    // Shape produced by the resume-context insertion bug: a synthetic result
    // injected ahead of the real one in a later consecutive user message.
    const messages: AgentMessage[] = [
      { role: "user", content: "task" } as AgentMessage,
      { role: "assistant", content: [toolUse("call_1")] } as AgentMessage,
      {
        role: "user",
        content: [
          toolResult("call_1", "synthetic placeholder"),
          { type: "text", text: "resume context" },
        ],
      } as AgentMessage,
      {
        role: "user",
        content: [toolResult("call_1", "real result")],
      } as AgentMessage,
    ];
    const repaired = enforceToolResultAdjacency(messages);
    const results = repaired.flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((b) => b.type === "tool_result")
        : [],
    );
    expect(results).toHaveLength(1);
    expect((results[0] as { content?: unknown }).content).toBe("real result");
    // The resume-context text survives even though its sibling block was cut.
    expect(
      repaired.some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some(
            (b) =>
              b.type === "text" &&
              (b as { text: string }).text === "resume context",
          ),
      ),
    ).toBe(true);
  });

  it("keeps tool_results in later consecutive user messages (providers merge them)", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: [toolUse("call_1")] } as AgentMessage,
      {
        role: "user",
        content: [{ type: "text", text: "note" }],
      } as AgentMessage,
      { role: "user", content: [toolResult("call_1")] } as AgentMessage,
    ];
    const repaired = enforceToolResultAdjacency(messages);
    expect(repaired).toHaveLength(3);
    expect(repaired[2].content).toEqual([toolResult("call_1")]);
  });

  it("scopes pairing to the most recent assistant turn", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: [toolUse("call_1")] } as AgentMessage,
      { role: "user", content: [toolResult("call_1")] } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      } as AgentMessage,
      // Stale duplicate referencing a tool_use from an earlier turn.
      { role: "user", content: [toolResult("call_1")] } as AgentMessage,
      { role: "user", content: "next" } as AgentMessage,
    ];
    const repaired = enforceToolResultAdjacency(messages);
    expect(repaired).toHaveLength(4);
    expect(repaired[1].content).toEqual([toolResult("call_1")]);
    expect(repaired[3]).toEqual({ role: "user", content: "next" });
  });
});
