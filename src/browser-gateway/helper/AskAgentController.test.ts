/** @vitest-environment node */

import type { ChatMessage } from "@agentlink/protocol/chat-transcript";
import type { BrowserGatewayThemeSnapshot } from "@agentlink/protocol/browser-gateway-theme";
import { BROWSER_GATEWAY_ASK_AGENT_SESSION_ID } from "../browserGatewayAskAgentSessionStore.js";
import { BrowserGatewayCoreOwnerRegistry } from "../coreOwnerRegistry.js";
import {
  AskAgentController,
  type AskAgentControllerPublication,
} from "./AskAgentController.js";
import { describe, expect, it, vi } from "vitest";

const theme: BrowserGatewayThemeSnapshot = {
  cssVariables: {},
  colorScheme: "dark",
  themeLabel: "Dark",
  source: "vscode-theme-api",
};

const missingCredential = {
  state: "missing" as const,
  reason: "No model credential available.",
};

function createController(
  publications: AskAgentControllerPublication[],
  onSnapshotBuilt?: (
    snapshot: AskAgentControllerPublication["snapshot"],
    durationMs: number,
  ) => void,
  overrides: Partial<ConstructorParameters<typeof AskAgentController>[0]> = {},
): AskAgentController {
  return new AskAgentController({
    ownerRegistry: new BrowserGatewayCoreOwnerRegistry({
      heartbeatTtlMs: 30_000,
    }),
    coalesceMs: 20,
    serialize: JSON.stringify,
    byteLength: (serialized) => Buffer.byteLength(serialized, "utf8"),
    publish: (publication) => {
      publications.push(publication);
    },
    onSnapshotBuilt,
    ...overrides,
  });
}

