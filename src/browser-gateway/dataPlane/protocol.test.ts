import { describe, expect, it } from "vitest";

import {
  BROWSER_GATEWAY_COMMAND_IDEMPOTENCY,
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  BROWSER_GATEWAY_OWNER_EVENT_KINDS,
  BrowserGatewayProtocolError,
  type BrowserGatewayDetailHandle,
  type BrowserGatewayOwnerCheckpoint,
  type BrowserGatewayOwnerCommandKind,
  type BrowserGatewayOwnerEventKind,
  parseBrowserGatewayChatTabSelection,
  parseBrowserGatewayDetailHandle,
  parseBrowserGatewayOwnerCheckpoint,
  parseBrowserGatewayOwnerCommand,
  parseBrowserGatewayOwnerCommandAck,
  parseBrowserGatewayOwnerControl,
  parseBrowserGatewayOwnerEvent,
  parseBrowserGatewayOwnerPublicationBatch,
  parseBrowserGatewayOwnerRegistration,
  parseBrowserGatewayRelayReset,
} from "./protocol.js";
import {
  BROWSER_GATEWAY_DATA_PLANE_LIMIT_OWNERS,
  BROWSER_GATEWAY_DATA_PLANE_LIMITS,
} from "./limits.js";

const identity = {
  helperGenerationId: "helper-generation-1",
  ownerId: "owner-1",
  ownerGenerationId: "owner-generation-1",
};

const detailHandle = {
  ...identity,
  handleId: "handle-1",
  kind: "message",
  byteLength: 1_024,
  expiresAt: 2_000,
} satisfies BrowserGatewayDetailHandle;

function checkpoint(
  overrides: Partial<BrowserGatewayOwnerCheckpoint> = {},
): BrowserGatewayOwnerCheckpoint {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    ...identity,
    checkpointId: "checkpoint-1",
    checkpointSequence: 0,
    emittedAt: 1_000,
    foreground: {
      sessionId: "session-1",
      title: "Data plane",
      originalPrompt: "Implement the data plane",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "running",
      interactiveExecutionPhase: "queued_for_provider",
      streaming: true,
      interrupted: true,
      estimatedTokens: 100,
      maximumTokens: 10_000,
      statusOverride: "Restoring session",
      thinkingEnabled: false,
      reasoningEffort: "medium",
      lastInputTokens: 11,
      lastOutputTokens: 22,
      lastCacheReadTokens: 33,
      contextBudget: {
        contextWindow: 200_000,
        maxInputTokens: 180_000,
        usedInputTokens: 11,
        outputReservation: 8_192,
        safetyBufferTokens: 4_096,
        softThresholdBudget: 144_000,
        hardBudget: 175_904,
      },
      contextHealth: {
        memory: {
          status: "ready",
          retrieval: "hybrid",
          activeRecordCount: 7,
        },
        retrieval: {
          status: "degraded",
          lexical: "ready",
          vector: "unavailable",
          structural: "ready",
          sourceCount: 12,
          chunkCount: 48,
          staleSourceCount: 2,
          reason: "Vector retrieval is unavailable.",
        },
        index: {
          status: "working",
          state: "indexing",
          current: 3,
          total: 10,
        },
      },
      condenseThreshold: 0.8,
      agentWriteApproval: "session",
      commandApprovalPolicy: "approve-for-me",
      configuredCommandApprovalPolicy: "sensitive",
      restoringSession: true,
      revertRecoveryNotice: {
        projectId: "project-1",
        checkpointId: "checkpoint-1",
        sessionRevision: "session-revision-1",
        workspaceRevision: "workspace-revision-1",
        startedAt: 900,
        title: "Recovery required",
        message: "Restore the reverted workspace state.",
      },
    },
    catalog: {
      projects: [
        {
          projectId: "project-1",
          displayName: "AgentLink",
          availability: "available",
        },
      ],
      sessions: [
        {
          sessionId: "session-1",
          projectId: "project-1",
          title: "Data plane",
          mode: "code",
          model: "claude-sonnet-4-6",
          messageCount: 1,
          createdAt: 500,
          updatedAt: 1_000,
        },
      ],
      defaultProjectId: "project-1",
      foregroundSessionId: "session-1",
      chatWorkspace: {
        controllerEpoch: "controller-1",
        focusedTabId: "tab-1",
        tabs: [
          {
            tabId: "tab-1",
            displayNumber: 1,
            label: "T1",
            sessionId: "session-1",
            placement: "popped",
            title: "Data plane",
            status: "queued_for_provider",
            busy: true,
            needsAttention: true,
            mode: "code",
            model: "claude-sonnet-4-6",
            interactiveExecutionPhase: "queued_for_provider",
            estimatedTokens: 100,
            maximumTokens: 10_000,
          },
        ],
      },
    },
    transcript: {
      messages: [
        {
          messageId: "message-1",
          role: "user",
          revision: 1,
          createdAt: 900,
          content: {
            kind: "detail",
            preview: "Implement the relay",
            detailHandle,
          },
          blocks: [],
        },
      ],
      earlierCursor: "cursor-1",
      hasEarlier: true,
    },
    ui: {
      interaction: {
        requestId: "approval-1",
        kind: "approval",
        state: "pending",
        summary: "Approve relay command",
        detailHandle: { ...detailHandle, kind: "interaction" },
      },
      queue: [
        { itemId: "queued-1", summary: "Queued message", state: "queued" },
      ],
      todos: [{ itemId: "todo-1", text: "Add protocol", state: "in_progress" }],
      operations: [
        {
          operationId: "operation-1",
          kind: "session.select",
          state: "accepted",
        },
      ],
    },
    background: [
      {
        sessionId: "background-1",
        title: "Review",
        status: "running",
        updatedAt: 950,
      },
    ],
    fleet: [],
    diffs: [
      {
        requestId: "diff-1",
        filePath: "src/file.ts",
        operation: "modify",
        outsideWorkspace: false,
        createdAt: 925,
        detailHandle: {
          ...detailHandle,
          handleId: "diff-handle",
          kind: "diff",
        },
      },
    ],
    repository: {
      revision: "repository-1",
      branch: "feature/data-plane",
      dirty: true,
      rootLabel: "agentlink",
    },
    theme: {
      revision: "theme-1",
      colorScheme: "dark",
      variables: [{ name: "--vscode-editor-background", value: "#1e1e1e" }],
    },
    modelCatalogRevision: "models-1",
    capabilities: [{ capabilityId: "session.send", state: "enabled" }],
    ...overrides,
  };
}

