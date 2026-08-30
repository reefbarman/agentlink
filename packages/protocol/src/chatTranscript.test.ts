import type { ChatMessage, ContentBlock, TodoItem } from "./chatTranscript.js";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("chat transcript protocol", () => {
  it("keeps the complete transcript projection package-owned and serializable", () => {
    const message: ChatMessage = {
      id: "message-1",
      role: "assistant",
      content: "",
      timestamp: 1,
      blocks: [
        {
          type: "thinking",
          id: "thinking-1",
          text: "Checking",
          complete: true,
        },
        { type: "text", text: "Done" },
        {
          type: "tool_call",
          id: "tool-1",
          name: "read_file",
          inputJson: '{"path":"src/index.ts"}',
          result: "contents",
          resultImages: [{ mimeType: "image/png", data: "image-data" }],
          resultDocuments: [
            {
              name: "notes.txt",
              mimeType: "text/plain",
              data: "document-data",
            },
          ],
          complete: true,
          durationMs: 5,
          startedAt: 2,
          mcpApprovalPromotion: {
            serverName: "docs",
            bareToolName: "read_page",
            scopes: ["session"],
          },
          composeTrace: {
            status: "completed",
            totalChildren: 0,
            completedChildren: 0,
            children: [],
          },
        },
        {
          type: "skill_load",
          id: "skill-1",
          inputJson: '{"path":"SKILL.md"}',
          result: "loaded",
          complete: true,
          skillName: "review",
          path: "/skills/review/SKILL.md",
          content: "instructions",
        },
        {
          type: "bg_agent",
          sessionId: "background-1",
          task: "Review",
          message: "Review protocol boundaries",
          resolvedModel: "gpt-5.6-sol",
          resolvedProvider: "codex",
          reasoningEffort: "high",
          resolvedMode: "review",
          taskClass: "review_code",
          routingReason: "configured review model",
        },
        {
          type: "bg_agent_result",
          sessionId: "background-1",
          task: "Review",
          status: "completed",
          resultState: "completed",
          terminalReason: "completed",
          resultText: "No findings",
          summary: "Clean",
          retrySafe: false,
          agentRetryable: false,
          sourceAuthority: "canonical",
        },
        {
          type: "question_answer",
          toolCallId: "question-1",
          items: [{ question: "Proceed?", answer: true, note: "Confirmed" }],
        },
        {
          type: "pairing_code",
          pairingId: "pairing-1",
          code: "123456",
          expiresAt: 100,
          pairingUrls: ["https://example.test/pair"],
          status: "consumed",
          deviceLabel: "Phone",
        },
      ],
      badge: "follow-up",
      isSlashCommand: true,
      slashCommandLabel: "/review",
      origin: "browser",
      handoff: {
        sourceSessionId: "session-1",
        sourceTitle: "Original",
        handoffId: "handoff-1",
      },
      displayMedia: {
        images: [
          {
            name: "image.png",
            mimeType: "image/png",
            src: "data:image/png;base64,a",
          },
        ],
        documents: [{ name: "notes.txt", mimeType: "text/plain" }],
      },
      media: {
        images: [{ name: "image.png", mimeType: "image/png", base64: "a" }],
        documents: [{ name: "notes.txt", mimeType: "text/plain", base64: "b" }],
      },
      checkpointId: "checkpoint-1",
      finalMarker: { status: "completed", summary: "Done", source: "tool" },
      surfaceChange: {
        model: { previousModel: "model-a", model: "model-b" },
        reasoning: {
          previousReasoningEffort: "medium",
          reasoningEffort: "high",
        },
        mode: { previousMode: "ask", mode: "code" },
      },
      error: {
        message: "retry",
        retryable: true,
        code: "transient",
        actions: { signIn: true, signInAnotherAccount: true, condense: true },
      },
      memoryDisclosure: {
        status: "used",
        summaryCount: 1,
        transcriptExcerptCount: 1,
        sources: [
          { label: "Memory", title: "Preference", score: 0.9, kind: "summary" },
        ],
      },
      apiRequest: {
        requestId: "request-1",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        mode: "code",
        commandApprovalPolicy: "approve-for-me",
        inputTokens: 10,
        uncachedInputTokens: 4,
        cacheReadTokens: 6,
        cacheCreationTokens: 0,
        outputTokens: 2,
        usageEstimated: false,
        durationMs: 10,
        timeToFirstToken: 2,
        usedPreviousResponseId: true,
        previousResponseIdFallback: false,
        promptCacheKey: "cache-key",
        promptCacheRetention: "24h",
        storeResponseState: true,
        providerResponseId: "response-1",
        contextBreakdown: {
          prompt: { sections: [], totalChars: 0, estimatedTokens: 0 },
        },
      },
    };

    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
  });

  it("round-trips condense and warning transcript messages", () => {
    const messages: ChatMessage[] = [
      {
        id: "condense-1",
        role: "condense",
        content: "Summary",
        timestamp: 2,
        blocks: [],
        condenseInfo: {
          prevInputTokens: 100,
          newInputTokens: 50,
          durationMs: 3,
          validationWarnings: ["warning"],
        },
      },
      {
        id: "warning-1",
        role: "warning",
        content: "",
        timestamp: 3,
        blocks: [],
        warningMessage: "Retrying",
        warningRetry: {
          retryDelayMs: 100,
          retryAt: 200,
          retryAttempt: 1,
          retryMaxAttempts: 3,
        },
      },
    ];

    expect(JSON.parse(JSON.stringify(messages))).toEqual(messages);
  });

  it("keeps content block variants and recursive todos closed", () => {
    expectTypeOf<ContentBlock["type"]>().toEqualTypeOf<
      | "thinking"
      | "text"
      | "tool_call"
      | "skill_load"
      | "bg_agent"
      | "bg_agent_result"
      | "question_answer"
      | "pairing_code"
    >();
    expectTypeOf<ChatMessage["role"]>().toEqualTypeOf<
      "user" | "assistant" | "condense" | "warning"
    >();
    expectTypeOf<TodoItem["status"]>().toEqualTypeOf<
      "pending" | "in_progress" | "completed"
    >();
    expectTypeOf<TodoItem["children"]>().toEqualTypeOf<
      TodoItem[] | undefined
    >();
  });
});
