import {
  GET_BACKGROUND_RESULT_TOOL,
  appendOwnershipHandoff,
  buildBackgroundDenialPayload,
  buildBackgroundFailurePayload,
  buildBackgroundResultsPayload,
  buildBackgroundStatusDenial,
  buildBackgroundStillRunningPayload,
  buildBackgroundWaitInterruptedPayload,
  getBackgroundResultToolDefinition,
  getEngineHardLimit,
  inferReviewTier,
  isResearchTaskClass,
  isReviewTaskClass,
  parseAgentBudgetInput,
  parseModelTierInput,
  resolveBackgroundBudget,
} from "./backgroundAgentTools.js";
import { describe, expect, it } from "vitest";

describe("background task classes and budgets", () => {
  it("classifies VS Code's task classes", () => {
    expect(isReviewTaskClass(" Review_Plan ")).toBe(true);
    expect(isReviewTaskClass("readonly-research")).toBe(false);
    expect(isResearchTaskClass("readonly-research")).toBe(true);
    expect(inferReviewTier({ taskClass: "review_code" })).toBe("balanced");
    expect(inferReviewTier({ taskClass: "general" })).toBeUndefined();
  });

  it("allows 1.5x a review's budget and 3x otherwise", () => {
    expect(getEngineHardLimit(4, "review_code")).toBe(6);
    expect(getEngineHardLimit(3, "review_code")).toBe(5);
    expect(getEngineHardLimit(2, "general")).toBe(6);
    expect(getEngineHardLimit(undefined, "general")).toBeUndefined();
  });

  it("keeps only work-unit and time limits for reviews", () => {
    const requested = parseAgentBudgetInput({
      maxTokens: 100,
      maxApiTurns: "4",
      maxElapsedMs: 0,
      scope: "nonsense",
    });
    expect(requested).toMatchObject({
      maxTokens: 100,
      maxApiTurns: 4,
      maxElapsedMs: undefined,
      scope: "session",
    });
    expect(resolveBackgroundBudget("review_code", requested)).toEqual({
      maxApiTurns: 4,
      scope: "session",
    });
    expect(resolveBackgroundBudget("general", requested)).toEqual({
      maxTokens: 100,
      maxApiTurns: 4,
      scope: "session",
    });
    // A scope alone is not a budget.
    expect(
      resolveBackgroundBudget("general", parseAgentBudgetInput({})),
    ).toBeUndefined();
    expect(parseAgentBudgetInput(undefined)).toBeUndefined();
  });

  it("reads modelTier like VS Code", () => {
    expect(parseModelTierInput("foreground")).toBe("foreground");
    expect(parseModelTierInput("huge")).toBeUndefined();
    expect(parseModelTierInput(null)).toBeUndefined();
  });
});

