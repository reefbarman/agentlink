import {
  SESSION_HANDOFF_MARKDOWN_MAX_CHARS,
  SESSION_HANDOFF_SOURCE_PACK_MAX_CHARS,
  buildDeterministicSessionHandoffMarkdown,
  buildSessionHandoffSourcePack,
  isSessionHandoffDraftFresh,
  normalizePersistedSessionLineage,
  projectSessionLineageSummary,
  toPersistedSessionHandoff,
  validateSessionHandoffMarkdown,
} from "./sessionHandoff.js";
import { describe, expect, it } from "vitest";

import type { AgentMessage } from "./types.js";

const source = {
  sessionId: "source-session",
  projectId: "project-a",
  title: "Investigate handoff",
  mode: "code",
  model: "gpt-5.6-terra",
};

function draft(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    id: "handoff-1",
    sourceSessionId: source.sessionId,
    sourceProjectId: source.projectId,
    sourceTitle: source.title,
    sourcePersistenceRevision: "7",
    sourceSnapshotRevision: "snapshot-1",
    sourceRuntimeTranscriptRevision: 12,
    createdAt: 1,
    generatedBy: { providerId: "test", model: "test", fallbackUsed: false },
    sections: {
      objective: "Continue",
      completedWork: [],
      decisions: [],
      workspaceState: [],
      verification: [],
      unresolved: [],
      constraints: [],
      nextActions: [],
    },
    markdown: "# Handoff\nContinue safely.",
    ...overrides,
  };
}

