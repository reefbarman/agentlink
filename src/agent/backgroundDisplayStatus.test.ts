import { describe, expect, it } from "vitest";

import { inferBackgroundDisplayStatus } from "./backgroundDisplayStatus.js";

describe("inferBackgroundDisplayStatus", () => {
  it.each([
    ["queued", "Queued"],
    ["awaiting_approval", "Awaiting approval"],
    ["idle", "Done"],
    ["cancelled", "Cancelled"],
    ["error", "Error"],
  ] as const)("maps terminal-like status %s", (status, expected) => {
    expect(inferBackgroundDisplayStatus({ status })).toBe(expected);
  });

  it("prefers and bounds a non-empty status detail", () => {
    expect(
      inferBackgroundDisplayStatus({
        status: "streaming",
        currentTool: "read_file",
        statusDetail: "Reading src/agent/AgentEngine.ts",
      }),
    ).toBe("Reading src/agent/AgentEngine.ts");

    const bounded = inferBackgroundDisplayStatus({
      status: "streaming",
      statusDetail: `ACP tool ${"x".repeat(200)}`,
    });
    expect(bounded).toHaveLength(80);
    expect(bounded.endsWith("…")).toBe(true);
  });

  it.each([
    ["read_file", "reading source", "Reading code"],
    ["codebase_search", "I found the issue", "Issue found"],
    ["get_symbols", "investigating symbols", "Inspecting code"],
    ["write_file", "updating implementation", "Editing code"],
    ["apply_diff", "applied patch successfully", "Patch applied"],
    ["execute_command", "npm test", "Running tests"],
    ["execute_command", "all tests pass", "Verifying fix"],
    ["execute_command", "run migration", "Running command"],
    ["ask_user", "need a choice", "Waiting input"],
  ])("infers %s activity as %s", (currentTool, streamingText, expected) => {
    expect(
      inferBackgroundDisplayStatus({
        status: "streaming",
        currentTool,
        streamingText,
      }),
    ).toBe(expected);
  });

  describe.each([
    ["streaming", "read_file", "Reading code"],
    ["tool_executing", undefined, "Running…"],
    ["streaming", undefined, "Thinking…"],
  ] as const)(
    "finding inference for %s / %s",
    (status, currentTool, neutral) => {
      it.each([
        "I found no material issue in the acknowledgement or projection paths.",
        "I found src/agent/AgentSession.ts and its tests.",
        "I have not found the issue.",
        "I haven't found the issue.",
        "I haven’t found the issue.",
        "I haven't identified a bug.",
        "I haven’t identified a bug.",
        "I couldn't confirm the root cause.",
        "I couldn’t confirm the root cause.",
        "I could not identify the root cause.",
        "The root cause is not established.",
        "No root cause was found. Validation was blocked by read-only command policy.",
        "I found no issues. Validation was unavailable.",
        "I found no issue, but validation was blocked.",
      ])("keeps a neutral label for %j", (streamingText) => {
        expect(
          inferBackgroundDisplayStatus({ status, currentTool, streamingText }),
        ).toBe(neutral);
      });

      it.each([
        "I found the issue.",
        "I found a bug in the projection.",
        "I found the root cause.",
        "The root cause is a dropped callback.",
        "The problem is a dropped callback.",
        "I found no issue in the handler. I found a bug in the projection.",
        "I found no issue in the handler, but I found the root cause elsewhere.",
      ])("retains affirmative findings for %j", (streamingText) => {
        expect(
          inferBackgroundDisplayStatus({ status, currentTool, streamingText }),
        ).toBe("Issue found");
      });
    },
  );

  it.each([
    ["rerun the test", "Running tests"],
    ["updating the patch", "Updating code"],
    ["I found the root cause", "Issue found"],
    ["tool produced output", "Running…"],
  ])("infers unnamed tool execution from text", (streamingText, expected) => {
    expect(
      inferBackgroundDisplayStatus({
        status: "tool_executing",
        streamingText,
      }),
    ).toBe(expected);
  });

  it.each([
    ["blocked on user confirmation", "Awaiting input"],
    ["Next I’ll inspect the handler", "Inspecting code"],
    ["I found the issue", "Issue found"],
    ["considering the approach", "Thinking…"],
  ])("infers streaming text fallback %j", (streamingText, expected) => {
    expect(
      inferBackgroundDisplayStatus({ status: "streaming", streamingText }),
    ).toBe(expected);
  });
});