function event(
  kind: BrowserGatewayOwnerEventKind,
  payload: unknown,
  ownerSequence = 1,
) {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    ...identity,
    ownerSequence,
    eventId: `event-${ownerSequence}`,
    kind,
    emittedAt: 1_000 + ownerSequence,
    payload,
  };
}

const payloadByKind = {
  "foreground.control.updated": {
    foreground: {
      sessionId: "session-1",
      title: "Data plane",
      mode: "code",
      model: "claude-sonnet-4-6",
      status: "running",
      interactiveExecutionPhase: "queued_for_provider",
      streaming: true,
    },
  },
  "session.catalog.updated": {
    catalog: {
      projects: [],
      sessions: [],
      defaultProjectId: null,
      foregroundSessionId: null,
    },
  },
  "transcript.message.appended": {
    message: {
      messageId: "message-2",
      role: "assistant",
      revision: 1,
      createdAt: 1_000,
      content: { kind: "inline", text: "" },
      blocks: [
        {
          type: "text",
          blockId: "block-1",
          text: { kind: "inline", text: "Working" },
        },
      ],
    },
  },
  "transcript.message.upserted": {
    message: {
      messageId: "message-2",
      role: "assistant",
      revision: 2,
      createdAt: 1_000,
      content: { kind: "inline", text: "" },
      blocks: [
        {
          type: "text",
          blockId: "block-1",
          text: { kind: "inline", text: "Working…" },
        },
      ],
    },
  },
  "transcript.block.delta": {
    messageId: "message-2",
    blockId: "block-1",
    field: "text",
    delta: "…",
    revision: 2,
  },
  "transcript.history.prepended": {
    messages: [],
    earlierCursor: null,
    hasEarlier: false,
  },
  "interaction.updated": { interaction: null },
  "queue.updated": { queue: [] },
  "todo.updated": { todos: [] },
  "background.updated": { sessions: [] },
  "fleet.updated": { sessions: [] },
  "diff.preview.updated": { diffs: [] },
  "repository.updated": { repository: null },
  "theme.updated": {
    theme: {
      revision: "theme-2",
      colorScheme: "light",
      variables: [{ name: "--vscode-foreground", value: "#111111" }],
    },
  },
  "model_catalog.revision.updated": { revision: "models-2" },
  "plugin_catalog.revision.updated": { revision: "plugins-2" },
  "owner.capabilities.updated": {
    capabilities: [{ capabilityId: "history.load", state: "enabled" }],
  },
  "operation.updated": {
    operation: {
      operationId: "operation-1",
      kind: "session.select",
      state: "completed",
    },
  },
} satisfies Record<BrowserGatewayOwnerEventKind, unknown>;

function command(kind: BrowserGatewayOwnerCommandKind) {
  const bodies = {
    "session.select": { kind, sessionId: "session-1" },
    "session.detail": {
      kind,
      instanceId: "instance-1",
      controllerEpoch: "controller-1",
      tabId: "tab-2",
      sessionId: "session-2",
    },
    "session.send": {
      kind,
      sessionId: "session-1",
      text: "Continue",
      detailHandles: [],
    },
    "session.stop": { kind, sessionId: "session-1" },
    "approval.respond": {
      kind,
      requestId: "approval-1",
      decision: "approve",
    },
    "question.respond": {
      kind,
      requestId: "question-1",
      responseHandle: { ...detailHandle, kind: "interaction" },
    },
    "history.load": { kind, cursor: "cursor-1", count: 20 },
    "diff.detail": { kind, requestId: "diff-1" },
  } satisfies Record<BrowserGatewayOwnerCommandKind, unknown>;
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    ...identity,
    operationId: `operation-${kind}`,
    emittedAt: 1_000,
    deadlineAt: 16_000,
    deadlineClass: "default" as const,
    idempotency: BROWSER_GATEWAY_COMMAND_IDEMPOTENCY[kind],
    command: bodies[kind],
  };
}

