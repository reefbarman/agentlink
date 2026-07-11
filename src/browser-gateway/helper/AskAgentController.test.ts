/** @vitest-environment node */

import * as http from "http";
import * as os from "os";
import * as path from "path";

import type {
  AskAgentController,
  AskAgentControllerPublication,
} from "./AskAgentController.js";
import { describe, expect, it } from "vitest";

import { BROWSER_GATEWAY_ASK_AGENT_SESSION_ID } from "../browserGatewayAskAgentSessionStore.js";
import { BrowserGatewayAskAgentHistoryStore } from "../browserGatewayAskAgentHistory.js";
import { BrowserGatewayAskAgentMemoryStore } from "../browserGatewayAskAgentMemory.js";
import { BrowserGatewayAskAgentPreferencesStore } from "../browserGatewayAskAgentPreferences.js";
import { BrowserGatewayHelper } from "./browserGatewayHelper.js";
import type { ChatMessage } from "../../agent/webview/types.js";

function createController(
  publications: AskAgentControllerPublication[],
): AskAgentController {
  const storeRoot = path.join(
    os.tmpdir(),
    `.tmp-ask-agent-controller-${Date.now()}-${Math.random()}`,
  );
  return new BrowserGatewayHelper(
    {
      port: 0,
      helperVersion: "test-version",
      idleShutdownMs: 120_000,
      extensionRootPath: storeRoot,
      askAgentLogPath: path.join(storeRoot, "ask-agent.jsonl"),
    },
    http.createServer(),
    {
      askAgentPreferencesStore: new BrowserGatewayAskAgentPreferencesStore({
        filePath: path.join(storeRoot, "preferences.json"),
      }),
      askAgentHistoryStore: new BrowserGatewayAskAgentHistoryStore({
        filePath: path.join(storeRoot, "history.json"),
      }),
      askAgentMemoryStore: new BrowserGatewayAskAgentMemoryStore({
        filePath: path.join(storeRoot, "memory.json"),
      }),
      beforeAskAgentSnapshotPublish: (publication) => {
        publications.push(publication);
      },
    },
  );
}

describe("AskAgentController boundary", () => {
  it("restores persisted preferences and history without ephemeral turn state", async () => {
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

    const snapshot = await controller.buildSnapshot();

    expect(snapshot.session.foreground).toMatchObject({
      sessionId: BROWSER_GATEWAY_ASK_AGENT_SESSION_ID,
      title: "Restored session",
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      streaming: false,
      status: "idle",
      questionRequest: null,
      restoringSession: false,
    });
    expect(snapshot.session.foreground.projectedMessages).toEqual([
      restoredMessage,
    ]);
    expect(snapshot.ui).toMatchObject({
      approval: null,
      question: null,
      questionProgress: null,
    });
    expect(publications).toEqual([]);

    await controller.dispose();
  });

  it("publishes immutable revisioned snapshots through the shared queue", async () => {
    const publications: AskAgentControllerPublication[] = [];
    const controller = createController(publications);
    const firstSnapshot = await controller.buildSnapshot();
    const secondSnapshot = await controller.buildSnapshot();

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
    expect(await controller.cancelActiveTurn()).toBeNull();

    await controller.dispose();
    await expect(controller.publishSnapshot(firstSnapshot)).rejects.toThrow(
      "ask_agent_snapshot_queue_disposed",
    );
  });
});