describe("buildSessionHandoffSourcePack", () => {
  it("retains bounded host-safe continuity evidence and excludes private payloads", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Implement the handoff flow." },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "PRIVATE_THOUGHT", signature: "test" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "I decided we should use CAS." }],
      },
      ...Array.from({ length: 17 }, (_, index) => ({
        role: "assistant" as const,
        content: [{ type: "text" as const, text: `Recent turn ${index}` }],
      })),
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "x",
            content: "PRIVATE_TOOL_RESULT",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "latest summary" }],
        isSummary: true,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "apiKey=secret-value" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "diagnostic" }],
        diagnosticOnly: true,
      },
    ];

    const pack = buildSessionHandoffSourcePack({
      source,
      messages,
      todos: [
        {
          id: "todo-1",
          content: "Add persistence tests",
          activeForm: "Adding persistence tests",
          status: "pending",
        },
      ],
      finalMarker: { status: "completed", source: "tool", summary: "Ready" },
    });

    const serialized = JSON.stringify(pack);
    expect(pack.latestSummary).toBe("latest summary");
    expect(pack.canonicalUserMessages).toEqual(["Implement the handoff flow."]);
    expect(pack.olderDecisionCandidates).toContain(
      "I decided we should use CAS.",
    );
    expect(pack.todos).toHaveLength(1);
    expect(pack.finalMarker).toEqual({ status: "completed", summary: "Ready" });
    expect(pack.omitted).toMatchObject({
      unsafeText: 1,
      diagnosticMessages: 1,
      nonTextBlocks: 1,
      toolResultMessages: 1,
    });
    expect(serialized).not.toContain("PRIVATE_THOUGHT");
    expect(serialized).not.toContain("PRIVATE_TOOL_RESULT");
    expect(serialized).not.toContain("secret-value");
  });

  it("redacts a secret-like source title before the pack reaches a generator", () => {
    const pack = buildSessionHandoffSourcePack({
      source: { ...source, title: "apiKey=not-for-handoff" },
      messages: [{ role: "user", content: "Continue safely." }],
    });

    expect(pack.source.title).toBe("Source session");
    expect(pack.omitted.unsafeText).toBe(1);
    expect(JSON.stringify(pack)).not.toContain("not-for-handoff");
  });

  it("keeps the source pack under its serialized budget", () => {
    const messages: AgentMessage[] = Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Decision ${index}: ${"x".repeat(4_000)}`,
    }));

    const pack = buildSessionHandoffSourcePack({ source, messages });

    expect(JSON.stringify(pack).length).toBeLessThanOrEqual(
      SESSION_HANDOFF_SOURCE_PACK_MAX_CHARS,
    );
  });
});

describe("session handoff markdown", () => {
  it("builds a deterministic bounded fallback", () => {
    const pack = buildSessionHandoffSourcePack({
      source,
      messages: [{ role: "user", content: "Continue the migration." }],
    });

    const markdown = buildDeterministicSessionHandoffMarkdown(pack);

    expect(markdown).toContain("## Objective");
    expect(markdown).toContain("Continue the migration.");
    expect(markdown.length).toBeLessThanOrEqual(
      SESSION_HANDOFF_MARKDOWN_MAX_CHARS,
    );
    expect(validateSessionHandoffMarkdown(markdown)).toEqual({
      ok: true,
      markdown,
    });
  });

  it("rejects empty, oversized, and detected-sensitive reviewed Markdown", () => {
    expect(validateSessionHandoffMarkdown("  ")).toMatchObject({
      code: "empty",
    });
    expect(
      validateSessionHandoffMarkdown(
        "x".repeat(SESSION_HANDOFF_MARKDOWN_MAX_CHARS + 1),
      ),
    ).toMatchObject({
      code: "too_large",
    });
    expect(
      validateSessionHandoffMarkdown("token=very-secret-value"),
    ).toMatchObject({
      code: "sensitive_content",
    });
  });

  it("converts only valid reviewed Markdown to its compact persisted contract", () => {
    expect(
      toPersistedSessionHandoff(draft(), "# Reviewed\nContinue safely."),
    ).toEqual({
      schemaVersion: 1,
      handoffId: "handoff-1",
      sourceSessionId: "source-session",
      sourceProjectId: "project-a",
      sourceTitle: "Investigate handoff",
      sourcePersistenceRevision: "7",
      sourceSnapshotRevision: "snapshot-1",
      createdAt: 1,
      reviewedMarkdown: "# Reviewed\nContinue safely.",
    });
    expect(() => toPersistedSessionHandoff(draft(), "secret=value")).toThrow(
      "sensitive_content",
    );
  });
});

describe("persisted lineage contracts", () => {
  it("normalizes valid records and projects index-safe links", () => {
    const lineage = normalizePersistedSessionLineage({
      schemaVersion: 1,
      handoffSource: {
        schemaVersion: 1,
        handoffId: "handoff-1",
        sourceSessionId: "source-session",
        sourceProjectId: "project-a",
        sourceTitle: "Source",
        sourcePersistenceRevision: "7",
        sourceSnapshotRevision: "snapshot-1",
        createdAt: 1,
        reviewedMarkdown: "# Reviewed\nContinue.",
      },
      handoffSuccessor: {
        sessionId: "successor-session",
        projectId: "project-a",
        handoffId: "handoff-2",
        titleAtCreation: "Continue: Source",
        state: "committed",
        createdAt: 2,
      },
    });

    expect(lineage).toBeDefined();
    expect(projectSessionLineageSummary(lineage)).toEqual({
      source: {
        sessionId: "source-session",
        projectId: "project-a",
        handoffId: "handoff-1",
        titleAtCreation: "Source",
      },
      successor: {
        sessionId: "successor-session",
        projectId: "project-a",
        handoffId: "handoff-2",
        titleAtCreation: "Continue: Source",
        state: "committed",
      },
    });
  });

  it("fails closed for malformed or sensitive records", () => {
    expect(
      normalizePersistedSessionLineage({ schemaVersion: 2 }),
    ).toBeUndefined();
    expect(
      normalizePersistedSessionLineage({
        schemaVersion: 1,
        handoffSource: { reviewedMarkdown: "token=secret" },
      }),
    ).toBeUndefined();
    expect(
      normalizePersistedSessionLineage({
        schemaVersion: 1,
        handoffSource: {
          schemaVersion: 1,
          handoffId: "handoff-1",
          sourceSessionId: "source-session",
          sourceProjectId: "project-a",
          sourceTitle: "token=secret",
          sourcePersistenceRevision: "7",
          sourceSnapshotRevision: "snapshot-1",
          createdAt: 1,
          reviewedMarkdown: "# Reviewed\nContinue.",
        },
      }),
    ).toBeUndefined();
  });
});

describe("isSessionHandoffDraftFresh", () => {
  it("uses canonical content revision for freshness and treats persistence revision separately", () => {
    const input = draft();
    expect(
      isSessionHandoffDraftFresh(input, {
        runtimeTranscriptRevision: 12,
        snapshotRevision: "snapshot-1",
      }),
    ).toBe(true);
    expect(
      isSessionHandoffDraftFresh(input, {
        runtimeTranscriptRevision: 13,
        snapshotRevision: "snapshot-1",
      }),
    ).toBe(false);
    expect(
      isSessionHandoffDraftFresh(input, {
        snapshotRevision: "snapshot-1",
      }),
    ).toBe(true);
    expect(
      isSessionHandoffDraftFresh(input, {
        runtimeTranscriptRevision: 12,
        snapshotRevision: "snapshot-2",
      }),
    ).toBe(false);
  });
});
