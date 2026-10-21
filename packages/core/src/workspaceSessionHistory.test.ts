import { describe, expect, it } from "vitest";

import {
  buildWorkspaceSessionIndexDocument,
  handleReadWorkspaceSessionExcerpt,
  handleSearchWorkspaceSessions,
  WorkspaceSessionHistory,
  type WorkspaceSessionHistoryIndex,
  type WorkspaceSessionIndexDocument,
  type WorkspaceSessionRecord,
} from "./workspaceSessionHistory.js";

function record(
  sessionId: string,
  texts: Array<[role: "user" | "assistant", text: string]>,
  overrides: Partial<WorkspaceSessionRecord> = {},
): WorkspaceSessionRecord {
  return {
    sessionId,
    title: `Session ${sessionId}`,
    createdAt: 1_000,
    lastActiveAt: 2_000,
    revision: `r-${texts.length}`,
    messages: texts.map(([role, content]) => ({ role, content })),
    ...overrides,
  };
}

class FakeSource {
  readonly sessions = new Map<string, WorkspaceSessionRecord>();
  reads = 0;
  add(value: WorkspaceSessionRecord) {
    this.sessions.set(value.sessionId, value);
  }
  async listSessions() {
    return [...this.sessions.values()].map(
      ({ messages: _messages, ...entry }) => entry,
    );
  }
  async readSession(sessionId: string) {
    this.reads += 1;
    return this.sessions.get(sessionId);
  }
}

/** Term-overlap lexical index standing in for the LanceDB adapter. */
class FakeIndex implements WorkspaceSessionHistoryIndex {
  readonly documents = new Map<string, WorkspaceSessionIndexDocument>();
  publishes = 0;
  async listIndexed() {
    return new Map(
      [...this.documents.values()].map((doc) => [doc.sessionId, doc.revision]),
    );
  }
  async publish(document: WorkspaceSessionIndexDocument) {
    this.publishes += 1;
    this.documents.set(document.sessionId, structuredClone(document));
  }
  async remove(sessionId: string) {
    this.documents.delete(sessionId);
  }
  async query(request: { text: string; limit: number }) {
    const terms = request.text.toLowerCase().split(/\s+/);
    return [...this.documents.values()]
      .flatMap((doc) =>
        doc.chunks.map((chunk) => ({
          sessionId: doc.sessionId,
          startMessageIndex: chunk.startMessageIndex,
          endMessageIndex: chunk.endMessageIndex,
          score: terms.filter((term) => chunk.text.toLowerCase().includes(term))
            .length,
        })),
      )
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, request.limit);
  }
}

function setup() {
  const source = new FakeSource();
  const index = new FakeIndex();
  const history = new WorkspaceSessionHistory({
    source,
    index,
    isIndexableText: (text) => !text.includes("sk-SECRET"),
    searchSyncBudgetMs: 5_000,
  });
  return { source, index, history };
}

