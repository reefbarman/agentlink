/** @vitest-environment node */

import type { ChatMessage } from "../../agent/webview/types.js";
import type { BrowserGatewayThemeSnapshot } from "../../shared/types.js";
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
      { model: "gpt-5.3-codex", reasoningEffort: "high" },
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
      model: "gpt-5.3-codex",
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
