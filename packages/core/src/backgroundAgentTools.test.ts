import {
  GET_BACKGROUND_RESULT_TOOL,
  buildBackgroundDenialPayload,
  buildBackgroundFailurePayload,
  buildBackgroundResultsPayload,
  buildBackgroundStatusDenial,
  buildBackgroundStillRunningPayload,
  buildBackgroundWaitInterruptedPayload,
  getBackgroundResultToolDefinition,
} from "./backgroundAgentTools.js";
import { describe, expect, it } from "vitest";

describe("background agent tool contract", () => {
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
          status: "cancelled",
          terminalReason: "stopped",
          retrySafe: true,
          agentRetryable: false,
        }),
      ),
    ).toBe(
      '{"status":"cancelled","terminalReason":"stopped","retrySafe":true,"agentRetryable":false}',
    );
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