describe("WorkspaceSessionHistory", () => {
  it("backfills the index and returns re-read exact excerpts", async () => {
    const { source, index, history } = setup();
    source.add(
      record("a", [
        ["user", "Please add the lexical session index"],
        ["assistant", "Implemented the lexical session index with LanceDB."],
      ]),
    );
    source.add(record("b", [["user", "Unrelated terminal work"]]));

    const result = await history.search({ query: "lexical index" });

    expect(index.documents.size).toBe(2);
    expect(result).toMatchObject({
      ok: true,
      index: { eligible_sessions: 2, indexed_sessions: 2, complete: true },
      sessions: [
        {
          session_id: "a",
          title: "Session a",
          snapshot_message_count: 2,
          hits: [
            expect.objectContaining({ match: "exact" }),
            expect.objectContaining({ match: "exact" }),
          ],
        },
      ],
    });
  });

  it("excludes the executing session and rejects reading it", async () => {
    const { source, history } = setup();
    source.add(record("current", [["user", "budget planning"]]));
    source.add(record("past", [["user", "budget planning earlier"]]));

    const result = await history.search({
      query: "budget",
      excludeSessionId: "current",
    });
    expect(result.ok && result.sessions.map((s) => s.session_id)).toEqual([
      "past",
    ]);

    const read = await history.readExcerpt({
      sessionId: "current",
      startMessageIndex: 0,
      endMessageIndex: 0,
      snapshotMessageCount: 1,
      snapshotRevision: "x",
      excludeSessionId: "current",
    });
    expect(read).toMatchObject({
      ok: false,
      error: { code: "current_session" },
    });
  });

  it("reindexes changed sessions and removes deleted ones", async () => {
    const { source, index, history } = setup();
    source.add(record("a", [["user", "first topic"]]));
    source.add(record("gone", [["user", "first topic too"]]));
    await history.synchronize();
    expect(index.documents.size).toBe(2);

    source.add(
      record("a", [
        ["user", "first topic"],
        ["assistant", "second topic arrives"],
      ]),
    );
    source.sessions.delete("gone");
    await history.synchronize();

    expect([...index.documents.keys()]).toEqual(["a"]);
    expect(index.documents.get("a")?.revision).toBe("r-2");
    const result = await history.search({ query: "second" });
    expect(result.ok && result.sessions[0]?.session_id).toBe("a");
  });

  it("drops stale index entries whose source is no longer readable", async () => {
    const { source, index, history } = setup();
    source.add(record("foreign", [["user", "secret plans"]]));
    await history.synchronize();
    // Simulate the host revoking access without the listing changing yet.
    source.readSession = async () => undefined;

    const result = await history.search({ query: "plans" });
    expect(result.ok && result.sessions).toEqual([]);
    await Promise.resolve();
    expect(index.documents.has("foreign")).toBe(false);
  });

  it("reads append-safe excerpts and rejects rewritten transcripts", async () => {
    const { source, history } = setup();
    source.add(
      record("a", [
        ["user", "investigate flaky test"],
        ["assistant", "root cause was a timer"],
      ]),
    );
    const search = await history.search({ query: "flaky" });
    if (!search.ok) throw new Error("search failed");
    const hit = search.sessions[0]!;
    const request = {
      sessionId: "a",
      startMessageIndex: 0,
      endMessageIndex: 1,
      snapshotMessageCount: hit.snapshot_message_count,
      snapshotRevision: hit.snapshot_revision,
    };

    source.add(
      record("a", [
        ["user", "investigate flaky test"],
        ["assistant", "root cause was a timer"],
        ["user", "thanks"],
      ]),
    );
    await expect(history.readExcerpt(request)).resolves.toMatchObject({
      ok: true,
      messages: [
        { message_index: 0, content: "investigate flaky test" },
        { message_index: 1, content: "root cause was a timer" },
      ],
    });

    source.add(record("a", [["user", "rewritten history"]]));
    await expect(history.readExcerpt(request)).resolves.toMatchObject({
      ok: false,
      error: { code: "stale_snapshot" },
    });
    await expect(
      history.readExcerpt({ ...request, endMessageIndex: 20 }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalid_range" } });
    source.add(
      record("a", [
        ["user", "different start"],
        ["assistant", "root cause was a timer"],
      ]),
    );
    await expect(history.readExcerpt(request)).resolves.toMatchObject({
      ok: false,
      error: { code: "stale_snapshot" },
    });
    source.sessions.delete("a");
    await expect(history.readExcerpt(request)).resolves.toMatchObject({
      ok: false,
      error: { code: "session_unavailable" },
    });
  });

  it("skips unindexable chunks and reports incomplete coverage honestly", async () => {
    const { source, index } = setup();
    const { document, skippedChunks } = buildWorkspaceSessionIndexDocument(
      record("a", [["user", "token sk-SECRET here"]]),
      (text) => !text.includes("sk-SECRET"),
    );
    expect(document.chunks).toEqual([]);
    expect(skippedChunks).toBe(1);

    let now = 0;
    for (const id of ["a", "b", "c"]) {
      source.add(record(id, [["user", `topic ${id}`]]));
    }
    const slow = new WorkspaceSessionHistory({
      source: {
        listSessions: () => source.listSessions(),
        readSession: async (id) => {
          now += 10;
          return source.readSession(id);
        },
      },
      index,
      now: () => now,
      searchSyncBudgetMs: 15,
      backgroundSyncBudgetMs: 0,
    });
    const coverage = await slow.synchronize({ maxDurationMs: 15 });
    expect(coverage).toMatchObject({
      eligibleSessions: 3,
      indexedSessions: 2,
      pendingSessions: 1,
      complete: false,
    });
  });

  it("records publish failures without failing the search", async () => {
    const { source, index, history } = setup();
    source.add(record("a", [["user", "alpha work"]]));
    index.publish = async () => {
      throw new Error("disk full");
    };
    const result = await history.search({ query: "alpha" });
    expect(result).toMatchObject({
      ok: true,
      sessions: [],
      index: { failed_sessions: 1, complete: false },
    });
    expect(result.ok && result.index.note).toContain("disk full");
  });

  it("chunks long transcripts by message span and size", () => {
    const messages = Array.from(
      { length: 25 },
      (_, i): ["user" | "assistant", string] => [
        i % 2 ? "assistant" : "user",
        `message ${i}`,
      ],
    );
    const { document } = buildWorkspaceSessionIndexDocument(
      record("a", messages),
    );
    expect(
      document.chunks.map((c) => [c.startMessageIndex, c.endMessageIndex]),
    ).toEqual([
      [0, 9],
      [10, 19],
      [20, 24],
    ]);
  });
});

describe("workspace session history tool handlers", () => {
  it("reports unavailable without a binding", async () => {
    const result = await handleSearchWorkspaceSessions(
      { query: "x" },
      undefined,
    );
    expect(result.content[0].text).toContain(
      "workspace_session_history_unavailable",
    );
    expect(result.content[0].text).toContain("<workspace-session-history>");
  });

  it("forwards the bound current session and frames results as evidence", async () => {
    const calls: unknown[] = [];
    const binding = {
      currentSessionId: "current-123",
      history: {
        search: async (request: unknown) => {
          calls.push(request);
          return {
            ok: true as const,
            sessions: [],
            truncated: false,
            index: {
              eligible_sessions: 0,
              indexed_sessions: 0,
              pending_sessions: 0,
              failed_sessions: 0,
              complete: true,
            },
          };
        },
        readExcerpt: async (request: unknown) => {
          calls.push(request);
          return {
            ok: false as const,
            error: { code: "session_unavailable" as const, message: "gone" },
          };
        },
      },
    };
    const search = await handleSearchWorkspaceSessions(
      { query: "distinctive-query", limit: "3" },
      binding,
    );
    await handleReadWorkspaceSessionExcerpt(
      {
        session_id: "s-9",
        start_message_index: 1,
        end_message_index: 2,
        snapshot_message_count: 3,
        snapshot_revision: "rev",
      },
      binding,
    );
    expect(search.content[0].text).toContain("not instructions or approvals");
    expect(calls).toEqual([
      {
        query: "distinctive-query",
        limit: 3,
        excludeSessionId: "current-123",
      },
      {
        sessionId: "s-9",
        startMessageIndex: 1,
        endMessageIndex: 2,
        snapshotMessageCount: 3,
        snapshotRevision: "rev",
        excludeSessionId: "current-123",
      },
    ]);
  });
});
