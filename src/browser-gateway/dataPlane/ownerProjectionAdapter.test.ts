import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../agent/webview/types.js";
import type { BrowserGatewayOwnerInteractionPayload } from "./interactionPayload.js";
import { BROWSER_GATEWAY_DATA_PLANE_LIMITS } from "./limits.js";
import { BrowserGatewayProtocolError } from "./protocol.js";
import {
  BrowserGatewayOwnerProjectionAdapter,
  type BrowserGatewayOwnerProjectionPublication,
} from "./ownerProjectionAdapter.js";
import type {
  BrowserGatewayOwnerProjectionReadSet,
  BrowserGatewayOwnerProjectionSourceKind,
  BrowserGatewayOwnerProjectionSources,
} from "./ownerProjectionSources.js";

const identity = {
  helperGenerationId: "helper-generation-1",
  ownerId: "owner-1",
  ownerGenerationId: "owner-generation-1",
};

class ProjectionSources implements BrowserGatewayOwnerProjectionSources {
  captureCount = 0;
  private listener:
    | ((source: BrowserGatewayOwnerProjectionSourceKind) => void)
    | undefined;

  constructor(readonly readSet: BrowserGatewayOwnerProjectionReadSet) {}

  capture(): BrowserGatewayOwnerProjectionReadSet {
    this.captureCount += 1;
    return this.readSet;
  }

  onDidChange(
    listener: (source: BrowserGatewayOwnerProjectionSourceKind) => void,
  ): { dispose(): void } {
    this.listener = listener;
    return {
      dispose: () => {
        if (this.listener === listener) this.listener = undefined;
      },
    };
  }

  fire(source: BrowserGatewayOwnerProjectionSourceKind): void {
    this.listener?.(source);
  }
}

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
  timestamp: number,
  blocks: ChatMessage["blocks"] = [],
): ChatMessage {
  return { id, role, content, timestamp, blocks };
}

function readSet(): BrowserGatewayOwnerProjectionReadSet {
  return {
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
          title: "Relay work",
          mode: "code",
          model: "gpt-5.6-sol",
          messageCount: 2,
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
            title: "Relay work",
            status: "queued_for_provider",
            busy: true,
            needsAttention: true,
            mode: "code",
            model: "gpt-5.6-sol",
            interactiveExecutionPhase: "queued_for_provider",
            estimatedTokens: 1_000,
            maximumTokens: 200_000,
          },
          {
            tabId: "tab-2",
            displayNumber: 2,
            label: "T2",
            sessionId: null,
            placement: "docked",
            status: "idle",
            busy: false,
          },
        ],
      },
    },
    foreground: {
      sessionId: "session-1",
      title: "Relay work",
      originalPrompt: "Review the relay implementation",
      mode: "code",
      model: "gpt-5.6-sol",
      status: "streaming",
      interactiveExecutionPhase: "queued_for_provider",
      streaming: true,
      interrupted: true,
      estimatedTokens: 1_000,
      maximumTokens: 200_000,
      statusOverride: "Refreshing credentials…",
      thinkingEnabled: false,
      reasoningEffort: "medium",
      lastInputTokens: 101,
      lastOutputTokens: 202,
      lastCacheReadTokens: 303,
      contextBudget: {
        contextWindow: 200_000,
        maxInputTokens: 180_000,
        usedInputTokens: 101,
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
      restoringSession: true,
      revertRecoveryNotice: {
        projectId: "project-1",
        checkpointId: "checkpoint-1",
        sessionRevision: "session-revision-1",
        workspaceRevision: "workspace-revision-1",
        startedAt: 750,
        title: "Recovery required",
        message: "Restore the reverted workspace state.",
      },
      messages: [
        message("message-user", "user", "Implement the relay", 800),
        message("message-assistant", "assistant", "", 900, [
          {
            type: "thinking",
            id: "thinking-1",
            text: "PRIVATE_THOUGHT",
            complete: true,
          },
          {
            type: "tool_call",
            id: "tool-1",
            name: "read_file",
            inputJson: '{"secret":"PRIVATE_INPUT"}',
            result: "PRIVATE_TOOL_RESULT",
            resultImages: [{ mimeType: "image/png", data: "PRIVATE_IMAGE" }],
            complete: true,
          },
          { type: "text", text: "Visible response" },
        ]),
      ],
      earlierCursor: "cursor-1",
      hasEarlier: true,
      cursorBeforeMessage: (messageId) => `before:${messageId}`,
      queue: [{ id: "queued-1", text: "Queued follow-up" }],
      todos: [
        {
          id: "todo-1",
          content: "Implement adapter",
          activeForm: "Implementing adapter",
          status: "in_progress",
          children: [
            {
              id: "todo-child",
              content: "Add tests",
              activeForm: "Adding tests",
              status: "pending",
            },
          ],
        },
      ],
    },
    interaction: {
      requestId: "approval-1",
      kind: "approval",
      backgroundTask: "Review relay",
      payload: {
        approval: {
          id: "approval-1",
          kind: "command",
          command: "npm test",
        },
        question: null,
        questionProgress: null,
        formElicitation: null,
        urlElicitation: null,
      },
    },
    background: [
      {
        sessionId: "background-1",
        title: "Review",
        status: "streaming",
        updatedAt: 950,
      },
    ],
    fleet: [],
    diffs: [
      {
        requestId: "diff-1",
        filePath: "src/browser-gateway/dataPlane/ownerProjectionAdapter.ts",
        operation: "modify",
        outsideWorkspace: false,
        createdAt: 925,
      },
    ],
    repository: {
      projectId: "project-1",
      branch: "feature/data-plane",
      dirty: true,
    },
    theme: {
      cssVariables: {
        "--vscode-editor-background": "#1e1e1e",
        "--vscode-foreground": "#cccccc",
        "--private-variable": "PRIVATE_THEME_VALUE",
      },
      colorScheme: "dark",
    },
    modelCatalogRevision: "models-1",
    mcp: [
      { name: "connected-server", status: "connected" },
      { name: "disabled-server", status: "disabled" },
    ],
    policies: {
      agentWriteApproval: "prompt",
      commandApprovalPolicy: "safe",
      approvalPolicy: "on-request",
      approvalReviewer: "user",
      executionPreset: "native-manual",
      configuredCommandApprovalPolicy: "safe",
    },
  };
}

