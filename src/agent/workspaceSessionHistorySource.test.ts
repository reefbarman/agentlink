import type {
  PersistedSessionRecord,
  SessionPersistenceProvider,
} from "./persistenceContracts.js";
import { describe, expect, it } from "vitest";

import type { SessionProjectScope } from "@agentlink/protocol/workspace-project";
import type { SessionSummary } from "./SessionStore.js";
import { createPersistedWorkspaceSessionHistorySource } from "./workspaceSessionHistorySource.js";

function scope(projectId: string): SessionProjectScope {
  return {
    schemaVersion: 1,
    kind: "project",
    projectId,
    workspaceFolderUri: `file:///work/${projectId}`,
    displayName: projectId,
  };
}

function summary(
  id: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    schemaVersion: 1,
    id,
    mode: "code",
    model: "m",
    title: `Title ${id}`,
    messageCount: 1,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    createdAt: 10,
    lastActiveAt: 20,
    projectScope: scope("p1"),
    ...overrides,
  };
}

function persistence(
  records: Array<{
    summary: SessionSummary;
    metadata?: Partial<PersistedSessionRecord["metadata"]>;
  }>,
): Pick<SessionPersistenceProvider, "listSessions" | "readSession"> {
  return {
    listSessions: async () => ({
      value: records.map((r) => r.summary),
      revision: "1",
    }),
    readSession: async (id) => {
      const found = records.find((r) => r.summary.id === id);
      if (!found) return { ok: false, reason: "not_found" };
      return {
        ok: true,
        revision: "1",
        value: {
          summary: found.summary,
          messages: [{ role: "user", content: `hello from ${id}` }],
          metadata: {
            mode: "code",
            model: "m",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            projectScope: found.summary.projectScope,
            ...found.metadata,
          },
        } as PersistedSessionRecord,
      };
    },
  };
}

describe("createPersistedWorkspaceSessionHistorySource", () => {
  const records = [
    { summary: summary("own") },
    { summary: summary("background", { background: true }) },
    { summary: summary("other", { projectScope: scope("p2") }) },
    { summary: summary("unscoped", { projectScope: undefined }) },
    {
      summary: summary("fleet"),
      metadata: { fleet: {} as never },
    },
    {
      // Index projection claims p1 but authoritative metadata says p2.
      summary: summary("moved"),
      metadata: { projectScope: scope("p2") },
    },
  ];
  const source = createPersistedWorkspaceSessionHistorySource({
    persistence: persistence(records),
    projectScope: scope("p1"),
  });

  it("lists only foreground sessions of the bound project", async () => {
    expect((await source.listSessions()).map((s) => s.sessionId)).toEqual([
      "own",
      "fleet",
      "moved",
    ]);
  });

  it("re-validates authoritative metadata on read", async () => {
    await expect(source.readSession("own")).resolves.toMatchObject({
      sessionId: "own",
      revision: "20:1",
      messages: [{ role: "user", content: "hello from own" }],
    });
    for (const id of [
      "background",
      "other",
      "unscoped",
      "fleet",
      "moved",
      "missing",
    ]) {
      await expect(source.readSession(id)).resolves.toBeUndefined();
    }
  });
});
