import {
  DEFAULT_COMPLETED_CONTINUE_ACTION,
  getLatestAutoContinueAction,
  getLatestFinalMessageMarker,
} from "./finalStatus";
import { describe, expect, it } from "vitest";

describe("getLatestAutoContinueAction", () => {
  it("continues completed markers even when the visible Continue action is suppressed", () => {
    expect(
      getLatestAutoContinueAction([
        {
          id: "assistant-1",
          role: "assistant",
          finalMarker: {
            status: "completed",
            source: "tool",
            continueActionSuppressed: true,
          },
        },
      ]),
    ).toEqual({
      messageId: "assistant-1",
      ...DEFAULT_COMPLETED_CONTINUE_ACTION,
    });
  });

  it("stops scanning at user messages so older markers are stale", () => {
    expect(
      getLatestAutoContinueAction([
        {
          id: "assistant-1",
          role: "assistant",
          finalMarker: {
            status: "completed",
            source: "tool",
          },
        },
        { id: "user-1", role: "user" },
      ]),
    ).toBeUndefined();
  });

  it("does not auto-continue non-completed final markers", () => {
    expect(
      getLatestAutoContinueAction([
        {
          id: "assistant-1",
          role: "assistant",
          finalMarker: {
            status: "waiting_for_user",
            source: "tool",
          },
        },
      ]),
    ).toBeUndefined();
  });
});

describe("getLatestFinalMessageMarker", () => {
  it("returns non-completed final markers so callers can explain heuristic stops", () => {
    expect(
      getLatestFinalMessageMarker([
        {
          id: "assistant-1",
          role: "assistant",
          finalMarker: {
            status: "waiting_for_user",
            source: "tool",
          },
        },
      ]),
    ).toEqual({
      messageId: "assistant-1",
      marker: {
        status: "waiting_for_user",
        source: "tool",
      },
    });
  });
});
