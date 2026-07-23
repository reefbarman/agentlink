import { describe, expect, it, vi } from "vitest";

import { handleDiagnoseActivity } from "./diagnoseActivity.js";

function payload(result: ReturnType<typeof handleDiagnoseActivity>) {
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  return JSON.parse(text) as Record<string, unknown>;
}

describe("handleDiagnoseActivity", () => {
  it("forwards bounded filters to the session diagnostics provider", () => {
    const diagnose = vi.fn(() => ({
      sessionId: "session-1",
      eventCount: 3,
      recordedEventCount: 3,
      traceTruncated: false,
      filters: {},
      evidence: [],
    }));

    const result = handleDiagnoseActivity(
      {
        tool_name: "write_file",
        path: "src/example.ts",
        tool_call_id: "call-1",
        limit: 5,
      },
      { diagnose },
    );

    expect(diagnose).toHaveBeenCalledWith({
      toolName: "write_file",
      path: "src/example.ts",
      toolCallId: "call-1",
      limit: 5,
    });
    expect(payload(result)).toMatchObject({ sessionId: "session-1" });
  });

  it("returns a structured error when diagnostics are unavailable", () => {
    expect(payload(handleDiagnoseActivity({}))).toMatchObject({
      error: "Session activity diagnostics are unavailable",
    });
  });
});
