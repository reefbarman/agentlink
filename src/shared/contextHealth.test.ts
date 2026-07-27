import { describe, expect, it } from "vitest";
import {
  projectIndexHealth,
  projectMemoryHealth,
  projectRetrievalHealth,
} from "./contextHealth.js";

describe("context health projection", () => {
  it("projects ready memory health and clamps invalid counts", () => {
    expect(
      projectMemoryHealth({
        status: "ready",
        retrieval: "hybrid",
        crud: true,
        dedupe: true,
        conflict: true,
        auditUndo: true,
        recordCount: 5,
        activeRecordCount: Number.POSITIVE_INFINITY,
        auditEventCount: 2,
      }),
    ).toEqual({
      status: "ready",
      retrieval: "hybrid",
      activeRecordCount: 0,
    });
  });

  it("maps disabled memory to the public vocabulary without exposing raw detail", () => {
    const projected = projectMemoryHealth({
      status: "unavailable",
      retrieval: "unavailable",
      crud: false,
      dedupe: false,
      conflict: false,
      auditUndo: false,
      recordCount: 0,
      activeRecordCount: 0,
      auditEventCount: 0,
      reason:
        "Autonomous memory is disabled. Secret backend path: /Users/test/store.",
    });

    expect(projected).toEqual({
      status: "disabled",
      retrieval: "unavailable",
      activeRecordCount: 0,
      reason: "Autonomous memory is disabled.",
    });
    expect(JSON.stringify(projected)).not.toContain("/Users/test/store");
  });

  it("projects retrieval capabilities, safe counts, and bounded reasons", () => {
    const projected = projectRetrievalHealth({
      status: "degraded",
      lexical: "ready",
      scalar: "ready",
      vector: "unavailable",
      structural: "ready",
      embeddingCredentials: "missing",
      reason: "missing_embeddings_auth",
      reasons: ["missing_embeddings_auth"],
      details: {
        missing_embeddings_auth: "Bearer token leaked from /tmp/secret",
      },
      fingerprintDisposition: "compatible",
      pendingPublications: 0,
      sourceCount: 4,
      chunkCount: -1,
      relationCount: 2,
      staleSourceCount: Number.NaN,
    });

    expect(projected).toEqual({
      status: "degraded",
      lexical: "ready",
      vector: "unavailable",
      structural: "ready",
      sourceCount: 4,
      chunkCount: 0,
      staleSourceCount: 0,
      reason: "Embedding credentials are unavailable.",
    });
    expect(JSON.stringify(projected)).not.toContain("Bearer token");
  });

  it("uses a safe generic label for future retrieval reasons", () => {
    expect(
      projectRetrievalHealth({
        status: "unavailable",
        lexical: "unavailable",
        scalar: "unavailable",
        vector: "unavailable",
        structural: "unavailable",
        embeddingCredentials: "missing",
        reason: "future_reason" as never,
        reasons: [],
        details: {},
        fingerprintDisposition: "compatible",
        pendingPublications: 0,
        sourceCount: 0,
        chunkCount: 0,
        relationCount: 0,
        staleSourceCount: 0,
      }),
    ).toMatchObject({ reason: "Retrieval reported an error." });
  });

  it.each([
    [false, null, "disabled", "disabled"],
    [true, null, "not_measured", "not_measured"],
    [
      true,
      { state: "discovering" as const, current: 2, total: 8 },
      "working",
      "discovering",
    ],
    [
      true,
      { state: "indexing" as const, current: 3, total: 8 },
      "working",
      "indexing",
    ],
    [
      true,
      {
        state: "idle" as const,
        lastCompleted: { totalFilesInIndex: 4, totalChunksInIndex: 20 },
      },
      "ready",
      "idle",
    ],
    [
      true,
      {
        state: "idle" as const,
        lastCompleted: {
          totalFilesInIndex: 4,
          totalChunksInIndex: 20,
          errorCount: 1,
        },
      },
      "degraded",
      "idle",
    ],
    [
      true,
      {
        state: "error" as const,
        readinessReason: "store_unavailable" as const,
      },
      "unavailable",
      "error",
    ],
  ])("projects index enabled=%s status=%s", (enabled, input, status, state) => {
    expect(projectIndexHealth(input, enabled)).toMatchObject({ status, state });
  });

  it("clamps index counts and does not expose indexer errors", () => {
    expect(
      projectIndexHealth(
        {
          state: "error",
          current: -10,
          total: Number.POSITIVE_INFINITY,
          lastCompleted: {
            totalFilesInIndex: -1,
            totalChunksInIndex: Number.NaN,
          },
        },
        true,
      ),
    ).toEqual({
      status: "unavailable",
      state: "error",
      totalFilesInIndex: 0,
      totalChunksInIndex: 0,
      reason: "Retrieval reported an error.",
    });
  });
});
