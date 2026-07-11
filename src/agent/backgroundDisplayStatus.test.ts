import { describe, expect, it } from "vitest";
import {
  inferBackgroundDisplayStatus,
  normalizeBackgroundStatusPhrase,
  pickBackgroundDisplayStatus,
} from "./backgroundDisplayStatus.js";

describe("normalizeBackgroundStatusPhrase", () => {
  it.each([
    ["Streaming file analysis", "Reviewing code"],
    ["streaming-file-list", "Scanning files"],
    ["tool_calls", "Running tools"],
    ["completed", "Done"],
    ["canceled", "Cancelled"],
    ["failed", "Error"],
    ["awaiting_approval", "Awaiting approval"],
    ["streaming repository search", "Reviewing code"],
    ["custom phase label", "Custom Phase Label"],
    ["   ", ""],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeBackgroundStatusPhrase(input)).toBe(expected);
  });
});

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

  it("prefers a non-empty status detail", () => {
    expect(
      inferBackgroundDisplayStatus({
        status: "streaming",
        currentTool: "read_file",
        statusDetail: "Reading src/agent/AgentEngine.ts",
      }),
    ).toBe("Reading src/agent/AgentEngine.ts");
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

describe("pickBackgroundDisplayStatus", () => {
  const now = 100_000;

  it.each([
    ["idle", "Done"],
    ["error", "Error"],
    ["cancelled", "Cancelled"],
  ] as const)(
    "gives terminal status %s precedence",
    (status, displayStatus) => {
      expect(
        pickBackgroundDisplayStatus({
          status,
          heuristicStatus: "Reading code",
          summary: {
            inFlight: false,
            shortStatus: "Streaming file analysis",
            generatedAt: now,
          },
          now,
        }),
      ).toEqual({ displayStatus, displayStatusSource: "terminal" });
    },
  );

  it("uses a fresh normalized model summary", () => {
    expect(
      pickBackgroundDisplayStatus({
        status: "streaming",
        heuristicStatus: "Reading code",
        summary: {
          inFlight: false,
          shortStatus: "Streaming file analysis",
          generatedAt: now - 60_000,
        },
        now,
      }),
    ).toEqual({
      displayStatus: "Reviewing code",
      displayStatusSource: "model",
    });
  });

  it("rejects stale and false-terminal model summaries", () => {
    for (const summary of [
      { inFlight: false, shortStatus: "Reviewing", generatedAt: now - 60_001 },
      { inFlight: false, shortStatus: "Done", generatedAt: now },
      { inFlight: false, shortStatus: "Error", generatedAt: now },
    ]) {
      expect(
        pickBackgroundDisplayStatus({
          status: "streaming",
          heuristicStatus: "Running tests",
          summary,
          now,
        }),
      ).toEqual({
        displayStatus: "Running tests",
        displayStatusSource: "heuristic",
      });
    }
  });

  it("prefers specific heuristic activity over generic model thinking", () => {
    expect(
      pickBackgroundDisplayStatus({
        status: "streaming",
        heuristicStatus: "Running command",
        summary: {
          inFlight: false,
          shortStatus: "Streaming active",
          generatedAt: now,
        },
        now,
      }),
    ).toEqual({
      displayStatus: "Running command",
      displayStatusSource: "heuristic",
    });
  });
});