function makeAdapter(
  sources: ProjectionSources,
  options: {
    now?: () => number;
    dataPlaneFeatures?: readonly ["typed-background-results-v1"];
  } = {},
) {
  return new BrowserGatewayOwnerProjectionAdapter(sources, identity, {
    now: options.now ?? (() => 1_000),
    createId: (kind, sequence) => `${kind}-${sequence}`,
    dataPlaneFeatures: options.dataPlaneFeatures,
  });
}

describe("BrowserGatewayOwnerProjectionAdapter", () => {
  it("capability-gates typed background result fields", () => {
    const source = readSet();
    source.foreground = {
      ...source.foreground!,
      messages: [
        ...source.foreground!.messages,
        message("background-result", "assistant", "", 950, [
          {
            type: "bg_agent_result",
            sessionId: "background-1",
            task: "Review",
            status: "error",
            resultState: "incomplete_expected_result",
            terminalReason: "incomplete_expected_result",
            partialOutput: "Recovered partial findings",
            retrySafe: true,
            agentRetryable: false,
          },
        ]),
      ],
    };

    const legacy = makeAdapter(new ProjectionSources(source)).getCheckpoint();
    const capable = makeAdapter(new ProjectionSources(source), {
      dataPlaneFeatures: ["typed-background-results-v1"],
    }).getCheckpoint();
    const legacyBlock = legacy.transcript.messages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === "bg_agent_result");
    const capableBlock = capable.transcript.messages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === "bg_agent_result");

    expect(legacyBlock).toEqual(
      expect.objectContaining({
        type: "bg_agent_result",
        status: "error",
      }),
    );
    expect(legacyBlock).not.toHaveProperty("resultState");
    expect(legacyBlock).not.toHaveProperty("partialOutput");
    expect(legacyBlock).toMatchObject({
      result: {
        kind: "inline",
        text: "Recovered partial findings",
      },
    });
    expect(capableBlock).toMatchObject({
      type: "bg_agent_result",
      status: "error",
      resultState: "incomplete_expected_result",
      terminalReason: "incomplete_expected_result",
      partialOutput: {
        kind: "inline",
        text: "Recovered partial findings",
      },
      retrySafe: true,
      agentRetryable: false,
    });
  });

  it("does no projection work without demand and starts each demand period with a checkpoint", () => {
    const sources = new ProjectionSources(readSet());
    const adapter = makeAdapter(sources);
    const publications: BrowserGatewayOwnerProjectionPublication[] = [];
    adapter.onDidPublish((publication) => publications.push(publication));

    sources.fire("foreground");
    expect(sources.captureCount).toBe(0);
    expect(publications).toEqual([]);

    adapter.setDemanded(true);
    expect(sources.captureCount).toBe(1);
    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({
      kind: "checkpoint",
      checkpoint: { checkpointSequence: 0, checkpointId: "checkpoint-0" },
    });

    adapter.setDemanded(false);
    sources.fire("theme");
    expect(sources.captureCount).toBe(1);

    adapter.setDemanded(true);
    expect(sources.captureCount).toBe(2);
    expect(publications.at(-1)).toMatchObject({ kind: "checkpoint" });
  });

  it("publishes concurrent browser interaction state through one detail handle", () => {
    const payload: BrowserGatewayOwnerInteractionPayload = {
      approval: {
        id: "approval-1",
        kind: "command",
        command: "npm test",
      },
      question: {
        id: "question-1",
        context: "Choose whether to continue.",
        questions: [{ id: "continue", type: "yes_no", question: "Continue?" }],
      },
      questionProgress: {
        id: "question-1",
        step: 0,
        answers: { continue: true },
        notes: { continue: "Confirmed" },
        origin: "browser",
      },
      formElicitation: {
        id: "form-1",
        serverName: "example-mcp",
        message: "Choose a branch.",
        fields: [
          {
            name: "branch",
            title: "Branch",
            kind: "string",
            required: true,
          },
        ],
      },
      urlElicitation: {
        id: "url-1",
        serverName: "example-mcp",
        message: "Open the authorization page.",
        url: "https://example.com/authorize",
        elicitationId: "elicitation-1",
        origin: "https://example.com",
        host: "example.com",
        isLocalAddress: false,
      },
    };
    const value = readSet();
    value.interaction = {
      requestId: payload.approval!.id,
      kind: "approval",
      payload,
    };
    const adapter = makeAdapter(new ProjectionSources(value));
    const publication = adapter.getCheckpointPublication();
    const handle = publication.checkpoint.ui.interaction?.detailHandle;

    expect(handle).toMatchObject({
      kind: "interaction",
      helperGenerationId: identity.helperGenerationId,
      ownerId: identity.ownerId,
      ownerGenerationId: identity.ownerGenerationId,
      mediaType: "application/json; charset=utf-8",
    });
    const detail = publication.details?.find(
      (candidate) => candidate.handle.handleId === handle?.handleId,
    );
    expect(JSON.parse(new TextDecoder().decode(detail?.content))).toEqual(
      payload,
    );
    adapter.dispose();
  });

  it("suppresses mismatched interaction payloads that cannot be hydrated", () => {
    const value = readSet();
    value.interaction = {
      requestId: "approval-1",
      kind: "approval",
      payload: {
        approval: {
          id: "different-approval",
          kind: "command",
          command: "npm test",
        },
        question: null,
        questionProgress: null,
        formElicitation: null,
        urlElicitation: null,
      },
    };
    const adapter = makeAdapter(new ProjectionSources(value));
    const publication = adapter.getCheckpointPublication();

    expect(publication.checkpoint.ui.interaction).toBeNull();
    expect(publication.details).toBeUndefined();
    adapter.dispose();
  });

  it("publishes secondary interaction changes while approval remains primary", () => {
    const value = readSet();
    value.interaction = {
      requestId: "approval-1",
      kind: "approval",
      payload: {
        approval: { id: "approval-1", kind: "command", command: "npm test" },
        question: {
          id: "question-1",
          context: "Continue?",
          questions: [
            { id: "continue", type: "yes_no", question: "Continue?" },
          ],
        },
        questionProgress: null,
        formElicitation: null,
        urlElicitation: null,
      },
    };
    const sources = new ProjectionSources(value);
    const adapter = makeAdapter(sources);
    const publications: BrowserGatewayOwnerProjectionPublication[] = [];
    adapter.onDidPublish((publication) => publications.push(publication));
    adapter.setDemanded(true);
    const initialPublication = publications.at(-1);
    expect(initialPublication?.kind).toBe("checkpoint");
    const initialHandle =
      initialPublication?.kind === "checkpoint"
        ? initialPublication.checkpoint.ui.interaction?.detailHandle?.handleId
        : undefined;

    value.interaction.payload!.questionProgress = {
      id: "question-1",
      step: 0,
      answers: { continue: true },
      notes: {},
      origin: "browser",
    };
    sources.fire("ui");

    const updated = publications.at(-1);
    expect(updated).toMatchObject({
      kind: "event",
      event: {
        kind: "interaction.updated",
        payload: { interaction: { requestId: "approval-1", kind: "approval" } },
      },
    });
    expect(updated?.kind === "event" ? updated.event.payload : null).toEqual(
      expect.objectContaining({
        interaction: expect.objectContaining({
          detailHandle: expect.objectContaining({
            handleId: expect.not.stringMatching(`^${initialHandle}$`),
          }),
        }),
      }),
    );
    adapter.dispose();
  });

  it("constructs a browser-safe checkpoint and reads sources exactly once", () => {
    const sources = new ProjectionSources(readSet());
    const adapter = makeAdapter(sources);
    const checkpoint = adapter.getCheckpoint();
    const serialized = JSON.stringify(checkpoint);

    expect(sources.captureCount).toBe(1);
    expect(checkpoint.catalog).toMatchObject({
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
            status: "queued_for_provider",
            busy: true,
            needsAttention: true,
            mode: "code",
            model: "gpt-5.6-sol",
            interactiveExecutionPhase: "queued_for_provider",
            estimatedTokens: 1_000,
            maximumTokens: 200_000,
          },
          {
            tabId: "tab-2",
            sessionId: null,
            placement: "docked",
            status: "idle",
            busy: false,
          },
        ],
      },
    });
    expect(checkpoint.transcript.messages).toEqual([
      expect.objectContaining({
        messageId: "message-user",
        role: "user",
        content: { kind: "inline", text: "Implement the relay" },
        blocks: [],
      }),
      expect.objectContaining({
        messageId: "message-assistant",
        role: "assistant",
        content: { kind: "inline", text: "" },
        blocks: [
          {
            type: "tool_call",
            blockId: "tool-1",
            toolCallId: "tool-1",
            name: "read_file",
            complete: true,
          },
          {
            type: "text",
            blockId: "text-2",
            text: { kind: "inline", text: "Visible response" },
          },
        ],
      }),
    ]);
    expect(checkpoint.foreground).toMatchObject({
      originalPrompt: "Review the relay implementation",
      interrupted: true,
      interactiveExecutionPhase: "queued_for_provider",
      statusOverride: "Refreshing credentials…",
      thinkingEnabled: false,
      reasoningEffort: "medium",
      lastInputTokens: 101,
      lastOutputTokens: 202,
      lastCacheReadTokens: 303,
      contextBudget: {
        contextWindow: 200_000,
        maxInputTokens: 180_000,
        usedInputTokens: 101,
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
      agentWriteApproval: "prompt",
      commandApprovalPolicy: "safe",
      approvalPolicy: "on-request",
      approvalReviewer: "user",
      executionPreset: "native-manual",
      configuredCommandApprovalPolicy: "safe",
      restoringSession: true,
      revertRecoveryNotice: {
        projectId: "project-1",
        checkpointId: "checkpoint-1",
        sessionRevision: "session-revision-1",
        workspaceRevision: "workspace-revision-1",
        startedAt: 750,
        title: "Recovery required",
        message: "Restore the reverted workspace state.",
      },
    });
    expect(checkpoint.ui).toMatchObject({
      interaction: {
        requestId: "approval-1",
        summary: "Approval required · Review relay",
      },
      queue: [{ itemId: "queued-1", summary: "Queued follow-up" }],
      todos: [
        { itemId: "todo-1", text: "Implementing adapter" },
        { itemId: "todo-child", text: "Add tests" },
      ],
    });
    expect(checkpoint.capabilities).toEqual(
      expect.arrayContaining([
        { capabilityId: "session.send", state: "enabled" },
        { capabilityId: "mcp.connected-server", state: "enabled" },
        { capabilityId: "mcp.disabled-server", state: "disabled" },
      ]),
    );
    expect(serialized).not.toContain("PRIVATE_THOUGHT");
    expect(serialized).not.toContain("PRIVATE_INPUT");
    expect(serialized).not.toContain("PRIVATE_TOOL_RESULT");
    expect(serialized).not.toContain("PRIVATE_IMAGE");
    expect(serialized).not.toContain("PRIVATE_THEME_VALUE");

    sources.readSet.foreground!.messages = [
      message("message-condense", "condense", "", 950),
    ];
    sources.readSet.foreground!.messages[0].condenseInfo = {
      prevInputTokens: 10_000,
      newInputTokens: 2_000,
    };
    expect(adapter.getCheckpoint().transcript.messages[0]).toMatchObject({
      role: "condense",
      content: { kind: "inline", text: "" },
      condenseInfo: { prevInputTokens: 10_000, newInputTokens: 2_000 },
    });
  });

  it("projects explicit surface changes for browser transcript dividers", () => {
    const sources = new ProjectionSources(readSet());
    const adapter = makeAdapter(sources);
    sources.readSet.foreground!.messages = [
      message("message-change", "assistant", "", 950),
    ];
    sources.readSet.foreground!.messages[0].surfaceChange = {
      model: { previousModel: "gpt-5.4", model: "gpt-5.6-sol" },
      reasoning: {
        previousReasoningEffort: "high",
        reasoningEffort: "low",
      },
    };

    expect(adapter.getCheckpoint().transcript.messages[0]).toMatchObject({
      role: "assistant",
      surfaceChange: {
        model: { previousModel: "gpt-5.4", model: "gpt-5.6-sol" },
        reasoning: {
          previousReasoningEffort: "high",
          reasoningEffort: "low",
        },
      },
    });
  });

  it("projects apiRequest mode and command approval policy for browser change dividers", () => {
    const sources = new ProjectionSources(readSet());
    const adapter = makeAdapter(sources);
    sources.readSet.foreground!.messages = [
      message("message-assistant", "assistant", "Done", 950),
    ];
    sources.readSet.foreground!.messages[0].apiRequest = {
      requestId: "request-1",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      mode: "architect",
      commandApprovalPolicy: "approve-for-me",
      inputTokens: 100,
      outputTokens: 20,
      durationMs: 500,
      timeToFirstToken: 100,
    };
    expect(adapter.getCheckpoint().transcript.messages[0]).toMatchObject({
      role: "assistant",
      apiRequest: {
        model: "gpt-5.6-sol",
        mode: "architect",
        commandApprovalPolicy: "approve-for-me",
      },
    });
  });

  it("keeps empty safe theme values and excludes unsafe theme functions before protocol parsing", () => {
    const state = readSet();
    state.theme.cssVariables = {
      "--vscode-empty": "",
      "--vscode-safe": "#123456",
      "--vscode-unsafe": "url(https://example.com/theme.png)",
      "--private-variable": "PRIVATE_THEME_VALUE",
    };
    const adapter = makeAdapter(new ProjectionSources(state));

    expect(adapter.getCheckpoint().theme.variables).toEqual([
      { name: "--vscode-empty", value: "" },
      { name: "--vscode-safe", value: "#123456" },
    ]);
  });

  it("bounds checkpoints to the latest 20 user turns and 200 messages", () => {
    const state = readSet();
    state.foreground!.messages = Array.from({ length: 230 }, (_, index) =>
      message(
        `message-${index}`,
        index % 2 === 0 ? "user" : "assistant",
        `message ${index}`,
        index,
        index % 2 === 0 ? [] : [{ type: "text", text: `message ${index}` }],
      ),
    );
    const adapter = makeAdapter(new ProjectionSources(state));
    const transcript = adapter.getCheckpoint().transcript;

    expect(transcript.messages.length).toBeLessThanOrEqual(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointMessages,
    );
    expect(
      transcript.messages.filter((item) => item.role === "user"),
    ).toHaveLength(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.selectedOwnerCheckpointUserTurns,
    );
    expect(transcript.hasEarlier).toBe(true);
    expect(transcript.earlierCursor).toBe(
      `before:${transcript.messages[0].messageId}`,
    );
    expect(transcript.messages.at(-1)?.messageId).toBe("message-229");
  });

  it("emits source-specific replacement events with monotonic sequences", () => {
    const state = readSet();
    const sources = new ProjectionSources(state);
    const adapter = makeAdapter(sources);
    const publications: BrowserGatewayOwnerProjectionPublication[] = [];
    adapter.onDidPublish((publication) => publications.push(publication));
    adapter.setDemanded(true);

    state.repository = {
      projectId: "project-1",
      branch: "feature/updated",
      dirty: false,
    };
    sources.fire("repository");
    state.modelCatalogRevision = "models-2";
    sources.fire("model_catalog");
    state.catalog.sessions = [
      {
        ...state.catalog.sessions[0],
        title: "Updated title",
        updatedAt: 1_100,
      },
    ];
    sources.fire("sessions");

    expect(sources.captureCount).toBe(4);
    expect(publications.slice(1)).toEqual([
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({
          ownerSequence: 1,
          kind: "repository.updated",
        }),
      }),
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({
          ownerSequence: 2,
          kind: "model_catalog.revision.updated",
        }),
      }),
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({
          ownerSequence: 3,
          kind: "session.catalog.updated",
        }),
      }),
    ]);
  });

  it("projects every non-transcript source kind into its allowlisted event", () => {
    const state = readSet();
    const sources = new ProjectionSources(state);
    const adapter = makeAdapter(sources);
    const kinds: string[] = [];
    adapter.onDidPublish((publication) => {
      if (publication.kind === "event") kinds.push(publication.event.kind);
    });
    adapter.setDemanded(true);

    state.interaction = {
      requestId: "question-1",
      kind: "question",
      step: 1,
      totalSteps: 2,
      payload: {
        approval: null,
        question: {
          id: "question-1",
          context: "Continue?",
          questions: [
            { id: "continue", type: "yes_no", question: "Continue?" },
          ],
        },
        questionProgress: {
          id: "question-1",
          step: 1,
          answers: {},
          notes: {},
          origin: "browser",
        },
        formElicitation: null,
        urlElicitation: null,
      },
    };
    sources.fire("ui");
    state.background = [
      ...state.background,
      { sessionId: "background-2", title: "Test", status: "idle" },
    ];
    sources.fire("background");
    state.fleet = [{ sessionId: "fleet-1", title: "Fleet", status: "queued" }];
    sources.fire("fleet");
    state.diffs = [
      ...state.diffs,
      {
        requestId: "diff-2",
        filePath: "src/second.ts",
        operation: "create",
        outsideWorkspace: false,
        createdAt: 1_050,
      },
    ];
    sources.fire("diffs");
    state.theme.cssVariables["--vscode-foreground"] = "#ffffff";
    sources.fire("theme");
    state.mcp = [{ name: "connected-server", status: "error" }];
    sources.fire("mcp");
    state.policies.agentWriteApproval = "session";
    sources.fire("policies");

    expect(kinds).toEqual([
      "interaction.updated",
      "background.updated",
      "fleet.updated",
      "diff.preview.updated",
      "theme.updated",
      "owner.capabilities.updated",
      "foreground.control.updated",
      "owner.capabilities.updated",
    ]);
  });

  it("publishes transcript appends incrementally before later events", () => {
    const state = readSet();
    const sources = new ProjectionSources(state);
    const adapter = makeAdapter(sources);
    const publications: BrowserGatewayOwnerProjectionPublication[] = [];
    adapter.onDidPublish((publication) => publications.push(publication));
    adapter.setDemanded(true);

    state.foreground!.status = "idle";
    state.foreground!.streaming = false;
    sources.fire("foreground");
    state.foreground!.messages = [
      ...state.foreground!.messages,
      message("message-final", "assistant", "", 1_100, [
        { type: "text", text: "Done" },
      ]),
    ];
    sources.fire("foreground");
    state.theme.cssVariables["--vscode-editor-background"] = "#222222";
    sources.fire("theme");

    expect(publications).toEqual([
      expect.objectContaining({
        kind: "checkpoint",
        checkpoint: expect.objectContaining({ checkpointSequence: 0 }),
      }),
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({
          ownerSequence: 1,
          kind: "foreground.control.updated",
        }),
      }),
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({
          ownerSequence: 2,
          kind: "transcript.message.appended",
          payload: {
            message: expect.objectContaining({ messageId: "message-final" }),
          },
        }),
      }),
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({
          ownerSequence: 3,
          kind: "theme.updated",
        }),
      }),
    ]);
  });

  it("keeps transcript append sequences contiguous", () => {
    const state = readSet();
    const sources = new ProjectionSources(state);
    const adapter = makeAdapter(sources);
    const publications: BrowserGatewayOwnerProjectionPublication[] = [];
    adapter.onDidPublish((publication) => publications.push(publication));
    adapter.setDemanded(true);

    state.foreground!.status = "idle";
    sources.fire("foreground");
    state.foreground!.messages = [
      ...state.foreground!.messages,
      message("message-3", "assistant", "", 1_100, [
        { type: "text", text: "First checkpoint change" },
      ]),
    ];
    sources.fire("foreground");
    state.foreground!.messages = [
      ...state.foreground!.messages,
      message("message-4", "assistant", "", 1_200, [
        { type: "text", text: "Second checkpoint change" },
      ]),
    ];
    sources.fire("foreground");
    state.theme.cssVariables["--vscode-editor-background"] = "#222222";
    sources.fire("theme");

    expect(publications).toEqual([
      expect.objectContaining({
        kind: "checkpoint",
        checkpoint: expect.objectContaining({ checkpointSequence: 0 }),
      }),
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({ ownerSequence: 1 }),
      }),
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({
          ownerSequence: 2,
          kind: "transcript.message.appended",
        }),
      }),
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({
          ownerSequence: 3,
          kind: "transcript.message.appended",
        }),
      }),
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({ ownerSequence: 4 }),
      }),
    ]);
  });

  it("keeps ordinary checkpoint reads pure while recovery checkpoints rebase", () => {
    const state = readSet();
    const sources = new ProjectionSources(state);
    const adapter = makeAdapter(sources);
    const publications: BrowserGatewayOwnerProjectionPublication[] = [];
    adapter.onDidPublish((publication) => publications.push(publication));
    adapter.setDemanded(true);

    state.foreground!.messages = [
      ...state.foreground!.messages,
      message("message-read", "assistant", "", 1_100, [
        { type: "text", text: "Captured by a pure read" },
      ]),
    ];
    expect(adapter.getCheckpoint().transcript.messages.at(-1)?.messageId).toBe(
      "message-read",
    );
    sources.fire("foreground");
    expect(publications.at(-1)).toMatchObject({
      kind: "event",
      event: {
        kind: "transcript.message.appended",
        payload: {
          message: expect.objectContaining({ messageId: "message-read" }),
        },
      },
    });

    state.foreground!.messages = [
      ...state.foreground!.messages,
      message("message-recovery", "assistant", "", 1_200, [
        { type: "text", text: "Captured by recovery" },
      ]),
    ];
    adapter.getRecoveryCheckpointPublication();
    const publicationCount = publications.length;
    sources.fire("foreground");
    expect(publications).toHaveLength(publicationCount);
  });

  it("emits a suffix-only inline text delta with the replacement revision", () => {
    const state = readSet();
    const sources = new ProjectionSources(state);
    const adapter = makeAdapter(sources);
    const publications: BrowserGatewayOwnerProjectionPublication[] = [];
    adapter.onDidPublish((publication) => publications.push(publication));
    adapter.setDemanded(true);

    const assistant = state.foreground!.messages[1];
    assistant.blocks = assistant.blocks.map((block) =>
      block.type === "text"
        ? { ...block, text: `${block.text} plus a suffix` }
        : block,
    );
    sources.fire("foreground");

    const event = publications[1];
    expect(event).toMatchObject({
      kind: "event",
      event: {
        ownerSequence: 1,
        kind: "transcript.block.delta",
        payload: {
          messageId: "message-assistant",
          blockId: "text-2",
          field: "text",
          delta: " plus a suffix",
        },
      },
    });
    if (event?.kind !== "event") throw new Error("expected transcript delta");
    expect(event.event.payload).toMatchObject({
      revision: adapter.getCheckpoint().transcript.messages[1].revision,
    });
  });

  it("upserts one structurally changed message and checkpoints ambiguous removals", () => {
    const state = readSet();
    const sources = new ProjectionSources(state);
    const adapter = makeAdapter(sources);
    const publications: BrowserGatewayOwnerProjectionPublication[] = [];
    adapter.onDidPublish((publication) => publications.push(publication));
    adapter.setDemanded(true);

    const assistant = state.foreground!.messages[1];
    assistant.blocks = assistant.blocks.map((block) =>
      block.type === "tool_call" ? { ...block, durationMs: 25 } : block,
    );
    sources.fire("foreground");
    expect(publications[1]).toMatchObject({
      kind: "event",
      event: {
        ownerSequence: 1,
        kind: "transcript.message.upserted",
        payload: {
          message: expect.objectContaining({ messageId: "message-assistant" }),
        },
      },
    });

    state.foreground!.messages = [assistant];
    sources.fire("foreground");
    expect(publications[2]).toMatchObject({
      kind: "checkpoint",
      checkpoint: { checkpointSequence: 1 },
    });
  });

  it("uses generation-bound detail attachments for oversized transcript text", () => {
    const state = readSet();
    state.interaction = null;
    const largeText = "é".repeat(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerInlineTranscriptTextBytes / 2 + 1,
    );
    state.foreground!.messages = [
      message("message-large", "user", largeText, 1_000),
    ];
    const adapter = makeAdapter(new ProjectionSources(state));

    const first = adapter.getCheckpointPublication();
    const second = adapter.getCheckpointPublication();
    const projected = first.checkpoint.transcript.messages[0];
    expect(projected.content).toMatchObject({
      kind: "detail",
      preview: largeText.slice(0, 8_000),
      detailHandle: {
        ...identity,
        kind: "message",
        byteLength: Buffer.byteLength(largeText),
        expiresAt:
          1_000 + BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerTranscriptDetailTtlMs,
      },
    });
    expect(first.details).toHaveLength(1);
    expect(Buffer.from(first.details![0].content).toString()).toBe(largeText);
    expect(second.details?.[0].handle).toEqual(first.details?.[0].handle);
    expect(JSON.stringify(first.checkpoint)).not.toContain(largeText);
  });

  it("refreshes cached detail handles before their expiry safety margin", () => {
    let now = 1_000;
    const state = readSet();
    state.interaction = null;
    const largeText = "x".repeat(
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerInlineTranscriptTextBytes + 1,
    );
    state.foreground!.messages = [
      message("message-large", "user", largeText, 1_000),
    ];
    const adapter = makeAdapter(new ProjectionSources(state), {
      now: () => now,
    });

    const first = adapter.getCheckpointPublication();
    now =
      first.details![0].handle.expiresAt -
      BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerTranscriptDetailTtlMs / 10;
    const refreshed = adapter.getCheckpointPublication();

    expect(refreshed.details?.[0].handle.handleId).not.toBe(
      first.details?.[0].handle.handleId,
    );
    expect(refreshed.details?.[0].handle.expiresAt).toBe(
      now + BROWSER_GATEWAY_DATA_PLANE_LIMITS.ownerTranscriptDetailTtlMs,
    );
  });

  it("does not consume demand or sequence when strict projection validation fails", () => {
    const state = readSet();
    state.foreground!.mode = "";
    const sources = new ProjectionSources(state);
    const adapter = makeAdapter(sources);
    const publications: BrowserGatewayOwnerProjectionPublication[] = [];
    adapter.onDidPublish((publication) => publications.push(publication));

    expect(() => adapter.setDemanded(true)).toThrow(
      BrowserGatewayProtocolError,
    );
    expect(adapter.isDemanded()).toBe(false);
    expect(publications).toEqual([]);

    state.foreground!.mode = "code";
    adapter.setDemanded(true);
    state.foreground!.mode = "";
    expect(() => sources.fire("foreground")).toThrow(
      BrowserGatewayProtocolError,
    );
    state.foreground!.mode = "debug";
    sources.fire("foreground");

    expect(publications).toEqual([
      expect.objectContaining({
        kind: "checkpoint",
        checkpoint: expect.objectContaining({ checkpointSequence: 0 }),
      }),
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({
          ownerSequence: 1,
          kind: "foreground.control.updated",
        }),
      }),
    ]);
  });

  it("suppresses semantically unchanged source notifications and unsubscribes on dispose", () => {
    const sources = new ProjectionSources(readSet());
    const adapter = makeAdapter(sources);
    const publications: BrowserGatewayOwnerProjectionPublication[] = [];
    adapter.onDidPublish((publication) => publications.push(publication));
    adapter.setDemanded(true);

    sources.fire("repository");
    sources.fire("background");
    expect(publications).toHaveLength(1);

    adapter.dispose();
    sources.fire("theme");
    expect(publications).toHaveLength(1);
  });
});