function expectProtocolError(
  action: () => unknown,
  code: BrowserGatewayProtocolError["code"],
  path?: string,
): void {
  try {
    action();
    throw new Error("expected protocol parser to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserGatewayProtocolError);
    expect(error).toMatchObject({ code, ...(path ? { path } : {}) });
  }
}

describe("browser gateway data-plane limits", () => {
  it("allows larger bounded session details without relaxing ordinary detail limits", () => {
    const betweenLimits =
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.authenticatedDetailResponseBytes + 1;
    expect(
      parseBrowserGatewayDetailHandle({
        ...detailHandle,
        kind: "session",
        byteLength: betweenLimits,
      }),
    ).toMatchObject({ kind: "session", byteLength: betweenLimits });
    expectProtocolError(
      () =>
        parseBrowserGatewayDetailHandle({
          ...detailHandle,
          byteLength: betweenLimits,
        }),
      "resource_limit",
      "$.byteLength",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayDetailHandle({
          ...detailHandle,
          kind: "session",
          byteLength:
            BROWSER_GATEWAY_DATA_PLANE_LIMITS.authenticatedSessionDetailResponseBytes +
            1,
        }),
      "resource_limit",
      "$.byteLength",
    );
  });

  it("locks every parent-plan limit and assigns one enforcing owner", () => {
    expect(BROWSER_GATEWAY_DATA_PLANE_LIMITS).toEqual({
      ownerEventPayloadBytes: 262_144,
      ownerPublicationBatchBytes: 524_288,
      ownerPublicationRequestBytes: 2_621_440,
      ownerPublicationBatchWindowMs: 50,
      ownerPublicationQueueBytes: 491_520,
      ownerCommandBytes: 524_288,
      ownerCommandTextBytes: 262_144,
      ownerInlineTranscriptTextBytes: 65_536,
      ownerTranscriptDetailTtlMs: 300_000,
      selectedOwnerCheckpointBytes: 2_097_152,
      selectedOwnerCheckpointUserTurns: 20,
      selectedOwnerCheckpointMessages: 200,
      authenticatedDetailResponseBytes: 8_388_608,
      authenticatedSessionDetailResponseBytes: 33_554_432,
      authenticatedDetailStoreBytes: 33_554_432,
      retainedReplayBytesPerOwnerGeneration: 524_288,
      retainedReplayEventsPerOwnerGeneration: 64,
      retainedReplayAgeMs: 300_000,
      aggregateHelperReplayBytes: 4_194_304,
      browserQueuedSseBytes: 1_048_576,
      backpressureStallDeadlineMs: 10_000,
      cachedBrowserOwners: 4,
      cachedBrowserOwnerBytes: 16_777_216,
      pendingCommandsPerOwner: 32,
      pendingCommandsPerHelper: 128,
      commandDeadlineMs: 15_000,
      maximumLongCommandDeadlineMs: 60_000,
      operationDedupeRecords: 1_000,
      operationDedupeAgeMs: 900_000,
      browserCommandsPerSecond: 10,
      browserCommandBurst: 20,
      selectionChangesPerSecond: 5,
      checkpointRequestsPerSecond: 2,
    });
    expect(Object.keys(BROWSER_GATEWAY_DATA_PLANE_LIMIT_OWNERS).sort()).toEqual(
      Object.keys(BROWSER_GATEWAY_DATA_PLANE_LIMITS).sort(),
    );
  });
});

describe("browser gateway owner protocol", () => {
  it("accepts legacy and typed background result blocks", () => {
    const legacy = checkpoint();
    legacy.transcript.messages[0].blocks = [
      {
        type: "bg_agent_result",
        blockId: "background-result-legacy",
        sessionId: "background-1",
        task: "Review",
        status: "completed",
      },
    ];
    expect(parseBrowserGatewayOwnerCheckpoint(legacy)).toEqual(legacy);

    const typed = checkpoint();
    typed.transcript.messages[0].blocks = [
      {
        type: "bg_agent_result",
        blockId: "background-result-typed",
        sessionId: "background-1",
        task: "Review",
        status: "error",
        resultState: "incomplete_expected_result",
        terminalReason: "incomplete_expected_result",
        partialOutput: { kind: "inline", text: "Partial findings" },
        retrySafe: true,
        agentRetryable: false,
      },
    ];
    expect(parseBrowserGatewayOwnerCheckpoint(typed)).toEqual(typed);
  });

  it("parses a strict bounded checkpoint and a sequence-zero checkpoint batch", () => {
    const parsedCheckpoint = parseBrowserGatewayOwnerCheckpoint(checkpoint());
    expect(parsedCheckpoint).toMatchObject({
      ...identity,
      checkpointSequence: 0,
      foreground: {
        originalPrompt: "Implement the data plane",
        interactiveExecutionPhase: "queued_for_provider",
        statusOverride: "Restoring session",
        thinkingEnabled: false,
        reasoningEffort: "medium",
        lastInputTokens: 11,
        contextBudget: { hardBudget: 175_904 },
        contextHealth: {
          memory: { status: "ready", activeRecordCount: 7 },
          retrieval: { status: "degraded", sourceCount: 12 },
          index: { status: "working", current: 3, total: 10 },
        },
        agentWriteApproval: "session",
        commandApprovalPolicy: "approve-for-me",
        configuredCommandApprovalPolicy: "sensitive",
        restoringSession: true,
        revertRecoveryNotice: {
          workspaceRevision: "workspace-revision-1",
        },
      },
      catalog: {
        chatWorkspace: {
          controllerEpoch: "controller-1",
          focusedTabId: "tab-1",
          tabs: [
            {
              tabId: "tab-1",
              sessionId: "session-1",
              placement: "popped",
              status: "queued_for_provider",
              needsAttention: true,
            },
          ],
        },
      },
      transcript: { hasEarlier: true },
    });

    expect(
      parseBrowserGatewayOwnerPublicationBatch({
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        ...identity,
        batchId: "batch-checkpoint",
        firstSequence: 0,
        lastSequence: 0,
        checkpoint: checkpoint(),
        events: [],
      }),
    ).toMatchObject({ firstSequence: 0, lastSequence: 0 });
  });

  it("parses strict composite browser tab selections", () => {
    expect(
      parseBrowserGatewayChatTabSelection({
        instanceId: "instance-1",
        tabId: "tab-2",
        sessionId: "session-2",
      }),
    ).toEqual({
      instanceId: "instance-1",
      tabId: "tab-2",
      sessionId: "session-2",
    });
    expect(
      parseBrowserGatewayChatTabSelection({
        instanceId: "instance-1",
        tabId: "tab-3",
        sessionId: null,
      }),
    ).toEqual({
      instanceId: "instance-1",
      tabId: "tab-3",
      sessionId: null,
    });
    expectProtocolError(
      () =>
        parseBrowserGatewayChatTabSelection({
          instanceId: "instance-1",
          tabId: "tab-2",
          sessionId: "session-2",
          ownerId: "must-not-cross-boundary",
        }),
      "unknown_field",
      "$.ownerId",
    );
  });

  it("rejects malformed grouped chat workspace summaries", () => {
    const value = checkpoint();
    value.catalog.chatWorkspace!.tabs[0] = {
      ...value.catalog.chatWorkspace!.tabs[0],
      status: "waiting_forever" as "streaming",
    };
    expectProtocolError(
      () => parseBrowserGatewayOwnerCheckpoint(value),
      "invalid_value",
      "$.catalog.chatWorkspace.tabs[0].status",
    );
  });

  it("keeps context health optional for legacy checkpoints", () => {
    const legacyForeground = { ...checkpoint().foreground! };
    delete legacyForeground.contextHealth;

    expect(() =>
      parseBrowserGatewayOwnerCheckpoint(
        checkpoint({ foreground: legacyForeground }),
      ),
    ).not.toThrow();
  });

  it("rejects malformed nested context health", () => {
    for (const [contextHealth, path] of [
      [
        {
          ...checkpoint().foreground!.contextHealth!,
          memory: {
            ...checkpoint().foreground!.contextHealth!.memory,
            status: "secret_backend_state",
          },
        },
        "$.foreground.contextHealth.memory.status",
      ],
      [
        {
          ...checkpoint().foreground!.contextHealth!,
          retrieval: {
            ...checkpoint().foreground!.contextHealth!.retrieval,
            sourceCount: -1,
          },
        },
        "$.foreground.contextHealth.retrieval.sourceCount",
      ],
      [
        {
          ...checkpoint().foreground!.contextHealth!,
          index: {
            ...checkpoint().foreground!.contextHealth!.index,
            rawError: "/Users/test/private-store",
          },
        },
        "$.foreground.contextHealth.index.rawError",
      ],
    ] as const) {
      expectProtocolError(
        () =>
          parseBrowserGatewayOwnerCheckpoint(
            checkpoint({
              foreground: {
                ...checkpoint().foreground!,
                contextHealth: contextHealth as never,
              },
            }),
          ),
        path.endsWith("rawError") ? "unknown_field" : "invalid_value",
        path,
      );
    }
  });

  it("rejects invalid foreground correctness fields", () => {
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCheckpoint(
          checkpoint({
            foreground: {
              ...checkpoint().foreground!,
              interactiveExecutionPhase: "waiting_forever" as "running",
            },
          }),
        ),
      "invalid_value",
      "$.foreground.interactiveExecutionPhase",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCheckpoint(
          checkpoint({
            foreground: {
              ...checkpoint().foreground!,
              reasoningEffort: "extreme" as "high",
            },
          }),
        ),
      "invalid_value",
      "$.foreground.reasoningEffort",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCheckpoint(
          checkpoint({
            foreground: {
              ...checkpoint().foreground!,
              contextBudget: {
                ...checkpoint().foreground!.contextBudget!,
                usedInputTokens: -1,
              },
            },
          }),
        ),
      "invalid_value",
      "$.foreground.contextBudget.usedInputTokens",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCheckpoint(
          checkpoint({
            foreground: {
              ...checkpoint().foreground!,
              condenseThreshold: 1.01,
            },
          }),
        ),
      "invalid_value",
      "$.foreground.condenseThreshold",
    );
    for (const [field, value] of [
      ["maxInputTokens", 200_001],
      ["outputReservation", 200_001],
      ["safetyBufferTokens", 180_001],
      ["softThresholdBudget", 180_001],
      ["hardBudget", 180_001],
    ] as const) {
      expectProtocolError(
        () =>
          parseBrowserGatewayOwnerCheckpoint(
            checkpoint({
              foreground: {
                ...checkpoint().foreground!,
                contextBudget: {
                  ...checkpoint().foreground!.contextBudget!,
                  [field]: value,
                },
              },
            }),
          ),
        "invalid_value",
        `$.foreground.contextBudget.${field}`,
      );
    }
    expect(() =>
      parseBrowserGatewayOwnerCheckpoint(
        checkpoint({
          foreground: {
            ...checkpoint().foreground!,
            contextBudget: {
              ...checkpoint().foreground!.contextBudget!,
              usedInputTokens: 200_001,
            },
          },
        }),
      ),
    ).not.toThrow();
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCheckpoint(
          checkpoint({
            foreground: {
              ...checkpoint().foreground!,
              revertRecoveryNotice: {
                ...checkpoint().foreground!.revertRecoveryNotice!,
                privateState: "must-not-cross-wire",
              } as never,
            },
          }),
        ),
      "unknown_field",
      "$.foreground.revertRecoveryNotice.privateState",
    );
  });

  it.each(BROWSER_GATEWAY_OWNER_EVENT_KINDS)(
    "parses allowlisted %s payloads",
    (kind) => {
      expect(
        parseBrowserGatewayOwnerEvent(event(kind, payloadByKind[kind])),
      ).toMatchObject({ kind, payload: payloadByKind[kind] });
    },
  );

  it("parses the full browser-safe transcript DTO allowlist", () => {
    const message = {
      messageId: "message-full",
      role: "assistant",
      revision: 7,
      createdAt: 1_000,
      content: { kind: "inline", text: "Visible content" },
      blocks: [
        {
          type: "thinking",
          blockId: "thinking-1",
          text: { kind: "inline", text: "Sanitized reasoning" },
          complete: true,
        },
        {
          type: "text",
          blockId: "text-1",
          text: { kind: "inline", text: "Visible text" },
        },
        {
          type: "tool_call",
          blockId: "tool-1",
          toolCallId: "tool-1",
          name: "read_file",
          complete: true,
          durationMs: 10,
        },
        {
          type: "skill_load",
          blockId: "skill-1",
          skillName: "documentation",
          complete: true,
          durationMs: 11,
        },
        {
          type: "bg_agent",
          blockId: "background-1",
          sessionId: "session-background",
          task: "Review",
          resolvedModel: "gpt-5.6-sol",
          resolvedProvider: "codex",
          reasoningEffort: "high",
          resolvedMode: "review",
          taskClass: "review_code",
        },
        {
          type: "bg_agent_result",
          blockId: "background-result-1",
          sessionId: "session-background",
          task: "Review",
          status: "completed",
          result: {
            kind: "detail",
            preview: "Long result",
            detailHandle,
          },
          summary: "No findings",
        },
        {
          type: "question_answer",
          blockId: "question-1",
          toolCallId: "tool-ask-1",
          items: [
            {
              question: "Proceed?",
              answer: ["Yes"],
              note: "Recommended",
            },
          ],
        },
        {
          type: "pairing_status",
          blockId: "pairing-1",
          status: "consumed",
          expiresAt: 2_000,
          deviceLabel: "Phone",
        },
      ],
      badge: "follow-up",
      isSlashCommand: true,
      slashCommandLabel: "/continue",
      origin: "browser",
      checkpointId: "checkpoint-1",
      finalMarker: {
        status: "completed",
        summary: "Done",
        source: "tool",
        continueAction: { label: "Continue", prompt: "Continue work" },
        continueActionConsumed: false,
        autoContinueStopReason: "none",
      },
      surfaceChange: {
        model: { previousModel: "gpt-5.4", model: "gpt-5.6-sol" },
        reasoning: {
          previousReasoningEffort: "high",
          reasoningEffort: "low",
        },
        mode: { previousMode: "ask", mode: "code" },
      },
      error: {
        message: "Recoverable",
        retryable: true,
        code: "temporary",
        actions: { signIn: true, signInAnotherAccount: false, condense: true },
      },
      apiRequest: {
        requestId: "request-1",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        mode: "code",
        commandApprovalPolicy: "approve-for-me",
        inputTokens: 100,
        uncachedInputTokens: 80,
        cacheReadTokens: 20,
        cacheCreationTokens: 10,
        outputTokens: 50,
        durationMs: 1_000,
        timeToFirstToken: 100,
      },
      condenseInfo: {
        prevInputTokens: 100,
        newInputTokens: 50,
        durationMs: 20,
        errorMessage: "Recovered",
        condensing: false,
        validationWarnings: ["warning"],
      },
      warningMessage: "Warning",
      warningRetry: {
        retryDelayMs: 100,
        retryAt: 1_100,
        retryAttempt: 1,
        retryMaxAttempts: 3,
      },
    };

    expect(
      parseBrowserGatewayOwnerEvent(
        event("transcript.message.appended", { message }),
      ),
    ).toMatchObject({ payload: { message } });
  });

  it("rejects private transcript fields, invalid detail kinds, and oversized inline text", () => {
    const baseMessage = (
      payloadByKind["transcript.message.appended"] as {
        message: Record<string, unknown>;
      }
    ).message;
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerEvent(
          event("transcript.message.appended", {
            message: {
              ...baseMessage,
              blocks: [
                {
                  type: "tool_call",
                  blockId: "tool-1",
                  toolCallId: "tool-1",
                  name: "read_file",
                  complete: true,
                  inputJson: '{"secret":"PRIVATE_INPUT"}',
                },
              ],
            },
          }),
        ),
      "unknown_field",
      "$.payload.message.blocks[0].inputJson",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerEvent(
          event("transcript.message.appended", {
            message: {
              ...baseMessage,
              content: {
                kind: "detail",
                preview: "wrong kind",
                detailHandle: { ...detailHandle, kind: "diff" },
              },
            },
          }),
        ),
      "invalid_value",
      "$.payload.message.content.detailHandle.kind",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerEvent(
          event("transcript.message.appended", {
            message: {
              ...baseMessage,
              content: {
                kind: "inline",
                text: "é".repeat(
                  BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerInlineTranscriptTextBytes /
                    2 +
                    1,
                ),
              },
            },
          }),
        ),
      "resource_limit",
      "$.payload.message.content.text",
    );
  });

  it("parses a checkpoint barrier followed by contiguous events", () => {
    const first = event(
      "model_catalog.revision.updated",
      payloadByKind["model_catalog.revision.updated"],
      1,
    );
    const second = event(
      "operation.updated",
      payloadByKind["operation.updated"],
      2,
    );
    expect(
      parseBrowserGatewayOwnerPublicationBatch({
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        ...identity,
        batchId: "batch-1",
        firstSequence: 1,
        lastSequence: 2,
        checkpoint: checkpoint(),
        events: [first, second],
      }),
    ).toMatchObject({ firstSequence: 1, lastSequence: 2 });
  });

  it("rejects unsupported versions and event kinds", () => {
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerEvent({
          ...event(
            "model_catalog.revision.updated",
            payloadByKind["model_catalog.revision.updated"],
          ),
          protocolVersion: "2",
        }),
      "unsupported_version",
      "$.protocolVersion",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerEvent({
          ...event(
            "model_catalog.revision.updated",
            payloadByKind["model_catalog.revision.updated"],
          ),
          kind: "raw.app.action",
        }),
      "unsupported_kind",
      "$.kind",
    );
  });

  it("rejects raw tool block deltas", () => {
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerEvent(
          event("transcript.block.delta", {
            messageId: "message-2",
            blockId: "tool-1",
            field: "tool",
            delta: "PRIVATE_TOOL_RESULT",
            revision: 2,
          }),
        ),
      "invalid_value",
      "$.payload.field",
    );
  });

  it("rejects unknown root, nested, and raw secret-bearing fields", () => {
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerEvent({
          ...event(
            "model_catalog.revision.updated",
            payloadByKind["model_catalog.revision.updated"],
          ),
          authLease: "PRIVATE_AUTH_LEASE",
        }),
      "unknown_field",
      "$.authLease",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerEvent(
          event("transcript.message.appended", {
            message: {
              ...(
                payloadByKind["transcript.message.appended"] as {
                  message: Record<string, unknown>;
                }
              ).message,
              rawToolResult: { apiKey: "PRIVATE_API_KEY" },
            },
          }),
        ),
      "unknown_field",
      "$.payload.message.rawToolResult",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerEvent(
          event("interaction.updated", {
            interaction: {
              requestId: "question-1",
              kind: "question",
              state: "pending",
              summary: "Question",
              rawRequest: { systemPrompt: "PRIVATE_SYSTEM_PROMPT" },
            },
          }),
        ),
      "unknown_field",
      "$.payload.interaction.rawRequest",
    );
  });

  it("rejects identity mismatches, sequence gaps, and checkpoint overlap", () => {
    const first = event(
      "model_catalog.revision.updated",
      payloadByKind["model_catalog.revision.updated"],
      1,
    );
    const third = event(
      "operation.updated",
      payloadByKind["operation.updated"],
      3,
    );
    const baseBatch = {
      protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
      ...identity,
      batchId: "batch-invalid",
      firstSequence: 1,
      lastSequence: 3,
      checkpoint: checkpoint(),
      events: [first, third],
    };
    expectProtocolError(
      () => parseBrowserGatewayOwnerPublicationBatch(baseBatch),
      "sequence_mismatch",
      "$.events[1].ownerSequence",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerPublicationBatch({
          ...baseBatch,
          lastSequence: 1,
          events: [{ ...first, ownerGenerationId: "foreign-generation" }],
        }),
      "identity_mismatch",
      "$.events[0]",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerPublicationBatch({
          ...baseBatch,
          firstSequence: 1,
          lastSequence: 1,
          checkpoint: checkpoint({ checkpointSequence: 1 }),
          events: [first],
        }),
      "sequence_mismatch",
      "$.checkpoint.checkpointSequence",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerPublicationBatch({
          ...baseBatch,
          firstSequence: 2,
          lastSequence: 2,
          checkpoint: checkpoint({ checkpointSequence: 0 }),
          events: [{ ...first, ownerSequence: 2 }],
        }),
      "sequence_mismatch",
      "$.checkpoint.checkpointSequence",
    );
  });

  it("rejects oversized publication batches and non-serializable envelopes", () => {
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerPublicationBatch({
          protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
          ...identity,
          batchId: "batch-envelope-large",
          firstSequence: 1,
          lastSequence: 3,
          checkpoint: null,
          events: Array.from({ length: 3 }, (_, index) =>
            event(
              "transcript.block.delta",
              {
                messageId: "message-1",
                blockId: `block-${index + 1}`,
                field: "text",
                delta: "x".repeat(180 * 1024),
                revision: index + 1,
              },
              index + 1,
            ),
          ),
        }),
      "resource_limit",
      "$",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCommand({
          ...command("session.select"),
          nonSerializable: 1n,
        }),
      "invalid_value",
      "$",
    );
  });

  it("enforces event payload limits even inside a batch", () => {
    const oversized = event("transcript.block.delta", {
      messageId: "message-1",
      blockId: "block-1",
      field: "text",
      delta: "x".repeat(
        BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerEventPayloadBytes + 1,
      ),
      revision: 1,
    });
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerPublicationBatch({
          protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
          ...identity,
          batchId: "batch-large",
          firstSequence: 1,
          lastSequence: 1,
          checkpoint: null,
          events: [oversized],
        }),
      "resource_limit",
      "$.events[0].payload",
    );
  });

  it("accounts checkpoint and publication envelope byte budgets independently", () => {
    const largeCheckpoint = checkpoint({
      transcript: {
        messages: Array.from({ length: 100 }, (_, index) => ({
          messageId: `assistant-${index}`,
          role: "assistant" as const,
          revision: 1,
          createdAt: index,
          content: { kind: "inline" as const, text: "x".repeat(7_000) },
          blocks: [],
        })),
        earlierCursor: null,
        hasEarlier: false,
      },
    });
    expect(JSON.stringify(largeCheckpoint).length).toBeGreaterThan(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerPublicationBatchBytes,
    );
    expect(() =>
      parseBrowserGatewayOwnerPublicationBatch({
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        ...identity,
        batchId: "large-checkpoint",
        firstSequence: 0,
        lastSequence: 0,
        checkpoint: largeCheckpoint,
        events: [],
      }),
    ).not.toThrow();

    const largeEvents = Array.from({ length: 3 }, (_, index) =>
      event(
        "transcript.block.delta",
        {
          messageId: "message-1",
          blockId: `block-${index}`,
          field: "text",
          delta: "x".repeat(200_000),
          revision: index + 1,
        },
        index + 1,
      ),
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerPublicationBatch({
          protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
          ...identity,
          batchId: "oversized-envelope",
          firstSequence: 1,
          lastSequence: 3,
          checkpoint: null,
          events: largeEvents,
        }),
      "resource_limit",
      "$",
    );
  });

  it("enforces checkpoint message and user-turn limits", () => {
    const assistantMessages = Array.from({ length: 201 }, (_, index) => ({
      messageId: `assistant-${index}`,
      role: "assistant" as const,
      revision: 1,
      createdAt: index,
      content: { kind: "inline" as const, text: "message" },
      blocks: [],
    }));
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCheckpoint(
          checkpoint({
            transcript: {
              messages: assistantMessages,
              earlierCursor: null,
              hasEarlier: false,
            },
          }),
        ),
      "resource_limit",
      "$.transcript.messages",
    );

    const userMessages = Array.from({ length: 21 }, (_, index) => ({
      messageId: `user-${index}`,
      role: "user" as const,
      revision: 1,
      createdAt: index,
      content: { kind: "inline" as const, text: "message" },
      blocks: [],
    }));
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCheckpoint(
          checkpoint({
            transcript: {
              messages: userMessages,
              earlierCursor: null,
              hasEarlier: false,
            },
          }),
        ),
      "resource_limit",
      "$.transcript.messages",
    );
  });

  it.each(
    Object.keys(
      BROWSER_GATEWAY_COMMAND_IDEMPOTENCY,
    ) as BrowserGatewayOwnerCommandKind[],
  )("parses %s with its declared idempotency", (kind) => {
    expect(parseBrowserGatewayOwnerCommand(command(kind))).toMatchObject({
      idempotency: BROWSER_GATEWAY_COMMAND_IDEMPOTENCY[kind],
      command: { kind },
    });
  });

  it("parses a complete detached session detail address and rejects stale identity shapes", () => {
    expect(
      parseBrowserGatewayOwnerCommand(command("session.detail")),
    ).toMatchObject({
      idempotency: "idempotent",
      command: {
        kind: "session.detail",
        instanceId: "instance-1",
        controllerEpoch: "controller-1",
        tabId: "tab-2",
        sessionId: "session-2",
      },
    });
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCommand({
          ...command("session.detail"),
          command: {
            kind: "session.detail",
            instanceId: "instance-1",
            controllerEpoch: "",
            tabId: "tab-2",
            sessionId: "session-2",
          },
        }),
      "invalid_value",
      "$.command.controllerEpoch",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCommand({
          ...command("session.detail"),
          command: {
            kind: "session.detail",
            instanceId: "instance-1",
            controllerEpoch: "controller-1",
            tabId: "tab-2",
            sessionId: "session-2",
            foreground: true,
          },
        }),
      "unknown_field",
      "$.command.foreground",
    );
  });

  it("enforces declared deadline classes at their exact boundaries", () => {
    expect(
      parseBrowserGatewayOwnerCommand({
        ...command("session.select"),
        deadlineAt: 1_000 + BROWSER_GATEWAY_DATA_PLANE_LIMITS.commandDeadlineMs,
      }),
    ).toMatchObject({ deadlineClass: "default" });
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCommand({
          ...command("session.select"),
          deadlineAt:
            1_000 + BROWSER_GATEWAY_DATA_PLANE_LIMITS.commandDeadlineMs + 1,
        }),
      "invalid_value",
      "$.deadlineAt",
    );

    expect(
      parseBrowserGatewayOwnerCommand({
        ...command("session.select"),
        deadlineClass: "long",
        deadlineAt:
          1_000 +
          BROWSER_GATEWAY_DATA_PLANE_LIMITS.maximumLongCommandDeadlineMs,
      }),
    ).toMatchObject({ deadlineClass: "long" });
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCommand({
          ...command("session.select"),
          deadlineClass: "long",
          deadlineAt:
            1_000 +
            BROWSER_GATEWAY_DATA_PLANE_LIMITS.maximumLongCommandDeadlineMs +
            1,
        }),
      "invalid_value",
      "$.deadlineAt",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCommand({
          ...command("session.select"),
          deadlineClass: "extended",
        }),
      "invalid_value",
      "$.deadlineClass",
    );
  });

  it("enforces command text and envelope limits in UTF-8 bytes", () => {
    const maximumText = "x".repeat(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerCommandTextBytes,
    );
    expect(
      parseBrowserGatewayOwnerCommand({
        ...command("session.send"),
        command: {
          kind: "session.send",
          sessionId: "session-1",
          text: maximumText,
          detailHandles: [],
        },
      }),
    ).toMatchObject({ command: { text: maximumText } });

    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCommand({
          ...command("session.send"),
          command: {
            kind: "session.send",
            sessionId: "session-1",
            text: "é".repeat(
              BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerCommandTextBytes / 2 + 1,
            ),
            detailHandles: [],
          },
        }),
      "resource_limit",
      "$.command.text",
    );

    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCommand({
          ...command("session.send"),
          command: {
            kind: "session.send",
            sessionId: "session-1",
            text: "",
            detailHandles: Array.from({ length: 4_000 }, (_, index) => ({
              ...detailHandle,
              handleId: `handle-${index}-${"x".repeat(100)}`,
            })),
          },
        }),
      "resource_limit",
      "$",
    );
  });

  it("rejects incorrect idempotency, fractional timestamps, and history limits", () => {
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCommand({
          ...command("session.send"),
          idempotency: "idempotent",
        }),
      "invalid_value",
      "$.idempotency",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCommand({
          ...command("session.select"),
          emittedAt: 1_000.5,
        }),
      "invalid_value",
      "$.emittedAt",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCommand({
          ...command("session.select"),
          command: {
            kind: "session.select",
            sessionId: "session-1",
            unexpected: true,
          },
        }),
      "unknown_field",
      "$.command.unexpected",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCommand({
          ...command("history.load"),
          command: {
            kind: "history.load",
            cursor: "cursor-1",
            count:
              BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointMessages +
              1,
          },
        }),
      "resource_limit",
      "$.command.count",
    );
  });

  it("parses strict owner control envelopes and rejects unknown controls", () => {
    expect(
      parseBrowserGatewayOwnerControl({
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        ...identity,
        kind: "hello",
        emittedAt: 1_000,
        payload: { publicationCursor: 4, subscriberCount: 2 },
      }),
    ).toMatchObject({
      kind: "hello",
      payload: { publicationCursor: 4, subscriberCount: 2 },
    });
    expect(
      parseBrowserGatewayOwnerControl({
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        ...identity,
        kind: "drain",
        emittedAt: 1_000,
        payload: { deadlineAt: 2_000 },
      }),
    ).toMatchObject({ kind: "drain", payload: { deadlineAt: 2_000 } });
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerControl({
          protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
          ...identity,
          kind: "future.control",
          emittedAt: 1_000,
          payload: {},
        }),
      "unsupported_kind",
      "$.kind",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerControl({
          protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
          ...identity,
          kind: "demand.changed",
          emittedAt: 1_000,
          payload: { subscriberCount: 1, rawState: {} },
        }),
      "unknown_field",
      "$.payload.rawState",
    );
  });

  it("parses strict registration, acknowledgement, and reset envelopes", () => {
    expect(
      parseBrowserGatewayOwnerRegistration({
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        ...identity,
        requestedOwnerId: "workspace-owner",
        displayName: "Workspace",
        ownerKind: "vscode",
        scope: {
          kind: "workspace",
          workspaceId: "workspace-1",
          displayName: "Workspace",
        },
        capabilities: [{ capabilityId: "session.send", state: "enabled" }],
        registeredAt: 1_000,
      }),
    ).toMatchObject({ requestedOwnerId: "workspace-owner" });

    expect(
      parseBrowserGatewayOwnerCommandAck({
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        ...identity,
        operation: {
          operationId: "operation-1",
          kind: "session.select",
          state: "completed",
        },
        acknowledgedAt: 2_000,
      }),
    ).toMatchObject({ operation: { state: "completed" } });

    expect(
      parseBrowserGatewayRelayReset({
        protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
        ...identity,
        reason: "sequence_gap",
        latestSequence: 12,
        subscriptionId: "subscription-1",
      }),
    ).toMatchObject({ reason: "sequence_gap", latestSequence: 12 });
  });

  it.each([
    "url(https://example.invalid/tracker)",
    "\\000075rl(https://example.invalid/tracker)",
    "image-set(url(https://example.invalid/tracker) 1x)",
    "cross-fade(url(https://example.invalid/tracker), #fff)",
    "red; background: url(https://example.invalid/tracker)",
    "red\\3b background: url(https://example.invalid/tracker)",
    "#fff\\",
    "#fff\\\n",
  ])("rejects unsafe theme value %s", (value) => {
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerEvent(
          event("theme.updated", {
            theme: {
              revision: "theme-unsafe",
              colorScheme: "dark",
              variables: [{ name: "--vscode-editor-background", value }],
            },
          }),
        ),
      "invalid_value",
      "$.payload.theme.variables[0].value",
    );
  });

  it("rejects unsafe theme variable names and oversized detail handles", () => {
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerEvent(
          event("theme.updated", {
            theme: {
              revision: "theme-unsafe-name",
              colorScheme: "dark",
              variables: [{ name: "--custom-background", value: "#1e1e1e" }],
            },
          }),
        ),
      "invalid_value",
      "$.payload.theme.variables[0].name",
    );
    expectProtocolError(
      () =>
        parseBrowserGatewayOwnerCommand({
          ...command("question.respond"),
          command: {
            kind: "question.respond",
            requestId: "question-1",
            responseHandle: {
              ...detailHandle,
              byteLength:
                BROWSER_GATEWAY_DATA_PLANE_LIMITS.authenticatedDetailResponseBytes +
                1,
            },
          },
        }),
      "resource_limit",
      "$.command.responseHandle.byteLength",
    );
  });
});
