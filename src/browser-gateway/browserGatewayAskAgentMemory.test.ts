import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import {
  BROWSER_GATEWAY_ASK_AGENT_MEMORY_SCHEMA_VERSION,
  BrowserGatewayAskAgentMemoryStore,
  getAskAgentMemorySourceRevision,
  hasAskAgentMemoryPastIntent,
  normalizeAskAgentMemorySnapshot,
  searchAskAgentMemory,
  tokenizeAskAgentMemoryText,
  type BrowserGatewayAskAgentMemorySnapshot,
} from "./browserGatewayAskAgentMemory.js";

async function tempFile(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ask-agent-memory-"));
  return path.join(dir, name);
}

function snapshot(
  overrides: Partial<BrowserGatewayAskAgentMemorySnapshot> = {},
): BrowserGatewayAskAgentMemorySnapshot {
  return {
    schemaVersion: BROWSER_GATEWAY_ASK_AGENT_MEMORY_SCHEMA_VERSION,
    updatedAt: 1_000,
    sessions: [],
    chunks: [],
    ...overrides,
  };
}

describe("BrowserGatewayAskAgentMemory", () => {
  it("normalizes malformed snapshots and deduplicates sessions/chunks", () => {
    const normalized = normalizeAskAgentMemorySnapshot(
      {
        schemaVersion: 999,
        updatedAt: 500,
        sessions: [
          null,
          { sessionId: "", title: "Ignored" },
          {
            sessionId: "session-1",
            title: "Old",
            createdAt: 100,
            lastActiveAt: 200,
            messageCount: 2,
            sourceRevision: "old",
            summary: "Old summary",
            topics: ["alpha"],
            updatedAt: 200,
          },
          {
            sessionId: "session-1",
            title: "New",
            createdAt: 100,
            lastActiveAt: 300,
            messageCount: 3,
            sourceRevision: "new",
            summary: "New summary",
            topics: ["beta", "beta", ""],
            decisions: ["Ship it"],
            openQuestions: [""],
            durableCandidateHints: ["Remember beta"],
            updatedAt: 300,
          },
          {
            sessionId: "session-2",
            title: "Second",
            createdAt: 50,
            lastActiveAt: 250,
            messageCount: -1,
            summary: "Second summary",
            updatedAt: 250,
          },
        ],
        chunks: [
          {
            id: "chunk-1",
            sessionId: "session-1",
            sourceMessageIds: ["m1", "m1", ""],
            startMessageIndex: 3,
            endMessageIndex: 1,
            summary: "Chunk summary",
            keywords: ["beta", "beta"],
            entities: ["AgentLink"],
            updatedAt: 300,
          },
          {
            id: "orphan",
            sessionId: "missing-session",
            summary: "Ignored orphan",
          },
        ],
      },
      { maxSessions: 1, maxChunks: 10 },
    );

    expect(normalized).toEqual({
      schemaVersion: BROWSER_GATEWAY_ASK_AGENT_MEMORY_SCHEMA_VERSION,
      updatedAt: 500,
      sessions: [
        expect.objectContaining({
          sessionId: "session-1",
          title: "New",
          messageCount: 3,
          topics: ["beta"],
          decisions: ["Ship it"],
          durableCandidateHints: ["Remember beta"],
        }),
      ],
      chunks: [
        expect.objectContaining({
          id: "chunk-1",
          sessionId: "session-1",
          sourceMessageIds: ["m1"],
          startMessageIndex: 3,
          endMessageIndex: 3,
          keywords: ["beta"],
        }),
      ],
    });
  });

  it("computes stable source revisions from message identity and content", () => {
    const messages = [
      { id: "m1", role: "user" as const, content: "Hello" },
      {
        id: "m2",
        role: "assistant" as const,
        content: "Hi",
        error: { message: "", retryable: false, code: "" },
      },
    ];

    expect(getAskAgentMemorySourceRevision(messages)).toBe(
      getAskAgentMemorySourceRevision(messages),
    );
    expect(
      getAskAgentMemorySourceRevision([
        ...messages.slice(0, 1),
        { ...messages[1], content: "Changed" },
      ]),
    ).not.toBe(getAskAgentMemorySourceRevision(messages));
  });

  it("recovers gracefully from corrupt memory JSON", async () => {
    const filePath = await tempFile("memory.json");
    await fs.writeFile(filePath, "{not-json", "utf-8");

    const store = new BrowserGatewayAskAgentMemoryStore({ filePath });

    await expect(store.read()).resolves.toEqual({
      schemaVersion: BROWSER_GATEWAY_ASK_AGENT_MEMORY_SCHEMA_VERSION,
      updatedAt: 0,
      sessions: [],
      chunks: [],
    });
  });

  it("serializes read-modify-write updates without losing concurrent mutations", async () => {
    const store = new BrowserGatewayAskAgentMemoryStore({
      filePath: await tempFile("memory.json"),
    });

    await Promise.all([
      store.upsertSessionMemory({
        sessionId: "session-a",
        title: "A",
        createdAt: 100,
        lastActiveAt: 100,
        messageCount: 1,
        sourceRevision: "a",
        summary: "Alpha memory",
        topics: ["alpha"],
        decisions: [],
        openQuestions: [],
        durableCandidateHints: [],
        updatedAt: 100,
      }),
      store.upsertSessionMemory({
        sessionId: "session-b",
        title: "B",
        createdAt: 200,
        lastActiveAt: 200,
        messageCount: 1,
        sourceRevision: "b",
        summary: "Beta memory",
        topics: ["beta"],
        decisions: [],
        openQuestions: [],
        durableCandidateHints: [],
        updatedAt: 200,
      }),
      store.upsertChunk({
        id: "chunk-a",
        sessionId: "session-a",
        sourceMessageIds: ["a1"],
        startMessageIndex: 0,
        endMessageIndex: 1,
        sourceRevision: "chunk-a",
        summary: "Alpha chunk",
        keywords: ["alpha"],
        entities: [],
        createdAt: 100,
        updatedAt: 100,
      }),
    ]);

    const stored = await store.read();
    expect(stored.sessions.map((session) => session.sessionId).sort()).toEqual([
      "session-a",
      "session-b",
    ]);
    expect(stored.chunks.map((chunk) => chunk.id)).toEqual(["chunk-a"]);
  });

  it("uses an on-disk lock so separate store instances do not lose updates", async () => {
    const filePath = await tempFile("memory.json");
    const first = new BrowserGatewayAskAgentMemoryStore({ filePath });
    const second = new BrowserGatewayAskAgentMemoryStore({ filePath });

    await Promise.all([
      first.upsertSessionMemory({
        sessionId: "session-a",
        title: "A",
        createdAt: 100,
        lastActiveAt: 100,
        messageCount: 1,
        sourceRevision: "a",
        summary: "Alpha memory",
        topics: ["alpha"],
        decisions: [],
        openQuestions: [],
        durableCandidateHints: [],
        updatedAt: 100,
      }),
      second.upsertSessionMemory({
        sessionId: "session-b",
        title: "B",
        createdAt: 200,
        lastActiveAt: 200,
        messageCount: 1,
        sourceRevision: "b",
        summary: "Beta memory",
        topics: ["beta"],
        decisions: [],
        openQuestions: [],
        durableCandidateHints: [],
        updatedAt: 200,
      }),
    ]);

    await expect(first.read()).resolves.toEqual(
      expect.objectContaining({
        sessions: expect.arrayContaining([
          expect.objectContaining({ sessionId: "session-a" }),
          expect.objectContaining({ sessionId: "session-b" }),
        ]),
      }),
    );
  });

  it("continues processing queued updates after a failed mutation", async () => {
    const store = new BrowserGatewayAskAgentMemoryStore({
      filePath: await tempFile("memory.json"),
    });

    await expect(
      store.update(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await store.upsertSessionMemory({
      sessionId: "session-a",
      title: "A",
      createdAt: 100,
      lastActiveAt: 100,
      messageCount: 1,
      sourceRevision: "a",
      summary: "Alpha memory",
      topics: ["alpha"],
      decisions: [],
      openQuestions: [],
      durableCandidateHints: [],
      updatedAt: 100,
    });

    expect(
      (await store.read()).sessions.map((session) => session.sessionId),
    ).toEqual(["session-a"]);
  });

  it("cascades deleted sessions out of derived memory", async () => {
    const store = new BrowserGatewayAskAgentMemoryStore({
      filePath: await tempFile("memory.json"),
    });
    await store.write(
      snapshot({
        sessions: [
          {
            sessionId: "session-a",
            title: "A",
            createdAt: 100,
            lastActiveAt: 100,
            messageCount: 1,
            sourceRevision: "a",
            summary: "Alpha",
            topics: [],
            decisions: [],
            openQuestions: [],
            durableCandidateHints: [],
            updatedAt: 100,
          },
          {
            sessionId: "session-b",
            title: "B",
            createdAt: 200,
            lastActiveAt: 200,
            messageCount: 1,
            sourceRevision: "b",
            summary: "Beta",
            topics: [],
            decisions: [],
            openQuestions: [],
            durableCandidateHints: [],
            updatedAt: 200,
          },
        ],
        chunks: [
          {
            id: "chunk-a",
            sessionId: "session-a",
            sourceMessageIds: ["a1"],
            startMessageIndex: 0,
            endMessageIndex: 1,
            sourceRevision: "chunk-a",
            summary: "Alpha chunk",
            keywords: ["alpha"],
            entities: [],
            createdAt: 100,
            updatedAt: 100,
          },
          {
            id: "chunk-b",
            sessionId: "session-b",
            sourceMessageIds: ["b1"],
            startMessageIndex: 0,
            endMessageIndex: 1,
            sourceRevision: "chunk-b",
            summary: "Beta chunk",
            keywords: ["beta"],
            entities: [],
            createdAt: 200,
            updatedAt: 200,
          },
        ],
      }),
    );

    const updated = await store.deleteSessionMemory("session-a");

    expect(updated.sessions.map((session) => session.sessionId)).toEqual([
      "session-b",
    ]);
    expect(updated.chunks.map((chunk) => chunk.id)).toEqual(["chunk-b"]);
  });

  it("applies session and chunk retention caps while retaining one chunk per surviving session when possible", () => {
    const normalized = normalizeAskAgentMemorySnapshot(
      snapshot({
        sessions: [
          {
            sessionId: "old",
            title: "Old",
            createdAt: 100,
            lastActiveAt: 100,
            messageCount: 1,
            sourceRevision: "old",
            summary: "Old",
            topics: [],
            decisions: [],
            openQuestions: [],
            durableCandidateHints: [],
            updatedAt: 100,
          },
          {
            sessionId: "new",
            title: "New",
            createdAt: 200,
            lastActiveAt: 200,
            messageCount: 1,
            sourceRevision: "new",
            summary: "New",
            topics: [],
            decisions: [],
            openQuestions: [],
            durableCandidateHints: [],
            updatedAt: 200,
          },
        ],
        chunks: [
          {
            id: "old-chunk",
            sessionId: "old",
            sourceMessageIds: ["old-1"],
            startMessageIndex: 0,
            endMessageIndex: 1,
            sourceRevision: "old-chunk",
            summary: "Old chunk",
            keywords: ["old"],
            entities: [],
            createdAt: 100,
            updatedAt: 100,
          },
          {
            id: "new-chunk-1",
            sessionId: "new",
            sourceMessageIds: ["new-1"],
            startMessageIndex: 0,
            endMessageIndex: 1,
            sourceRevision: "new-chunk-1",
            summary: "New chunk 1",
            keywords: ["new"],
            entities: [],
            createdAt: 200,
            updatedAt: 200,
          },
          {
            id: "new-chunk-2",
            sessionId: "new",
            sourceMessageIds: ["new-2"],
            startMessageIndex: 2,
            endMessageIndex: 3,
            sourceRevision: "new-chunk-2",
            summary: "New chunk 2",
            keywords: ["new"],
            entities: [],
            createdAt: 250,
            updatedAt: 250,
          },
        ],
      }),
      { maxSessions: 1, maxChunks: 1 },
    );

    expect(normalized.sessions.map((session) => session.sessionId)).toEqual([
      "new",
    ]);
    expect(normalized.chunks.map((chunk) => chunk.id)).toEqual(["new-chunk-2"]);

    const withTwoSessions = normalizeAskAgentMemorySnapshot(
      snapshot({
        sessions: [
          {
            sessionId: "old",
            title: "Old",
            createdAt: 100,
            lastActiveAt: 100,
            messageCount: 1,
            sourceRevision: "old",
            summary: "Old",
            topics: [],
            decisions: [],
            openQuestions: [],
            durableCandidateHints: [],
            updatedAt: 100,
          },
          {
            sessionId: "new",
            title: "New",
            createdAt: 200,
            lastActiveAt: 200,
            messageCount: 1,
            sourceRevision: "new",
            summary: "New",
            topics: [],
            decisions: [],
            openQuestions: [],
            durableCandidateHints: [],
            updatedAt: 200,
          },
        ],
        chunks: [
          {
            id: "old-chunk",
            sessionId: "old",
            sourceMessageIds: ["old-1"],
            startMessageIndex: 0,
            endMessageIndex: 1,
            sourceRevision: "old-chunk",
            summary: "Old chunk",
            keywords: ["old"],
            entities: [],
            createdAt: 100,
            updatedAt: 100,
          },
          {
            id: "new-chunk",
            sessionId: "new",
            sourceMessageIds: ["new-1"],
            startMessageIndex: 0,
            endMessageIndex: 1,
            sourceRevision: "new-chunk",
            summary: "New chunk",
            keywords: ["new"],
            entities: [],
            createdAt: 200,
            updatedAt: 200,
          },
        ],
      }),
      { maxSessions: 2, maxChunks: 2 },
    );
    expect(withTwoSessions.chunks.map((chunk) => chunk.id).sort()).toEqual([
      "new-chunk",
      "old-chunk",
    ]);
  });

  it("derives snapshot updatedAt from child entries when top-level metadata is stale", () => {
    const normalized = normalizeAskAgentMemorySnapshot({
      schemaVersion: BROWSER_GATEWAY_ASK_AGENT_MEMORY_SCHEMA_VERSION,
      updatedAt: 0,
      sessions: [
        {
          sessionId: "session-a",
          title: "A",
          createdAt: 100,
          lastActiveAt: 100,
          messageCount: 1,
          sourceRevision: "a",
          summary: "Alpha",
          topics: [],
          decisions: [],
          openQuestions: [],
          durableCandidateHints: [],
          updatedAt: 500,
        },
      ],
      chunks: [],
    });

    expect(normalized.updatedAt).toBe(500);
  });

  it("retrieves relevant memories above deterministic thresholds", () => {
    const memories = snapshot({
      sessions: [
        {
          sessionId: "browser-mvp",
          title: "Browser Ask Agent MVP",
          createdAt: 100,
          lastActiveAt: 500,
          messageCount: 12,
          sourceRevision: "browser-mvp",
          summary:
            "We discussed Browser Ask Agent session history, retry, slash commands, and transcript export.",
          topics: ["browser ask agent", "session history", "retry"],
          decisions: ["Keep Ask Agent projectless and read-only."],
          openQuestions: [],
          durableCandidateHints: [],
          updatedAt: 500,
        },
        {
          sessionId: "unrelated",
          title: "Cooking ideas",
          createdAt: 100,
          lastActiveAt: 400,
          messageCount: 3,
          sourceRevision: "cooking",
          summary: "We discussed dinner recipes and grocery lists.",
          topics: ["cooking"],
          decisions: [],
          openQuestions: [],
          durableCandidateHints: [],
          updatedAt: 400,
        },
      ],
      chunks: [
        {
          id: "retry-chunk",
          sessionId: "browser-mvp",
          sourceMessageIds: ["m1", "m2"],
          startMessageIndex: 0,
          endMessageIndex: 1,
          sourceRevision: "retry-chunk",
          summary:
            "Retry should remove only the failed assistant error and preserve the user prompt.",
          keywords: ["retry", "assistant error", "user prompt"],
          entities: ["Browser Ask Agent"],
          createdAt: 500,
          updatedAt: 500,
        },
      ],
    });

    const results = searchAskAgentMemory(
      memories,
      "what did we decide about retry preserving prompts?",
      { now: 600, limit: 3 },
    );

    expect(results[0]).toEqual(
      expect.objectContaining({
        kind: "chunk",
        sessionId: "browser-mvp",
        chunkId: "retry-chunk",
      }),
    );
    expect(results.map((result) => result.sessionId)).not.toContain(
      "unrelated",
    );
  });

  it("uses a lower threshold for explicit past-context questions", () => {
    const memories = snapshot({
      sessions: [
        {
          sessionId: "memory-design",
          title: "Memory design",
          createdAt: 100,
          lastActiveAt: 200,
          messageCount: 4,
          sourceRevision: "memory-design",
          summary: "We talked about summaries and searchable past chats.",
          topics: ["summaries"],
          decisions: [],
          openQuestions: [],
          durableCandidateHints: [],
          updatedAt: 200,
        },
      ],
    });

    expect(hasAskAgentMemoryPastIntent("What did we discuss earlier?")).toBe(
      true,
    );
    expect(
      searchAskAgentMemory(memories, "What did we discuss earlier?", {
        now: 300,
      }),
    ).toHaveLength(1);
    expect(
      searchAskAgentMemory(memories, "Any thoughts?", { now: 300 }),
    ).toHaveLength(0);
  });

  it("treats user identity questions as explicit past-context questions", () => {
    const memories = snapshot({
      sessions: [
        {
          sessionId: "intro",
          title: "User introduction",
          createdAt: 100,
          lastActiveAt: 200,
          messageCount: 2,
          sourceRevision: "intro",
          summary: "User introduced themself and said their name is Tristan.",
          topics: ["user identity", "name"],
          decisions: [],
          openQuestions: [],
          durableCandidateHints: [],
          updatedAt: 200,
        },
      ],
      chunks: [
        {
          id: "intro-chunk",
          sessionId: "intro",
          sourceMessageIds: ["intro-user", "intro-assistant"],
          startMessageIndex: 0,
          endMessageIndex: 1,
          sourceRevision: "intro-chunk",
          summary: "User said their name is Tristan.",
          keywords: ["name", "identity"],
          entities: ["Tristan"],
          createdAt: 200,
          updatedAt: 200,
        },
      ],
    });

    expect(hasAskAgentMemoryPastIntent("What is my name?")).toBe(true);
    expect(hasAskAgentMemoryPastIntent("Who am I?")).toBe(true);
    expect(hasAskAgentMemoryPastIntent("Do you know my name?")).toBe(true);
    expect(hasAskAgentMemoryPastIntent("What should you call me?")).toBe(true);
    expect(hasAskAgentMemoryPastIntent("What name did I give you?")).toBe(true);
    for (const query of ["What is my name?", "Who am I?"]) {
      expect(searchAskAgentMemory(memories, query, { now: 300 })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "chunk",
            sessionId: "intro",
            chunkId: "intro-chunk",
          }),
        ]),
      );
    }
  });

  it("omits active-session chunks that are already present in recent transcript", () => {
    const memories = snapshot({
      sessions: [
        {
          sessionId: "active",
          title: "Active",
          createdAt: 100,
          lastActiveAt: 300,
          messageCount: 4,
          sourceRevision: "active",
          summary: "We discussed memory retrieval.",
          topics: ["memory retrieval"],
          decisions: [],
          openQuestions: [],
          durableCandidateHints: [],
          updatedAt: 300,
        },
      ],
      chunks: [
        {
          id: "recent",
          sessionId: "active",
          sourceMessageIds: ["m1", "m2"],
          startMessageIndex: 0,
          endMessageIndex: 1,
          sourceRevision: "recent",
          summary: "Memory retrieval should avoid duplicate recent context.",
          keywords: ["memory", "retrieval", "duplicate"],
          entities: [],
          createdAt: 300,
          updatedAt: 300,
        },
      ],
    });

    const results = searchAskAgentMemory(
      memories,
      "memory retrieval duplicate context",
      {
        activeSessionId: "active",
        recentMessageIds: ["m1", "m2"],
        now: 400,
      },
    );

    expect(results).toEqual([
      expect.objectContaining({ kind: "session", sessionId: "active" }),
    ]);
  });

  it("tokenizes memory text without noisy stop words", () => {
    expect(
      tokenizeAskAgentMemoryText("The Browser Ask Agent memory plan"),
    ).toEqual(["ask", "memory", "plan"]);
  });
});
