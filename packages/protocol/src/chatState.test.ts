import type { ChatContextBudget, ChatStateSnapshot } from "./chatState.js";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("chat state protocol", () => {
  it("keeps the complete foreground state serializable", () => {
    const state: ChatStateSnapshot = {
      sessionId: "session-1",
      projects: [
        {
          projectId: "project-1",
          displayName: "AgentLink",
          availability: "available",
        },
      ],
      defaultProjectId: "project-1",
      project: {
        projectId: "project-1",
        displayName: "AgentLink",
        availability: "available",
      },
      mode: "code",
      model: "gpt-5.6-sol",
      streaming: true,
      interrupted: false,
      thinkingEnabled: true,
      reasoningEffort: "high",
      condenseThreshold: 0.8,
      contextBudget: {
        contextWindow: 200_000,
        maxInputTokens: 180_000,
        usedInputTokens: 50_000,
        outputReservation: 20_000,
        safetyBufferTokens: 10_000,
        softThresholdBudget: 144_000,
        hardBudget: 170_000,
      },
      contextHealth: {
        memory: { status: "ready", retrieval: "hybrid" },
        retrieval: {
          status: "ready",
          lexical: "ready",
          vector: "ready",
          structural: "ready",
        },
        index: { status: "ready", state: "idle" },
      },
      agentWriteApproval: "session",
      commandApprovalPolicy: "approve-for-me",
      approvalPolicy: "on-request",
      approvalReviewer: "auto-review",
      executionPreset: "workspace-write",
      configuredCommandApprovalPolicy: "sensitive",
      revertRecoveryNotice: {
        projectId: "project-1",
        checkpointId: "checkpoint-1",
        sessionRevision: "revision-1",
        startedAt: 1,
        title: "Recovery needed",
        message: "Retry saving the reverted session.",
      },
    };

    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it("pins snapshot and context-budget fields", () => {
    expectTypeOf<keyof ChatContextBudget>().toEqualTypeOf<
      | "contextWindow"
      | "maxInputTokens"
      | "usedInputTokens"
      | "outputReservation"
      | "safetyBufferTokens"
      | "softThresholdBudget"
      | "hardBudget"
    >();
    expectTypeOf<keyof ChatStateSnapshot>().toEqualTypeOf<
      | "sessionId"
      | "projects"
      | "defaultProjectId"
      | "project"
      | "mode"
      | "model"
      | "streaming"
      | "interrupted"
      | "thinkingEnabled"
      | "reasoningEffort"
      | "condenseThreshold"
      | "contextBudget"
      | "contextHealth"
      | "agentWriteApproval"
      | "commandApprovalPolicy"
      | "approvalPolicy"
      | "approvalReviewer"
      | "executionPreset"
      | "configuredCommandApprovalPolicy"
      | "revertRecoveryNotice"
    >();
  });
});
