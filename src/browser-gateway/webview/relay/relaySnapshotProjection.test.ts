import { describe, expect, it } from "vitest";

import type { BrowserGatewayOwnerInteractionPayload } from "../../dataPlane/interactionPayload";
import {
  BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
  type BrowserGatewayOwnerCheckpoint,
  type BrowserGatewayTranscriptMessage,
} from "../../dataPlane/protocol";
import {
  parseRelayInteractionPayload,
  RelaySnapshotProjector,
} from "./relaySnapshotProjection";

const identity = {
  helperGenerationId: "helper-1",
  ownerId: "owner-1",
  ownerGenerationId: "generation-1",
};

function message(
  messageId: string,
  revision: number,
): BrowserGatewayTranscriptMessage {
  return {
    messageId,
    role: "assistant",
    revision,
    createdAt: revision,
    content: { kind: "inline", text: `message-${revision}` },
    blocks: [
      {
        type: "text",
        blockId: `${messageId}-text`,
        text: { kind: "inline", text: `text-${revision}` },
      },
      {
        type: "tool_call",
        blockId: `${messageId}-tool-block`,
        toolCallId: `${messageId}-tool`,
        name: "read_file",
        complete: true,
      },
      {
        type: "pairing_status",
        blockId: `${messageId}-pairing`,
        status: "pending",
        expiresAt: 10,
      },
    ],
  };
}

