import type {
  ManageMemoryToolInput,
  MemoryArchiveV1,
  MemoryPanelSnapshot,
  MemoryRecord,
  RecallMemoryResult,
} from "./autonomousMemory.js";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("autonomous memory protocol", () => {
  it("preserves record, audit, archive, health, and panel wire shapes", () => {
    const record: MemoryRecord = {
      id: "memory-1",
      revision: 2,
      scope: { kind: "workspace", id: "project-1" },
      kind: "preference",
      statement: "Prefer focused tests.",
      confidence: 0.9,
      status: "active",
      provenance: [
        {
          source: "current_user",
          observedAt: "2026-08-29T00:00:00.000Z",
          sessionId: "session-1",
        },
      ],
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:01:00.000Z",
      observedAt: "2026-08-29T00:00:00.000Z",
    };
    const archive: MemoryArchiveV1 = {
      schema: "agentlink-memory",
      version: 1,
      archiveId: "archive-1",
      exportedAt: "2026-08-29T00:02:00.000Z",
      scope: record.scope,
      records: [record],
      warning: "May contain sensitive context.",
    };
    const panel: MemoryPanelSnapshot = {
      records: [record],
      total: 1,
      events: [],
      health: {
        status: "ready",
        retrieval: "hybrid",
        crud: true,
        dedupe: true,
        conflict: true,
        auditUndo: true,
        recordCount: 1,
        activeRecordCount: 1,
        auditEventCount: 0,
      },
    };

    expect(JSON.parse(JSON.stringify({ archive, panel }))).toEqual({
      archive,
      panel,
    });
  });

  it("keeps tool inputs and recalled evidence authority explicit", () => {
    expectTypeOf<ManageMemoryToolInput["operation"]>().toEqualTypeOf<
      "remember" | "update" | "supersede" | "forget" | "restore" | "undo"
    >();
    expectTypeOf<
      RecallMemoryResult["memories"][number]["authority"]
    >().toEqualTypeOf<"low-authority-evidence">();
    expectTypeOf<
      RecallMemoryResult["memories"][number]["canAuthorizeTools"]
    >().toEqualTypeOf<false>();
  });
});
