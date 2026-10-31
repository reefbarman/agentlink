import { describe, expect, it, vi } from "vitest";
import { AUTO_CONTINUE_NO_PROGRESS_REASON } from "@agentlink/protocol/auto-continue-progress";
import { DEFAULT_COMPLETED_CONTINUE_ACTION } from "@agentlink/protocol/final-status";
import {
  AUTO_CONTINUE_MAX_TURNS,
  SessionAutoContinueController,
  type SessionAutoContinueUpdate,
} from "./SessionAutoContinueController.js";

function makeController(queued = false) {
  const sent: Array<{
    sessionId: string;
    prompt: string;
    isStillWanted: () => boolean;
  }> = [];
  const updates: SessionAutoContinueUpdate[] = [];
  const hasQueued = vi.fn(() => queued);
  const controller = new SessionAutoContinueController({
    sendPrompt: (sessionId, prompt, isStillWanted) =>
      sent.push({ sessionId, prompt, isStillWanted }),
    publish: (update) => updates.push(update),
    hasQueuedUserMessages: hasQueued,
  });
  const finishTurn = (
    sessionId: string,
    status: "completed" | "waiting_for_user" | "blocked" = "completed",
    progressed = false,
  ) => {
    if (progressed) {
      controller.observe({
        type: "agentToolComplete",
        sessionId,
        toolName: "write_file",
      });
    }
    controller.observe({
      type: "agentFinalMarker",
      sessionId,
      marker: { status } as never,
    });
    controller.observe({ type: "agentDone", sessionId });
  };
  return { controller, sent, updates, hasQueued, finishTurn };
}

describe("SessionAutoContinueController", () => {
  it("keeps one shared state per session", () => {
    const { controller, updates } = makeController();

    controller.setEnabled("session-a", true);

    expect(controller.getState("session-a")).toEqual({
      enabled: true,
      status: `Auto Continue enabled (max ${AUTO_CONTINUE_MAX_TURNS} turns).`,
    });
    expect(controller.getState("session-b")).toEqual({
      enabled: false,
      status: "",
    });
    expect(updates.at(-1)).toMatchObject({
      sessionId: "session-a",
      enabled: true,
    });
  });

  it("sends the continue prompt once when a completed turn ends", () => {
    const { controller, sent, updates, finishTurn } = makeController();
    controller.setEnabled("session-a", true);

    finishTurn("session-a");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      sessionId: "session-a",
      prompt: DEFAULT_COMPLETED_CONTINUE_ACTION.prompt,
    });
    expect(sent[0]!.isStillWanted()).toBe(true);
    expect(updates.at(-1)).toMatchObject({
      enabled: true,
      status: `Auto Continue sent 1/${AUTO_CONTINUE_MAX_TURNS}.`,
      transcriptAction: { kind: "continued" },
    });

    // A later user message supersedes the scheduled prompt.
    controller.observe({
      type: "agentCommittedUserMessage",
      sessionId: "session-a",
    });
    expect(sent[0]!.isStillWanted()).toBe(false);
  });

  it("stops when the agent waits for the user", () => {
    const { controller, sent, updates, finishTurn } = makeController();
    controller.setEnabled("session-a", true);

    finishTurn("session-a", "waiting_for_user");

    expect(sent).toEqual([]);
    expect(controller.getState("session-a").enabled).toBe(false);
    expect(updates.at(-1)).toMatchObject({
      transcriptAction: {
        kind: "stopped",
        reason: "Auto Continue stopped because the agent is waiting for input.",
      },
    });
  });

  it("stops after a continued turn makes no progress", () => {
    const { controller, sent, finishTurn } = makeController();
    controller.setEnabled("session-a", true);

    finishTurn("session-a");
    finishTurn("session-a");

    expect(sent).toHaveLength(1);
    expect(controller.getState("session-a")).toEqual({
      enabled: false,
      status: AUTO_CONTINUE_NO_PROGRESS_REASON,
    });
  });

  it("keeps continuing while turns make progress, up to the limit", () => {
    const { controller, sent, finishTurn } = makeController();
    controller.setEnabled("session-a", true);

    for (let turn = 0; turn <= AUTO_CONTINUE_MAX_TURNS; turn += 1) {
      finishTurn("session-a", "completed", true);
    }

    expect(sent).toHaveLength(AUTO_CONTINUE_MAX_TURNS);
    expect(controller.getState("session-a").enabled).toBe(false);
  });

  it("lets queued messages run first and skips a turn the user stopped", () => {
    const { controller, sent, hasQueued, finishTurn } = makeController();
    controller.setEnabled("session-a", true);

    hasQueued.mockReturnValueOnce(true);
    finishTurn("session-a");
    expect(sent).toEqual([]);
    expect(controller.getState("session-a").enabled).toBe(true);

    controller.noteManualStop("session-a");
    finishTurn("session-a");
    expect(sent).toEqual([]);
    expect(controller.getState("session-a").enabled).toBe(true);
  });

  it("pauses after an agent error and ignores sessions that are off", () => {
    const { controller, sent, finishTurn } = makeController();
    finishTurn("session-off");
    expect(sent).toEqual([]);

    controller.setEnabled("session-a", true);
    controller.observe({ type: "agentError", sessionId: "session-a" });

    expect(controller.getState("session-a")).toEqual({
      enabled: false,
      status: "Auto Continue paused after an agent error.",
    });
  });
});
