import { describe, expect, it, vi } from "vitest";
import { AUTO_CONTINUE_NO_PROGRESS_REASON } from "@agentlink/protocol/auto-continue-progress";
import {
  DEFAULT_COMPLETED_CONTINUE_ACTION,
  formatAutoContinueModelPrompt,
} from "@agentlink/protocol/final-status";
import {
  AUTO_CONTINUE_MAX_TURNS,
  SessionAutoContinueController,
  type SessionAutoContinueSendRequest,
  type SessionAutoContinueUpdate,
} from "./SessionAutoContinueController.js";

function makeController(
  queued = false,
  idleMarker: Record<string, { status: string } | null> = {},
) {
  const logs: string[] = [];
  const sent: SessionAutoContinueSendRequest[] = [];
  const updates: SessionAutoContinueUpdate[] = [];
  const hasQueued = vi.fn(() => queued);
  const controller = new SessionAutoContinueController({
    sendPrompt: (request) => sent.push(request),
    publish: (update) => updates.push(update),
    hasQueuedUserMessages: hasQueued,
    getIdleFinalMarker: (sessionId) => (idleMarker[sessionId] as never) ?? null,
    log: (message) => logs.push(message),
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
  return { controller, sent, updates, hasQueued, finishTurn, logs };
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
      displayText: DEFAULT_COMPLETED_CONTINUE_ACTION.prompt,
      modelText: formatAutoContinueModelPrompt(
        DEFAULT_COMPLETED_CONTINUE_ACTION.prompt,
        "default",
      ),
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

  it("labels the agent's own next step as its proposal, not the user's", () => {
    const { controller, sent } = makeController();
    controller.setEnabled("session-a", true);

    controller.observe({
      type: "agentFinalMarker",
      sessionId: "session-a",
      marker: {
        status: "completed",
        source: "tool",
        continueAction: { label: "Run tests", prompt: "Run `npm test`." },
      },
    });
    controller.observe({ type: "agentDone", sessionId: "session-a" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      displayText: "Run `npm test`.",
      modelText: formatAutoContinueModelPrompt(
        "Run `npm test`.",
        "agent_proposed",
      ),
    });
    expect(sent[0]!.modelText).toContain("<auto-continue-notice>");
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

  it("continues straight away when enabled on a turn that already completed", () => {
    const { controller, sent, updates } = makeController(false, {
      "session-done": { status: "completed" },
      "session-waiting": { status: "waiting_for_user" },
    });

    controller.setEnabled("session-done", true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      sessionId: "session-done",
      displayText: DEFAULT_COMPLETED_CONTINUE_ACTION.prompt,
    });
    expect(updates.at(-1)).toMatchObject({
      sessionId: "session-done",
      status: `Auto Continue sent 1/${AUTO_CONTINUE_MAX_TURNS}.`,
      transcriptAction: { kind: "continued" },
    });

    // Nothing to continue: stay on for the next turn instead of stopping.
    controller.setEnabled("session-waiting", true);
    controller.setEnabled("session-idle", true);
    expect(sent).toHaveLength(1);
    expect(controller.getState("session-waiting").enabled).toBe(true);
    expect(controller.getState("session-idle").enabled).toBe(true);
  });

  it("pauses visibly when the continue prompt cannot be sent", () => {
    const { controller, updates, finishTurn, logs } = makeController();
    controller.setEnabled("session-a", true);
    finishTurn("session-a");

    controller.reportSendFailure(
      "session-a",
      "the previous turn did not finish settling.",
    );

    expect(controller.getState("session-a")).toEqual({
      enabled: false,
      status:
        "Auto Continue paused: the previous turn did not finish settling.",
    });
    expect(updates.at(-1)).toMatchObject({
      transcriptAction: { kind: "stopped" },
    });
    expect(logs.some((line) => line.includes("sending continue 1/"))).toBe(
      true,
    );
  });

  it("logs why a finished turn was not continued", () => {
    const { controller, logs } = makeController();
    controller.setEnabled("session-a", true);

    controller.observe({ type: "agentDone", sessionId: "session-a" });

    expect(logs.at(-1)).toBe(
      "[auto-continue] session=session-a turn ended without a final status; not continuing",
    );
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
