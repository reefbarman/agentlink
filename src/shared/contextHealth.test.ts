import { describe, expect, expectTypeOf, it } from "vitest";

import {
  INITIAL_CONTEXT_HEALTH,
  projectIndexHealth,
  projectMemoryHealth,
  projectRetrievalHealth,
  type ContextHealthSnapshot,
  type ContextMemoryHealthInput,
} from "./contextHealth.js";

describe("context health protocol compatibility shim", () => {
  it("preserves the legacy projection types and behavior", () => {
    expectTypeOf<ContextHealthSnapshot>().toHaveProperty("memory");
    expectTypeOf<ContextMemoryHealthInput["retrieval"]>().toEqualTypeOf<
      "lexical-only" | "hybrid" | "unavailable"
    >();
    expect(INITIAL_CONTEXT_HEALTH.memory.status).toBe("not_measured");
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
    expect(
      projectRetrievalHealth({
        status: "degraded",
        lexical: "ready",
        scalar: "ready",
        vector: "unavailable",
        structural: "ready",
        embeddingCredentials: "missing",
        reason: "missing_embeddings_auth",
        reasons: ["missing_embeddings_auth"],
        fingerprintDisposition: "compatible",
        pendingPublications: 0,
        sourceCount: 4,
        chunkCount: -1,
        relationCount: 2,
        staleSourceCount: Number.NaN,
      }),
    ).toMatchObject({
      status: "degraded",
      reason: "Embedding credentials are unavailable.",
      chunkCount: 0,
    });
    expect(projectIndexHealth(null, false)).toEqual({
      status: "disabled",
      state: "disabled",
      reason: "Semantic indexing is disabled.",
    });
  });
});
