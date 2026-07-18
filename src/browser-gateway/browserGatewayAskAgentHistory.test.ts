import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { BrowserGatewayAskAgentHistoryStore } from "./browserGatewayAskAgentHistory.js";

async function makeHistoryPath(): Promise<string> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-ask-agent-history-"),
  );
  return path.join(dir, "history.json");
}

describe("BrowserGatewayAskAgentHistoryStore", () => {
  it("persists Ask Agent sessions and active session id", async () => {
    const filePath = await makeHistoryPath();
    const store = new BrowserGatewayAskAgentHistoryStore({ filePath });

    expect(await store.read()).toEqual({ sessions: [] });

    await store.write({
      activeSessionId: "session-2",
      sessions: [
        {
          id: "session-1",
          title: "First chat",
          createdAt: 100,
          lastActiveAt: 110,
          nextMessageSequence: 2,
          messages: [
            {
              id: "message-1",
              role: "user",
              content: "Hello",
              timestamp: 100,
              blocks: [{ type: "text", text: "Hello" }],
            },
          ],
        },
        {
          id: "session-2",
          title: "Second chat",
          createdAt: 200,
          lastActiveAt: 210,
          nextMessageSequence: 1,
          messages: [],
        },
      ],
    });

    const reloaded = new BrowserGatewayAskAgentHistoryStore({ filePath });
    await expect(reloaded.read()).resolves.toMatchObject({
      activeSessionId: "session-2",
      sessions: [
        {
          id: "session-1",
          title: "First chat",
          messages: [{ content: "Hello" }],
        },
        { id: "session-2", title: "Second chat", messages: [] },
      ],
    });
  });

  it("persists valid private replay and discards malformed or oversized turns atomically", async () => {
    const filePath = await makeHistoryPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({
        activeSessionId: "session-1",
        sessions: [
          {
            id: "session-1",
            title: "Replay chat",
            createdAt: 100,
            lastActiveAt: 110,
            nextMessageSequence: 3,
            messages: [
              {
                id: "user-1",
                role: "user",
                content: "Search",
                timestamp: 100,
                blocks: [{ type: "text", text: "Search" }],
              },
              {
                id: "assistant-valid",
                role: "assistant",
                content: "Answer",
                timestamp: 110,
                blocks: [{ type: "text", text: "Answer" }],
              },
            ],
            privateModelHistory: {
              schemaVersion: 1,
              assistantTurns: [
                {
                  messageId: "assistant-valid",
                  messages: [
                    {
                      role: "assistant",
                      content: [{ type: "text", text: "Answer" }],
                      providerReplay: {
                        providerId: "anthropic",
                        codecVersion: 1,
                        payload: { content: ["PRIVATE_REPLAY_SENTINEL"] },
                        serializedBytes: 64,
                      },
                    },
                  ],
                },
                {
                  messageId: "assistant-partial-invalid",
                  messages: [
                    { role: "assistant", content: "must not survive" },
                    { role: "system", content: "invalid role" },
                  ],
                },
                {
                  messageId: "assistant-oversized",
                  messages: [
                    {
                      role: "assistant",
                      content: "oversized",
                      providerReplay: {
                        providerId: "anthropic",
                        codecVersion: 1,
                        payload: null,
                        serializedBytes: 5_242_881,
                      },
                    },
                  ],
                },
              ],
            },
          },
        ],
      }),
      "utf-8",
    );

    const store = new BrowserGatewayAskAgentHistoryStore({ filePath });
    const history = await store.read();
    expect(history.sessions[0]?.messages).toHaveLength(2);
    expect(history.sessions[0]?.privateModelHistory).toEqual({
      schemaVersion: 1,
      assistantTurns: [
        {
          messageId: "assistant-valid",
          messages: [
            expect.objectContaining({
              role: "assistant",
              providerReplay: expect.objectContaining({
                payload: { content: ["PRIVATE_REPLAY_SENTINEL"] },
              }),
            }),
          ],
        },
      ],
    });
    expect(JSON.stringify(history)).not.toContain("must not survive");
    expect(JSON.stringify(history)).not.toContain("oversized");
  });

  it("serializes concurrent whole-snapshot writes in call order", async () => {
    const filePath = await makeHistoryPath();
    const store = new BrowserGatewayAskAgentHistoryStore({ filePath });

    await Promise.all([
      store.write({
        activeSessionId: "session-1",
        sessions: [
          {
            id: "session-1",
            title: "First",
            createdAt: 100,
            lastActiveAt: 100,
            nextMessageSequence: 1,
            messages: [],
          },
        ],
      }),
      store.write({
        activeSessionId: "session-2",
        sessions: [
          {
            id: "session-2",
            title: "Second",
            createdAt: 200,
            lastActiveAt: 200,
            nextMessageSequence: 1,
            messages: [],
          },
        ],
      }),
    ]);

    await expect(store.read()).resolves.toMatchObject({
      activeSessionId: "session-2",
      sessions: [{ id: "session-2", title: "Second" }],
    });
  });

  it("sanitizes malformed history files", async () => {
    const filePath = await makeHistoryPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({
        activeSessionId: "missing",
        sessions: [
          { id: "", title: "Invalid" },
          { id: "session-1", messages: "bad" },
        ],
      }),
      "utf-8",
    );

    const store = new BrowserGatewayAskAgentHistoryStore({ filePath });
    await expect(store.read()).resolves.toMatchObject({
      activeSessionId: "session-1",
      sessions: [
        {
          id: "session-1",
          title: "Ask Agent",
          messages: [],
          nextMessageSequence: 1,
        },
      ],
    });
  });
});
