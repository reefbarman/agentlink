import { describe, expect, it } from "vitest";

import type { ContentBlock } from "@agentlink/protocol/chat-transcript";
import { getStreamingActivity } from "./activityPresentation";

function activityFor(blocks: ContentBlock[]) {
  return getStreamingActivity(blocks);
}

describe("getStreamingActivity", () => {
  it("uses a truthful coarse fallback before projected output exists", () => {
    expect(activityFor([])).toEqual({
      phase: "working",
      motion: "moving",
      label: "Working…",
    });
  });

  it("distinguishes reasoning and responding", () => {
    expect(
      activityFor([
        { type: "thinking", id: "thinking-1", text: "", complete: false },
      ]),
    ).toMatchObject({ phase: "reasoning", label: "Thinking…" });

    expect(activityFor([{ type: "text", text: "Draft" }])).toMatchObject({
      phase: "responding",
      label: "Responding…",
    });
  });

  it("distinguishes active tools from the post-tool provider gap", () => {
    const tool = {
      type: "tool_call" as const,
      id: "tool-1",
      name: "read_file",
      inputJson: "{}",
      result: "",
      complete: false,
    };

    expect(activityFor([tool])).toMatchObject({
      phase: "tool",
      label: "Running tool…",
    });
    expect(activityFor([{ ...tool, complete: true }])).toMatchObject({
      phase: "processing_results",
      label: "Processing tool results…",
    });
  });

  it("uses literal skill-loading labels", () => {
    const skill = {
      type: "skill_load" as const,
      id: "skill-1",
      inputJson: "{}",
      result: "",
      complete: false,
    };

    expect(activityFor([skill])).toMatchObject({
      phase: "tool",
      label: "Loading skill…",
    });
    expect(activityFor([{ ...skill, complete: true }])).toMatchObject({
      phase: "processing_results",
      label: "Processing skill results…",
    });
  });

  it("falls back to Working after reasoning completes without new output", () => {
    expect(
      activityFor([
        {
          type: "thinking",
          id: "thinking-1",
          text: "Finished",
          complete: true,
        },
      ]),
    ).toMatchObject({ phase: "working", label: "Working…" });
  });
});