function checkpoint(
  overrides: Partial<BrowserGatewayOwnerCheckpoint> = {},
): BrowserGatewayOwnerCheckpoint {
  return {
    protocolVersion: BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION,
    ...identity,
    checkpointId: "checkpoint-1",
    checkpointSequence: 1,
    emittedAt: 1,
    foreground: {
      sessionId: "session-1",
      title: "Session",
      originalPrompt: "Original relay prompt",
      mode: "code",
      model: "model-1",
      status: "streaming",
      interactiveExecutionPhase: "queued_for_provider",
      streaming: true,
      interrupted: true,
      estimatedTokens: 12,
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
        memory: { status: "ready", retrieval: "hybrid", activeRecordCount: 4 },
        retrieval: {
          status: "degraded",
          lexical: "ready",
          vector: "unavailable",
          structural: "ready",
          sourceCount: 8,
          chunkCount: 32,
          staleSourceCount: 1,
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
        startedAt: 1,
        title: "Recovery required",
        message: "Restore the reverted workspace state.",
      },
    },
    catalog: {
      projects: [
        {
          projectId: "project-1",
          displayName: "Project",
          availability: "available",
        },
      ],
      sessions: [
        {
          sessionId: "session-1",
          projectId: "project-1",
          title: "Session",
          mode: "code",
          model: "model-1",
          messageCount: 1,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      defaultProjectId: "project-1",
      foregroundSessionId: "session-1",
    },
    transcript: {
      messages: [message("message-1", 1)],
      earlierCursor: null,
      hasEarlier: false,
    },
    ui: {
      interaction: {
        requestId: "approval-1",
        kind: "approval",
        state: "pending",
        summary: "Approval required",
      },
      queue: [
        { itemId: "queued", summary: "Queued", state: "queued" },
        { itemId: "done", summary: "Done", state: "completed" },
      ],
      todos: [{ itemId: "todo-1", text: "Do it", state: "in_progress" }],
      operations: [],
    },
    background: [
      {
        sessionId: "background-1",
        title: "Background",
        status: "streaming",
        updatedAt: 2,
      },
    ],
    fleet: [
      {
        sessionId: "background-1",
        title: "Newer",
        status: "completed",
        updatedAt: 3,
      },
    ],
    diffs: [
      {
        requestId: "diff-1",
        filePath: "src/file.ts",
        operation: "update",
        outsideWorkspace: false,
        createdAt: 3,
      },
    ],
    repository: { revision: "repo-1", branch: "main", dirty: true },
    theme: {
      revision: "theme-1",
      colorScheme: "dark",
      variables: [{ name: "--vscode-foreground", value: "#fff" }],
    },
    modelCatalogRevision: "models-1",
    capabilities: [],
    ...overrides,
  };
}

describe("RelaySnapshotProjector", () => {
  it("maps relay owner state with conservative unavailable-field defaults", () => {
    const snapshot = new RelaySnapshotProjector().project(checkpoint());

    expect(snapshot.session.foreground).toMatchObject({
      sessionId: "session-1",
      project: { projectId: "project-1" },
      originalPrompt: "Original relay prompt",
      interrupted: true,
      interactiveExecutionPhase: "queued_for_provider",
      statusOverride: "Restoring session",
      thinkingEnabled: false,
      reasoningEffort: "medium",
      lastInputTokens: 11,
      lastOutputTokens: 22,
      lastCacheReadTokens: 33,
      estimatedTotalUsed: 12,
      contextBudget: { hardBudget: 175_904 },
      contextHealth: {
        memory: { status: "ready", activeRecordCount: 4 },
        retrieval: { status: "degraded", staleSourceCount: 1 },
        index: { status: "working", current: 3, total: 10 },
      },
      condenseThreshold: 0.8,
      restoringSession: true,
      revertRecoveryNotice: {
        checkpointId: "checkpoint-1",
      },
      messageQueue: [{ id: "queued", text: "Queued" }],
      todos: [{ id: "todo-1", content: "Do it", activeForm: "Do it" }],
      questionRequest: null,
      agentWriteApproval: "session",
      commandApprovalPolicy: "approve-for-me",
      configuredCommandApprovalPolicy: "sensitive",
    });
    expect(snapshot.ui).toMatchObject({
      approval: null,
      question: null,
      formElicitation: null,
      urlElicitation: null,
      mcpStatusInfos: [],
    });
    expect(snapshot.session.repository).toEqual({
      projectId: "project-1",
      branch: "main",
      dirty: true,
    });
    expect(snapshot.background).toEqual([
      expect.objectContaining({
        id: "background-1",
        task: "Newer",
        status: "idle",
      }),
    ]);
    expect(snapshot.diffs[0]).toMatchObject({
      requestId: "diff-1",
      originalPreview: "",
      proposedPreview: "",
    });
    expect(snapshot.theme).toEqual({
      cssVariables: { "--vscode-foreground": "#fff" },
      colorScheme: "dark",
    });
  });

  it("uses legacy-compatible defaults when protocol-v1 foreground optionals are omitted", () => {
    const value = checkpoint();
    const foreground = {
      sessionId: value.foreground!.sessionId,
      title: value.foreground!.title,
      mode: value.foreground!.mode,
      model: value.foreground!.model,
      status: value.foreground!.status,
      streaming: value.foreground!.streaming,
    };

    const projected = new RelaySnapshotProjector().project(
      checkpoint({ foreground }),
    ).session.foreground!;

    expect(projected).toMatchObject({
      statusOverride: null,
      thinkingEnabled: true,
      reasoningEffort: "high",
      lastInputTokens: 0,
      lastOutputTokens: 0,
      lastCacheReadTokens: 0,
      estimatedTotalUsed: 0,
      contextHealth: null,
      restoringSession: false,
      revertRecoveryNotice: null,
      agentWriteApproval: "prompt",
      commandApprovalPolicy: "safe",
      approvalPolicy: "on-request",
      approvalReviewer: "user",
      executionPreset: "native-manual",
      configuredCommandApprovalPolicy: "safe",
    });
    expect(projected).not.toHaveProperty("contextBudget");
    expect(projected).not.toHaveProperty("condenseThreshold");
  });

  it("replaces foreground correctness fields without retaining stale values", () => {
    const projector = new RelaySnapshotProjector();
    projector.project(checkpoint());
    const value = checkpoint({ checkpointSequence: 2 });

    const projected = projector.project(
      checkpoint({
        checkpointSequence: 2,
        foreground: {
          sessionId: value.foreground!.sessionId,
          title: value.foreground!.title,
          mode: value.foreground!.mode,
          model: value.foreground!.model,
          status: value.foreground!.status,
          streaming: value.foreground!.streaming,
          statusOverride: null,
          revertRecoveryNotice: null,
        },
      }),
    ).session.foreground!;

    expect(projected.statusOverride).toBeNull();
    expect(projected.revertRecoveryNotice).toBeNull();
    expect(projected.contextHealth).toBeNull();
    expect(projected).not.toHaveProperty("contextBudget");
    expect(projected).not.toHaveProperty("condenseThreshold");
  });

  it("hydrates concurrent generation-bound interaction state", () => {
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
    const value = checkpoint();
    const parsed = parseRelayInteractionPayload(payload, value.ui.interaction!);
    const snapshot = new RelaySnapshotProjector().project(value, parsed);

    expect(snapshot.ui.approval).toEqual(payload.approval);
    expect(snapshot.ui.question).toEqual(payload.question);
    expect(snapshot.ui.questionProgress).toEqual(payload.questionProgress);
    expect(snapshot.ui.formElicitation).toEqual(payload.formElicitation);
    expect(snapshot.ui.urlElicitation).toEqual(payload.urlElicitation);
    expect(snapshot.session.foreground?.questionRequest).toEqual(
      payload.question,
    );
    expect(parsed).not.toBe(payload);
    expect(parsed.question).not.toBe(payload.question);
  });

  it("strips unknown fields and rejects malformed secondary interaction DTOs", () => {
    const value = checkpoint();
    const expected = value.ui.interaction!;
    const payload = {
      approval: {
        id: expected.requestId,
        kind: "command",
        command: "npm test",
        privateFutureField: "must-not-cross-wire",
      },
      question: {
        id: "question-1",
        context: "Continue?",
        questions: [
          {
            id: "continue",
            type: "yes_no",
            question: "Continue?",
            privateFutureField: "must-not-cross-wire",
          },
        ],
      },
      questionProgress: null,
      formElicitation: null,
      urlElicitation: null,
      privateFutureField: "must-not-cross-wire",
    };

    expect(parseRelayInteractionPayload(payload, expected)).toEqual({
      approval: {
        id: expected.requestId,
        kind: "command",
        command: "npm test",
      },
      question: {
        id: "question-1",
        context: "Continue?",
        questions: [{ id: "continue", type: "yes_no", question: "Continue?" }],
      },
      questionProgress: null,
      formElicitation: null,
      urlElicitation: null,
    });
    expect(() =>
      parseRelayInteractionPayload(
        {
          ...payload,
          questionProgress: {
            id: "question-1",
            step: 1,
            answers: {},
            notes: {},
            origin: "browser",
          },
        },
        expected,
      ),
    ).toThrow("invalid_relay_interaction_detail");
    expect(() =>
      parseRelayInteractionPayload(
        {
          ...payload,
          urlElicitation: {
            id: "url-1",
            serverName: "example-mcp",
            message: "Open the authorization page.",
            url: "https://example.com/authorize",
            elicitationId: "elicitation-1",
            origin: "https://example.com",
            host: "example.com",
            isLocalAddress: "false",
          },
        },
        expected,
      ),
    ).toThrow("invalid_relay_interaction_detail");
  });

  it("rejects stale primary and question-progress detail identities", () => {
    const value = checkpoint();
    const expected = value.ui.interaction!;
    const payload: BrowserGatewayOwnerInteractionPayload = {
      approval: {
        id: "stale-approval",
        kind: "command",
        command: "npm test",
      },
      question: null,
      questionProgress: null,
      formElicitation: null,
      urlElicitation: null,
    };
    expect(() => parseRelayInteractionPayload(payload, expected)).toThrow(
      "invalid_relay_interaction_detail",
    );

    expect(() =>
      parseRelayInteractionPayload(
        {
          ...payload,
          approval: { ...payload.approval!, id: expected.requestId },
          question: { id: "question-1", context: "", questions: [] },
          questionProgress: {
            id: "different-question",
            step: 1,
            answers: {},
            notes: {},
            origin: "browser",
          },
        },
        expected,
      ),
    ).toThrow("invalid_relay_interaction_detail");
  });

  it("renders projectless owner foregrounds with a stable unavailable project", () => {
    const snapshot = new RelaySnapshotProjector().project(
      checkpoint({
        catalog: {
          projects: [],
          sessions: [
            {
              sessionId: "session-1",
              projectId: null,
              title: "Session",
              mode: "ask",
              model: "model-1",
              messageCount: 1,
              createdAt: 1,
              updatedAt: 2,
            },
          ],
          defaultProjectId: null,
          foregroundSessionId: "session-1",
        },
      }),
    );

    expect(snapshot.session.foreground?.project).toEqual({
      projectId: "owner:owner-1",
      displayName: "Projectless session",
      availability: "unavailable",
    });
  });

  it("preserves typed background result fields", () => {
    const terminalMessage = message("background-result-message", 2);
    terminalMessage.blocks = [
      {
        type: "bg_agent_result",
        blockId: "background-result",
        sessionId: "background-1",
        task: "Review",
        status: "error",
        resultState: "incomplete_expected_result",
        terminalReason: "incomplete_expected_result",
        partialOutput: { kind: "inline", text: "Recovered partial findings" },
        retrySafe: true,
        agentRetryable: false,
      },
    ];
    const projected = new RelaySnapshotProjector().project(
      checkpoint({
        transcript: {
          messages: [terminalMessage],
          earlierCursor: null,
          hasEarlier: false,
        },
      }),
    ).session.foreground!.projectedMessages[0]!;

    expect(projected.blocks[0]).toMatchObject({
      type: "bg_agent_result",
      status: "error",
      resultState: "incomplete_expected_result",
      terminalReason: "incomplete_expected_result",
      partialOutput: "Recovered partial findings",
      retrySafe: true,
      agentRetryable: false,
    });
  });

  it("maps safe message blocks and omits redacted pairing status", () => {
    const projected = new RelaySnapshotProjector().project(checkpoint()).session
      .foreground!.projectedMessages[0]!;

    expect(projected.blocks).toEqual([
      { type: "text", text: "text-1" },
      {
        type: "tool_call",
        id: "message-1-tool",
        name: "read_file",
        inputJson: "",
        result: "",
        complete: true,
      },
    ]);
  });

  it("preserves unchanged message identity and replaces changed revisions", () => {
    const projector = new RelaySnapshotProjector();
    const first = projector.project(checkpoint());
    const original = first.session.foreground!.projectedMessages[0]!;
    const same = projector.project(checkpoint({ checkpointSequence: 2 }));
    expect(same.session.foreground!.projectedMessages[0]).toBe(original);

    const changed = projector.project(
      checkpoint({
        checkpointSequence: 3,
        transcript: {
          messages: [message("message-1", 2)],
          earlierCursor: null,
          hasEarlier: false,
        },
      }),
    );
    expect(changed.session.foreground!.projectedMessages[0]).not.toBe(original);
  });

  it("resets caches per owner generation and versions model revisions", () => {
    const projector = new RelaySnapshotProjector();
    const first = projector.project(checkpoint());
    const sameRevision = projector.project(
      checkpoint({ checkpointSequence: 2 }),
    );
    const nextRevision = projector.project(
      checkpoint({ checkpointSequence: 3, modelCatalogRevision: "models-2" }),
    );
    const nextGeneration = projector.project(
      checkpoint({
        ownerGenerationId: "generation-2",
        checkpointSequence: 1,
        modelCatalogRevision: "models-2",
      }),
    );

    expect(first.modelsVersion).toBe(1);
    expect(sameRevision.modelsVersion).toBe(1);
    expect(nextRevision.modelsVersion).toBe(2);
    expect(nextGeneration.modelsVersion).toBe(1);
    expect(nextGeneration.session.foreground!.projectedMessages[0]).not.toBe(
      nextRevision.session.foreground!.projectedMessages[0],
    );
  });
});
