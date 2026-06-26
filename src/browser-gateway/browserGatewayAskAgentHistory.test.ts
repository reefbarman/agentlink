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
