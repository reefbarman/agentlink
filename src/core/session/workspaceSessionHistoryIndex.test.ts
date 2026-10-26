import {
  createDerivedSessionWorkspaceHistoryIndex,
  isWorkspaceHistoryIndexableText,
} from "./workspaceSessionHistoryIndex.js";
import { describe, expect, it, vi } from "vitest";

import { DerivedSessionRetrievalService } from "./DerivedSessionRetrievalService.js";
import { InMemoryRetrievalRepository } from "../retrieval/InMemoryRetrievalRepository.js";
import { WorkspaceSessionHistory } from "@agentlink/core/workspace-session-history";
import type { WorkspaceSessionRecord } from "@agentlink/core/workspace-session-history";

function session(
  sessionId: string,
  text: string,
  title = `Session ${sessionId}`,
): WorkspaceSessionRecord {
  return {
    sessionId,
    title,
    createdAt: 1_000,
    lastActiveAt: 2_000,
    revision: `rev-${sessionId}`,
    messages: [
      { role: "user", content: text },
      { role: "assistant", content: `Done: ${text}` },
    ],
  };
}

function project(
  service: DerivedSessionRetrievalService,
  projectId: string,
  records: WorkspaceSessionRecord[],
) {
  const byId = new Map(records.map((r) => [r.sessionId, r]));
  return new WorkspaceSessionHistory({
    source: {
      listSessions: async () =>
        [...byId.values()].map(({ messages: _m, ...entry }) => entry),
      readSession: async (id) => byId.get(id),
    },
    index: createDerivedSessionWorkspaceHistoryIndex({
      service,
      scope: { kind: "workspace", id: projectId },
    }),
    isIndexableText: isWorkspaceHistoryIndexableText,
  });
}

describe("createDerivedSessionWorkspaceHistoryIndex", () => {
  it("indexes, searches and deletes through the derived-session store", async () => {
    const service = new DerivedSessionRetrievalService(
      new InMemoryRetrievalRepository(),
    );
    const records = [
      session("a", "migrate the checkpoint manager to async writes"),
      session("b", "fix terminal colours"),
    ];
    const history = project(service, "project-1", records);

    const result = await history.search({ query: "checkpoint manager" });
    expect(result).toMatchObject({
      ok: true,
      index: { indexed_sessions: 2, complete: true },
      sessions: [{ session_id: "a" }],
    });

    records.pop();
    const rebuilt = project(service, "project-1", records);
    await rebuilt.synchronize();
    const inspection = await service.inspect({
      scopes: [{ kind: "workspace", id: "project-1" }],
    });
    expect(inspection.sessions.map((s) => s.sessionId)).toEqual(["a"]);
  });

  it("backfills several sessions with one batch commit", async () => {
    const service = new DerivedSessionRetrievalService(
      new InMemoryRetrievalRepository(),
    );
    const publishBatch = vi.spyOn(service, "publishBatch");
    const publish = vi.spyOn(service, "publish");
    const history = project(service, "project-1", [
      session("a", "first batched topic"),
      session("b", "second batched topic"),
      session("c", "third batched topic"),
    ]);

    await expect(history.synchronize()).resolves.toMatchObject({
      indexedSessions: 3,
      complete: true,
    });
    expect(publishBatch).toHaveBeenCalledTimes(1);
    expect(publishBatch.mock.calls[0]?.[0]).toHaveLength(3);
    expect(publish).not.toHaveBeenCalled();
    const result = await history.search({ query: "third batched" });
    expect(result.ok && result.sessions[0]?.session_id).toBe("c");
  });

  it("isolates projects and Ask Agent recall that share one store", async () => {
    const service = new DerivedSessionRetrievalService(
      new InMemoryRetrievalRepository(),
    );
    const first = project(service, "project-1", [
      session("one", "shared keyword alpha"),
    ]);
    const second = project(service, "project-2", [
      session("two", "shared keyword alpha"),
    ]);
    await first.synchronize();
    await second.synchronize();

    const result = await first.search({ query: "alpha" });
    expect(result.ok && result.sessions.map((s) => s.session_id)).toEqual([
      "one",
    ]);
    await expect(
      service.recall({
        query: "alpha",
        scopes: [{ kind: "global", id: "agentlink-user" }],
        surfaces: ["browser-ask-agent"],
      }),
    ).resolves.toEqual([]);
  });

  it("never stores credential-like chunks or titles", async () => {
    const service = new DerivedSessionRetrievalService(
      new InMemoryRetrievalRepository(),
    );
    const secret = "ghp_" + "a".repeat(36);
    const history = project(service, "project-1", [
      session("s", `use token ${secret} for deploy`, `deploy ${secret}`),
    ]);
    const coverage = await history.synchronize();
    expect(coverage).toMatchObject({ indexedSessions: 1, failedSessions: 0 });
    const [stored] = (
      await service.inspect({
        scopes: [{ kind: "workspace", id: "project-1" }],
      })
    ).sessions;
    expect(stored?.title).toBe("Untitled session");
    await expect(history.search({ query: secret })).resolves.toMatchObject({
      ok: true,
      sessions: [],
    });
  });
});
