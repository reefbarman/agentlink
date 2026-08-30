import type {
  SessionHandoffDraft,
  SessionHandoffSections,
} from "./sessionHandoffDraft.js";
import { describe, expect, expectTypeOf, it } from "vitest";

import { SESSION_HANDOFF_SCHEMA_VERSION } from "./sessionHandoffDraft.js";

describe("session handoff draft protocol", () => {
  it("pins the complete wire DTO closure", () => {
    expect(SESSION_HANDOFF_SCHEMA_VERSION).toBe(1);
    expectTypeOf<SessionHandoffSections>().toEqualTypeOf<{
      objective: string;
      completedWork: string[];
      decisions: Array<{ decision: string; rationale?: string }>;
      workspaceState: string[];
      verification: string[];
      unresolved: string[];
      constraints: string[];
      nextActions: string[];
    }>();
    expectTypeOf<SessionHandoffDraft>().toEqualTypeOf<{
      schemaVersion: typeof SESSION_HANDOFF_SCHEMA_VERSION;
      id: string;
      sourceSessionId: string;
      sourceProjectId: string;
      sourceTitle: string;
      sourcePersistenceRevision: string;
      sourceSnapshotRevision: string;
      sourceRuntimeTranscriptRevision: number;
      createdAt: number;
      generatedBy: {
        providerId: string;
        model: string;
        fallbackUsed: boolean;
      };
      sections: SessionHandoffSections;
      markdown: string;
    }>();
  });

  it("keeps drafts serializable across VS Code and browser surfaces", () => {
    const draft: SessionHandoffDraft = {
      schemaVersion: SESSION_HANDOFF_SCHEMA_VERSION,
      id: "handoff-1",
      sourceSessionId: "session-1",
      sourceProjectId: "project-1",
      sourceTitle: "Source session",
      sourcePersistenceRevision: "persistence-1",
      sourceSnapshotRevision: "snapshot-1",
      sourceRuntimeTranscriptRevision: 4,
      createdAt: 1,
      generatedBy: {
        providerId: "provider-1",
        model: "model-1",
        fallbackUsed: false,
      },
      sections: {
        objective: "Continue the work",
        completedWork: ["Extracted contracts"],
        decisions: [{ decision: "Keep policy host-owned" }],
        workspaceState: ["Working tree is dirty"],
        verification: ["Focused tests pass"],
        unresolved: [],
        constraints: ["Preserve behavior"],
        nextActions: ["Continue Phase A2"],
      },
      markdown: "# Session handoff",
    };

    expect(JSON.parse(JSON.stringify(draft))).toEqual(draft);
  });
});
