import { describe, expect, expectTypeOf, it } from "vitest";

import {
  getBackgroundResultPresentation,
  type BackgroundAgentBudgetUsage,
  type BackgroundAgentRuntimePhase,
  type BackgroundResultState,
  type BgSessionInfo,
} from "./backgroundResult.js";

describe("background result protocol", () => {
  it("keeps lifecycle state and runtime phase unions stable", () => {
    expectTypeOf<BackgroundResultState>().toEqualTypeOf<
      | "running"
      | "completed"
      | "incomplete_expected_result"
      | "failed"
      | "cancelled"
      | "budget_exhausted"
      | "interrupted"
      | "authorization_lost"
    >();
    expectTypeOf<BackgroundAgentRuntimePhase>().toEqualTypeOf<
      | "queued"
      | "waiting_for_provider"
      | "thinking"
      | "responding"
      | "executing_tool"
      | "awaiting_approval"
      | "awaiting_coordinator"
      | "retrying_provider"
      | "completed"
      | "failed"
      | "cancelled"
    >();
    expectTypeOf<BackgroundAgentBudgetUsage>().toEqualTypeOf<{
      tokens: number;
      toolCalls: number;
      apiTurns: number;
      elapsedMs: number;
    }>();
  });

  it("keeps the complete serialized background session summary package-owned", () => {
    expectTypeOf<BgSessionInfo["status"]>().toEqualTypeOf<
      | "queued"
      | "streaming"
      | "tool_executing"
      | "awaiting_approval"
      | "idle"
      | "error"
      | "cancelled"
    >();
    expectTypeOf<BgSessionInfo["reasoningEffort"]>().toEqualTypeOf<
      import("./modelCatalog.js").CoreReasoningEffort | undefined
    >();
    expectTypeOf<BgSessionInfo["phase"]>().toEqualTypeOf<
      BackgroundAgentRuntimePhase | undefined
    >();
    expectTypeOf<BgSessionInfo["resultState"]>().toEqualTypeOf<
      BackgroundResultState | undefined
    >();
    expectTypeOf<BgSessionInfo["structuredResult"]>().toEqualTypeOf<
      import("./fleetResult.js").FleetResultEnvelope | undefined
    >();
    expectTypeOf<BgSessionInfo["placement"]>().toEqualTypeOf<
      "background" | "worktree" | "remote" | undefined
    >();
    expectTypeOf<BgSessionInfo["budget"]>().toEqualTypeOf<
      | {
          maxTokens?: number;
          maxToolCalls?: number;
          maxApiTurns?: number;
          maxElapsedMs?: number;
          maxEstimatedCostUsd?: number;
          estimatedCostPerMillionTokens?: number;
          warningThresholdRatio?: number;
          scope?: "session" | "subtree" | "goal";
        }
      | undefined
    >();
  });

  it("accepts the full serializable fleet projection shape", () => {
    const snapshot = {
      id: "session-1",
      task: "Review protocol boundaries",
      status: "tool_executing",
      currentTool: "read_file",
      displayStatus: "Reading files",
      displayStatusSource: "terminal",
      resolvedMode: "review",
      resolvedModel: "gpt-5.6-sol",
      resolvedProvider: "codex",
      reasoningEffort: "high",
      taskClass: "review_code",
      routingReason: "configured review model",
      fallbackUsed: false,
      parentSessionId: "parent-1",
      rootSessionId: "root-1",
      goalId: "goal-1",
      workflowId: "workflow-1",
      workspace: "agentlink",
      worktreePath: "/workspace/agentlink",
      worktreeBranch: "main",
      depth: 1,
      placement: "background",
      delegation: {
        ownedPaths: ["packages/protocol"],
        forbiddenPaths: ["src/extension.ts"],
        permissionProfile: "review-only",
        worktree: "shared",
        expectedResult: "review_findings",
      },
      backend: "native",
      capabilities: {
        canRead: true,
        canWrite: false,
        canExecute: false,
        canUseMcp: false,
        canDelegate: false,
        limitationReason: "review-only",
      },
      lifecycle: "running",
      terminalReason: "completed",
      resultState: "running",
      partialResult: "Reviewing",
      agentRetryable: true,
      createdAt: 1,
      lastActiveAt: 2,
      startedAt: 3,
      lastProgressAt: 4,
      phaseStartedAt: 5,
      requestStartedAt: 6,
      requestElapsedMs: 7,
      retryAt: 8,
      elapsedMs: 9,
      idleMs: 10,
      phase: "executing_tool",
      canSteer: true,
      canKill: true,
      totalInputTokens: 11,
      totalOutputTokens: 12,
      toolCalls: 13,
      apiTurns: 14,
      budget: {
        maxTokens: 15,
        maxToolCalls: 16,
        maxApiTurns: 17,
        maxElapsedMs: 18,
        maxEstimatedCostUsd: 19,
        estimatedCostPerMillionTokens: 20,
        warningThresholdRatio: 0.8,
        scope: "subtree",
      },
      attention: "approval",
      attentionEvent: {
        id: "attention-1",
        kind: "approval",
        timestamp: 21,
      },
      archivedAt: 22,
      unreadEventCount: 1,
      events: [
        {
          id: "event-1",
          sequence: 1,
          type: "tool_started",
          timestamp: 23,
          summary: "Reading files",
          readAt: 24,
        },
      ],
      policyAuditCount: 2,
      structuredResult: {
        type: "review_findings",
        findings: [],
        reviewedScope: "packages/protocol",
        emptyDiff: false,
      },
      streamingText: "Reviewing",
      errorMessage: "none",
      completedAt: 25,
    } satisfies BgSessionInfo;

    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it.each([
    ["completed", "completed", "success", "Background Result"],
    ["incomplete_expected_result", "error", "warning", "Incomplete Result"],
    ["budget_exhausted", "error", "warning", "Background Stopped"],
    ["interrupted", "error", "warning", "Background Interrupted"],
    ["authorization_lost", "error", "error", "Background Failed"],
    ["cancelled", "cancelled", "cancelled", "Background Cancelled"],
    ["running", "error", "error", "Background Failed"],
    ["failed", "error", "error", "Background Failed"],
  ] as const)(
    "projects %s with the stable visual family",
    (state, legacy, family, title) => {
      expect(getBackgroundResultPresentation(state, legacy)).toMatchObject({
        family,
        title,
      });
    },
  );

  it("preserves legacy fallback and humanizes stable terminal reasons", () => {
    expect(
      getBackgroundResultPresentation(undefined, "completed"),
    ).toMatchObject({
      family: "success",
      statusText: "completed",
    });
    expect(
      getBackgroundResultPresentation(
        "budget_exhausted",
        "error",
        "budget_exhausted:tool_calls",
      ),
    ).toMatchObject({
      reason: "The background agent reached its tool calls budget.",
    });
    expect(
      getBackgroundResultPresentation(
        "authorization_lost",
        "error",
        "outside_caller_subtree",
      ),
    ).toMatchObject({
      reason:
        "This session is no longer authorized to access that background result.",
    });
  });
});
