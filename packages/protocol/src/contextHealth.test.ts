import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  RetrievalHealthReason,
  RetrievalHealthSnapshot,
} from "./retrievalHealth.js";
import {
  INITIAL_CONTEXT_HEALTH,
  projectEmbeddingHealth,
  projectIndexHealth,
  projectMemoryHealth,
  projectRetrievalHealth,
  type ContextHealthSnapshot,
  type ContextIndexHealthInput,
  type ContextMemoryHealthInput,
  type ContextRetrievalHealthInput,
} from "./contextHealth.js";

describe("context health protocol", () => {
  it("keeps projection inputs and snapshots browser-safe and structural", () => {
    expectTypeOf<ContextMemoryHealthInput["retrieval"]>().toEqualTypeOf<
      "lexical-only" | "hybrid" | "unavailable"
    >();
    expectTypeOf<ContextRetrievalHealthInput>().toEqualTypeOf<RetrievalHealthSnapshot>();
    expectTypeOf<ContextRetrievalHealthInput["reason"]>().toEqualTypeOf<
      RetrievalHealthReason | undefined
    >();
    expectTypeOf<ContextRetrievalHealthInput["vector"]>().toEqualTypeOf<
      "ready" | "unavailable" | "not_configured"
    >();
    expectTypeOf<ContextIndexHealthInput["state"]>().toEqualTypeOf<
      "idle" | "discovering" | "indexing" | "error"
    >();
    expectTypeOf<ContextHealthSnapshot>().toHaveProperty("memory");
    expectTypeOf<ContextHealthSnapshot>().toHaveProperty("retrieval");
    expectTypeOf<ContextHealthSnapshot>().toHaveProperty("index");
    expect(INITIAL_CONTEXT_HEALTH).toMatchObject({
      memory: { status: "not_measured" },
      retrieval: { status: "not_measured" },
      index: { status: "not_measured" },
    });
  });

  it.each([
    [{ enabled: false, credentials: "unknown" }, undefined, "disabled"],
    [{ enabled: true, credentials: "missing" }, [10, 10, 0], "unavailable"],
    [{ enabled: true, credentials: "unknown" }, [10, 10, 0], "not_measured"],
    [{ enabled: true, credentials: "available" }, undefined, "not_measured"],
    [{ enabled: true, credentials: "available" }, [10, 0, 0], "unavailable"],
    [{ enabled: true, credentials: "available" }, [10, 4, 0], "degraded"],
    [{ enabled: true, credentials: "available" }, [10, 4, 6], "not_measured"],
    [{ enabled: true, credentials: "available" }, [10, 10, 0], "ready"],
  ] as const)(
    "projects embedding health %o %o as %s",
    (config, counts, status) => {
      const health = projectEmbeddingHealth(config, {
        state: "idle",
        ...(counts
          ? {
              lastCompleted: {
                totalFilesInIndex: 1,
                totalChunksInIndex: counts[0],
                embeddedChunksInIndex: counts[1],
                unmeasuredChunksInIndex: counts[2],
              },
            }
          : {}),
      });
      expect(health).toMatchObject({ status, enabled: config.enabled });
      expect(Boolean(health.reason)).toBe(status !== "ready");
    },
  );

  it("does not show the previous run's embedding counts while indexing", () => {
    expect(
      projectEmbeddingHealth(
        { enabled: true, credentials: "available" },
        {
          state: "indexing",
          lastCompleted: {
            totalFilesInIndex: 1,
            totalChunksInIndex: 10,
            embeddedChunksInIndex: 0,
          },
        },
      ),
    ).toEqual({
      status: "working",
      enabled: true,
      reason: "Coverage updates when indexing finishes.",
    });
  });

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
