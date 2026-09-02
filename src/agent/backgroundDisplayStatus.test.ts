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