describe("AskAgentController", () => {
  it("restores persisted preferences and history without ephemeral turn state", () => {
    const publications: AskAgentControllerPublication[] = [];
    const controller = createController(publications);
    const restoredMessage: ChatMessage = {
      id: "restored-user",
      role: "user",
      content: "Restored conversation",
      timestamp: 150,
      blocks: [{ type: "text", text: "Restored conversation" }],
    };

    controller.restoreState(
      { model: "gpt-5.5", reasoningEffort: "high" },
      {
        activeSessionId: BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
        sessions: [
          {
            id: BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
            title: "Restored session",
            createdAt: 100,
            lastActiveAt: 200,
            messages: [restoredMessage],
            nextMessageSequence: 2,
          },
        ],
      },
    );

    const state = controller.projectState({
      now: 300,
      theme,
      modelCredentialStatus: missingCredential,
    });

    expect(state.snapshot.session.foreground).toMatchObject({
      sessionId: BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
      title: "Restored session",
      model: "gpt-5.5",
      reasoningEffort: "high",
      streaming: false,
      status: "idle",
      questionRequest: null,
      restoringSession: false,
    });
    expect(state.snapshot.session.foreground.projectedMessages).toEqual([
      restoredMessage,
    ]);
    expect(state.snapshot.ui).toMatchObject({
      approval: null,
      question: null,
      questionProgress: null,
    });
    expect(publications).toEqual([]);
    void controller.dispose();
  });

  it("owns completed-turn scheduling and bounded memory nudges", async () => {
    const publications: AskAgentControllerPublication[] = [];
    const onCompletedTurn = vi.fn();
    const onMemoryNudgeDetected = vi.fn();
    const controller = createController(publications, undefined, {
      memoryNudgeLimit: 1,
      createMemoryNudgeId: () => "memory-nudge-1",
      onCompletedTurn,
      onMemoryNudgeDetected,
    });

    controller.recordTurnOutcome("session-1", "model_error");
    controller.recordTurnOutcome("session-1", "model_success");
    expect(onCompletedTurn).toHaveBeenCalledOnce();
    expect(onCompletedTurn).toHaveBeenCalledWith("session-1");

    const candidate = {
      kind: "preference" as const,
      matchedPhrase: "Always use checklists",
    };
    expect(
      controller.considerMemoryCandidate({
        sessionId: "session-1",
        now: 100,
        candidate,
        approvalPending: false,
      }),
    ).toMatchObject({ id: "memory-nudge-1", ...candidate });
    expect(onMemoryNudgeDetected).toHaveBeenCalledOnce();
    controller.dismissMemoryCandidateNudge("memory-nudge-1");
    expect(controller.getMemoryCandidateNudge()).toBeNull();
    expect(
      controller.considerMemoryCandidate({
        sessionId: "session-1",
        now: 200,
        candidate,
        approvalPending: false,
      }),
    ).toBeNull();

    controller.clearMemoryCandidateNudgeForSession("session-1");
    expect(
      controller.considerMemoryCandidate({
        sessionId: "session-1",
        now: 300,
        candidate,
        approvalPending: false,
      }),
    ).toMatchObject({ id: "memory-nudge-1", ...candidate });
    await controller.dispose();
  });

  it("owns runtime approval pause, resume, and abort cleanup", async () => {
    const publications: AskAgentControllerPublication[] = [];
    const controller = createController(publications);
    const abort = new AbortController();
    const request = {
      kind: "write" as const,
      id: "approval-1",
      filePath: "Generate image?",
      writeOperation: "modify" as const,
    };
    const decision = controller.requestApproval(request, abort.signal);

    expect(controller.getPendingApproval()).toEqual(request);
    expect(
      controller.submitApproval({
        type: "decision",
        id: "other",
        decision: "accept",
      }),
    ).toBeNull();
    expect(
      controller.submitApproval({
        type: "decision",
        id: request.id,
        decision: "accept",
      }),
    ).toEqual(request);
    await expect(decision).resolves.toMatchObject({
      id: request.id,
      decision: "accept",
    });
    expect(controller.getPendingApproval()).toBeNull();

    const cancelled = controller.requestApproval(
      { ...request, id: "approval-2" },
      abort.signal,
    );
    abort.abort();
    await expect(cancelled).rejects.toThrow("ask_agent_approval_cancelled");
    expect(controller.getPendingApproval()).toBeNull();

    await expect(
      controller.requestApproval(
        { ...request, id: "approval-3" },
        abort.signal,
      ),
    ).rejects.toThrow("ask_agent_approval_cancelled");
    expect(controller.getPendingApproval()).toBeNull();

    const pendingOnDispose = controller.requestApproval(
      { ...request, id: "approval-4" },
      new AbortController().signal,
    );
    await controller.dispose();
    await expect(pendingOnDispose).rejects.toThrow(
      "ask_agent_approval_cancelled",
    );
  });

  it("owns exclusive turn reservation and identity-safe completion", async () => {
    const publications: AskAgentControllerPublication[] = [];
    const activeTurnChanges: boolean[] = [];
    const controller = createController(publications, undefined, {
      onActiveTurnChanged: (active) => activeTurnChanges.push(active),
    });
    const first = controller.beginTurn("assistant-1");

    expect(first).not.toBeNull();
    expect(controller.hasActiveTurn()).toBe(true);
    expect(controller.beginTurn("assistant-2")).toBeNull();
    controller.completeTurn({
      messageId: "stale",
      signal: new AbortController().signal,
    });
    expect(controller.hasActiveTurn()).toBe(true);

    controller.completeTurn(first!);
    expect(controller.hasActiveTurn()).toBe(false);
    const second = controller.beginTurn("assistant-2");
    expect(second?.messageId).toBe("assistant-2");
    controller.completeTurn(second!);
    await controller.dispose();
    expect(activeTurnChanges).toEqual([true, false, true, false]);
  });

  it("deduplicates cancellation and waits for active turn settlement on disposal", async () => {
    const publications: AskAgentControllerPublication[] = [];
    const controller = createController(publications);
    const turn = controller.beginTurn("assistant-1")!;
    let resolveFinalize!: (publication: AskAgentControllerPublication) => void;
    const finalize = vi.fn(
      () =>
        new Promise<AskAgentControllerPublication>((resolve) => {
          resolveFinalize = resolve;
        }),
    );

    const firstCancellation = controller.cancelActiveTurn(finalize);
    const secondCancellation = controller.cancelActiveTurn(finalize);
    expect(firstCancellation).toBe(secondCancellation);
    expect(turn.signal.aborted).toBe(true);
    expect(controller.isTurnStopped(turn)).toBe(true);
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith("assistant-1");

    const snapshot = controller.projectState({
      now: 100,
      theme,
      modelCredentialStatus: missingCredential,
    }).snapshot;
    const publication = await controller.publishSnapshot(snapshot);
    resolveFinalize(publication);
    await expect(firstCancellation).resolves.toBe(publication);

    let disposed = false;
    const disposing = controller.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    controller.completeTurn(turn);
    await disposing;
    expect(disposed).toBe(true);
  });

  it("rejects an independently signaled approval before waiting for its active turn", async () => {
    const publications: AskAgentControllerPublication[] = [];
    const controller = createController(publications);
    const turn = controller.beginTurn("assistant-1")!;
    const approval = controller.requestApproval(
      {
        kind: "write",
        id: "approval-1",
        filePath: "Generate image?",
        writeOperation: "modify",
      },
      new AbortController().signal,
    );
    let approvalRejected = false;
    void approval.catch(() => {
      approvalRejected = true;
      controller.completeTurn(turn);
    });

    const disposing = controller.dispose();
    await expect(approval).rejects.toThrow("ask_agent_approval_cancelled");
    await disposing;
    expect(approvalRejected).toBe(true);
  });

  it("scopes cancellation deduplication to the active turn", async () => {
    const publications: AskAgentControllerPublication[] = [];
    const controller = createController(publications);
    const first = controller.beginTurn("assistant-1")!;
    let resolveFirst!: (publication: AskAgentControllerPublication) => void;
    const firstFinalize = vi.fn(
      () =>
        new Promise<AskAgentControllerPublication>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const firstCancellation = controller.cancelActiveTurn(firstFinalize);
    controller.completeTurn(first);

    const second = controller.beginTurn("assistant-2")!;
    const secondSnapshot = controller.projectState({
      now: 200,
      theme,
      modelCredentialStatus: missingCredential,
    }).snapshot;
    const secondPublication = await controller.publishSnapshot(secondSnapshot);
    const secondFinalize = vi.fn(async () => secondPublication);
    const secondCancellation = controller.cancelActiveTurn(secondFinalize);

    expect(secondCancellation).not.toBe(firstCancellation);
    expect(second.signal.aborted).toBe(true);
    expect(secondFinalize).toHaveBeenCalledWith("assistant-2");
    await expect(secondCancellation).resolves.toBe(secondPublication);

    const firstSnapshot = controller.projectState({
      now: 100,
      theme,
      modelCredentialStatus: missingCredential,
    }).snapshot;
    resolveFirst(await controller.publishSnapshot(firstSnapshot));
    await firstCancellation;
    controller.completeTurn(second);
    await controller.dispose();
  });

  it("coalesces scheduled projections and flushes pending work on disposal", async () => {
    vi.useFakeTimers();
    try {
      const publications: AskAgentControllerPublication[] = [];
      const onSnapshotBuilt = vi.fn();
      const controller = createController(publications, onSnapshotBuilt);
      const first = controller.scheduleProjectedSnapshot(
        () =>
          controller.projectState({
            now: 100,
            theme,
            modelCredentialStatus: missingCredential,
          }).snapshot,
      );
      const second = controller.scheduleProjectedSnapshot(
        () =>
          controller.projectState({
            now: 200,
            theme,
            modelCredentialStatus: missingCredential,
            memoryCandidateNudge: {
              id: "memory-nudge",
              sessionId: BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
              createdAt: 200,
              kind: "preference",
              matchedPhrase: "remember this",
              suggestedScope: "global",
              suggestedTier: "memory",
              title: "Remember preference",
              rationale: "The user requested durable memory.",
              content: "Prefer concise output.",
            },
          }).snapshot,
      );

      expect(publications).toEqual([]);
      const disposing = controller.dispose();
      const [firstPublication, secondPublication] = await Promise.all([
        first,
        second,
        disposing.then(() => second),
      ]);

      expect(firstPublication).toBe(secondPublication);
      expect(publications).toEqual([secondPublication]);
      expect(secondPublication.revision).toBe(1);
      expect(secondPublication.snapshot.ui.memoryCandidateNudge?.id).toBe(
        "memory-nudge",
      );
      expect(Object.isFrozen(secondPublication.snapshot)).toBe(true);
      expect(Object.isFrozen(secondPublication.snapshot.ui)).toBe(true);
      expect(onSnapshotBuilt).toHaveBeenCalledOnce();
      expect(onSnapshotBuilt.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(0);
      await expect(
        controller.scheduleProjectedSnapshot(() => secondPublication.snapshot),
      ).rejects.toThrow("ask_agent_snapshot_queue_disposed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes immutable revisioned snapshots through the shared queue", async () => {
    const publications: AskAgentControllerPublication[] = [];
    const controller = createController(publications);
    const firstSnapshot = controller.projectState({
      now: 100,
      theme,
      modelCredentialStatus: missingCredential,
    }).snapshot;
    const secondSnapshot = controller.projectState({
      now: 200,
      theme,
      modelCredentialStatus: missingCredential,
    }).snapshot;

    const first = await controller.publishSnapshot(firstSnapshot);
    const second = await controller.publishSnapshot(secondSnapshot);

    expect(publications).toEqual([first, second]);
    expect(first).toMatchObject({ revision: 1, snapshot: firstSnapshot });
    expect(second).toMatchObject({ revision: 2, snapshot: secondSnapshot });
    expect(first.serialized).toBe(JSON.stringify(firstSnapshot));
    expect(second.serialized).toBe(JSON.stringify(secondSnapshot));
    expect(first.bytes).toBe(Buffer.byteLength(first.serialized, "utf8"));
    expect(() => {
      (
        first.snapshot.session.foreground.projectedMessages as ChatMessage[]
      ).push({
        id: "mutation",
        role: "user",
        content: "Must not mutate",
        timestamp: 300,
        blocks: [{ type: "text", text: "Must not mutate" }],
      });
    }).toThrow();
    expect(first.serialized).toBe(JSON.stringify(first.snapshot));

    await controller.dispose();
    await expect(controller.publishSnapshot(firstSnapshot)).rejects.toThrow(
      "ask_agent_snapshot_queue_disposed",
    );
  });
});