describe("background agent tool contract", () => {
  it("tells a workspace child that no owned paths means no writes", () => {
    const handoff = appendOwnershipHandoff("task", {
      ownedPaths: [],
      forbiddenPaths: ["secret"],
      backend: "workspace",
      executionRoot: "/project",
    });
    expect(handoff).toContain('"ownedPaths":[],"forbiddenPaths":["secret"]');
    expect(handoff).toContain("means you cannot write files at all");
    expect(handoff).not.toContain("adds no ownership restriction");
    expect(
      appendOwnershipHandoff("task", {
        backend: "workspace",
        executionRoot: "/project",
      }),
    ).toBe("task");
  });

  it("drops the user-message promise only for hosts whose waits cannot see one", () => {
    expect(
      getBackgroundResultToolDefinition({ interruptsOnUserMessage: true }),
    ).toBe(GET_BACKGROUND_RESULT_TOOL);
    const quiet = getBackgroundResultToolDefinition({
      interruptsOnUserMessage: false,
    });
    expect(quiet.input_schema).toEqual(GET_BACKGROUND_RESULT_TOOL.input_schema);
    expect(quiet.description).not.toContain("wait_interrupted");
    expect(GET_BACKGROUND_RESULT_TOOL.description).toContain(
      "wait_interrupted",
    );
  });

  it("builds VS Code's single-agent wait payloads", () => {
    expect(
      buildBackgroundStillRunningPayload("child", {
        phase: "executing_tool",
        displayStatus: "Running read_file",
        currentTool: "read_file",
        elapsedMs: 10,
        idleMs: 2,
      }),
    ).toMatchObject({
      status: "still_running",
      done: false,
      sessionId: "child",
      phase: "executing_tool",
      retryAfterMs: 5_000,
      retrySafe: true,
    });
    expect(buildBackgroundWaitInterruptedPayload("child")).toMatchObject({
      status: "wait_interrupted",
      reason: "user_message_pending",
      done: false,
      sessionId: "child",
    });
  });

  it("separates a lookup miss from an authorization loss", () => {
    expect(
      buildBackgroundDenialPayload({
        notFound: true,
        sessionId: "child",
        terminalReason: "background_session_not_found",
        error: "missing",
      }),
    ).toEqual({
      status: "not_found",
      sessionId: "child",
      terminalReason: "background_session_not_found",
      retrySafe: true,
      agentRetryable: false,
      error: "missing",
    });
    expect(
      buildBackgroundStatusDenial({
        notFound: false,
        terminalReason: "owned_elsewhere",
        error: "nope",
      }),
    ).toMatchObject({
      status: "error",
      done: true,
      displayStatus: "Unauthorized",
      resultState: "authorization_lost",
      retrySafe: false,
    });
  });

  it("keeps failure fields in VS Code's order and omits absent ones", () => {
    expect(
      JSON.stringify(
        buildBackgroundFailurePayload({
          status: "failed",
          terminalReason: "stopped",
          retrySafe: true,
          agentRetryable: true,
        }),
      ),
    ).toBe(
      '{"status":"failed","terminalReason":"stopped","retrySafe":true,"agentRetryable":true}',
    );
    expect(
      Object.keys(
        buildBackgroundFailurePayload({
          status: "interrupted",
          terminalReason: "blocked",
          retrySafe: true,
          agentRetryable: false,
          partialOutput: "stopped",
        }),
      ),
    ).toEqual([
      "status",
      "terminalReason",
      "retrySafe",
      "agentRetryable",
      "recovery",
      "partialOutput",
    ]);
  });

  it("carries live progress into a still-running wait result", () => {
    const payload = buildBackgroundStillRunningPayload("child", {
      phase: "awaiting_approval",
      displayStatus: "Awaiting approval",
      currentTool: "read_file",
      currentToolInput: "path=/usr/share/man/man2/setrlimit.2",
      pendingApprovals: [{ kind: "path", stage: "awaiting_user" }],
      streamingPreview: "Fixed two findings; checking the third.",
    });
    expect(payload).toMatchObject({
      status: "still_running",
      currentToolInput: "path=/usr/share/man/man2/setrlimit.2",
      pendingApprovals: [{ kind: "path", stage: "awaiting_user" }],
      streamingPreview: "Fixed two findings; checking the third.",
    });
  });

  it("lets a coordinator take over a technical blocker but not a refusal", () => {
    const technical = buildBackgroundFailurePayload({
      status: "interrupted",
      terminalReason: "technical_blocker",
      retrySafe: true,
      agentRetryable: false,
    });
    expect(technical.recovery).toContain("no permission denial");
    expect(technical.recovery).toContain("continue the work yourself");
    expect(technical.recovery).not.toContain(
      "No agent-side recovery is available",
    );
  });

  it("explains recovery when the runtime will not retry a failure", () => {
    const blocked = buildBackgroundFailurePayload({
      status: "interrupted",
      terminalReason: "blocked",
      retrySafe: true,
      agentRetryable: false,
    });
    expect(blocked.recovery).toContain("No agent-side recovery is available");
    expect(blocked.recovery).toContain("not permission to retry");
    expect(blocked.recovery).toContain('terminalReason "blocked"');

    const refusal = buildBackgroundFailurePayload({
      status: "failed",
      terminalReason: "provider_stop:refusal",
      retrySafe: true,
      agentRetryable: false,
    });
    expect(refusal.recovery).toContain("No agent-side recovery is available");

    const failed = buildBackgroundFailurePayload({
      status: "failed",
      terminalReason: "provider_error",
      retrySafe: true,
      agentRetryable: false,
    });
    expect(failed.recovery).toContain("deliberate decision");
    expect(failed.recovery).not.toContain("No agent-side recovery");

    const cancelled = buildBackgroundFailurePayload({
      status: "cancelled",
      terminalReason: "cancelled_by_user",
      retrySafe: true,
      agentRetryable: false,
    });
    expect(cancelled.recovery).toContain("cancelled");
  });

  it("reports several-agent waits with their completed and pending agents", () => {
    expect(
      buildBackgroundResultsPayload({
        status: "still_running",
        returnWhen: "all",
        completed: [
          {
            sessionId: "a",
            result: "done",
            resultState: "completed",
            retrySafe: true,
            agentRetryable: false,
          },
        ],
        pending: [{ sessionId: "b", status: "streaming" }],
      }),
    ).toMatchObject({
      status: "still_running",
      returnWhen: "all",
      done: false,
      completed: [{ sessionId: "a", result: "done" }],
      pending: [{ sessionId: "b", status: "streaming" }],
      retryAfterMs: 5_000,
    });
  });
});
