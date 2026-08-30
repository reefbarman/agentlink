import {
  DEFAULT_COMPLETED_CONTINUE_ACTION,
  getLatestAutoContinueAction,
  getLatestFinalMessageMarker,
  type FinalMessageMarker,
} from "./finalStatus.js";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("final status protocol compatibility shim", () => {
  it("preserves the legacy marker and continuation contracts", () => {
    expectTypeOf<FinalMessageMarker>().toHaveProperty("status");
    expect(DEFAULT_COMPLETED_CONTINUE_ACTION.label).toBe("Continue");
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        finalMarker: { status: "completed", source: "tool" } as const,
      },
    ];
    expect(getLatestFinalMessageMarker(messages)?.messageId).toBe(
      "assistant-1",
    );
    expect(getLatestAutoContinueAction(messages)).toMatchObject({
      messageId: "assistant-1",
      label: "Continue",
    });
  });
});
