import type { RetrievalQuery, RetrievalQueryCandidate } from "./contracts.js";
import {
  compareRetrievalCandidates,
  diversifyRetrievalCandidates,
  resolveRetrievalRankingWeights,
  scoreRetrievalCandidate,
} from "./ranking.js";
import { describe, expect, it } from "vitest";

function candidate(options: {
  id: string;
  sourceId: string;
  path: string;
  startLine: number;
  endLine: number;
  final: number;
  exact?: number;
}): RetrievalQueryCandidate {
  return {
    source: {
      id: options.sourceId,
      namespace: "code",
      kind: "file",
      revision: {
        id: `revision:${options.sourceId}`,
        contentHash: `hash:${options.sourceId}`,
        observedAt: "2026-07-25T00:00:00.000Z",
      },
      path: options.path,
      content: options.path,
      metadata: {},
    },
    chunk: {
      id: options.id,
      sourceId: options.sourceId,
      revisionId: `revision:${options.sourceId}`,
      generation: `generation:${options.sourceId}`,
      content: options.id,
      embedding: null,
      location: {
        path: options.path,
        startLine: options.startLine,
        endLine: options.endLine,
      },
      metadata: {},
    },
    scores: {
      exact: options.exact ?? 0,
      lexical: 0,
      vector: 0,
      path: 0,
      source: 0,
      recency: 0,
      final: options.final,
    },
  };
}

const query: RetrievalQuery = {
  text: "retrieval",
  mode: "lexical",
  limit: 3,
};

describe("retrieval ranking policy", () => {
  it("validates and normalizes ranking weights", () => {
    expect(
      resolveRetrievalRankingWeights("lexical", {
        exact: 2,
        lexical: 1,
        path: 1,
        source: 0,
        vector: 0,
        recency: 0,
      }),
    ).toEqual({
      exact: 0.5,
      lexical: 0.25,
      vector: 0,
      path: 0.25,
      source: 0,
      recency: 0,
    });
    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        resolveRetrievalRankingWeights("lexical", { exact: invalid }),
      ).toThrow("finite and non-negative");
    }
    expect(() =>
      resolveRetrievalRankingWeights("lexical", {
        exact: 0,
        lexical: 0,
        vector: 0,
        path: 0,
        source: 0,
        recency: 0,
      }),
    ).toThrow("at least one positive weight");
  });

  it("scores an exact full path independently of optional title fields", () => {
    const entry = candidate({
      id: "chunk:path",
      sourceId: "source:path",
      path: "src/services/SearchService.ts",
      startLine: 1,
      endLine: 5,
      final: 0,
    });
    const weights = resolveRetrievalRankingWeights("lexical", undefined);
    const scores = scoreRetrievalCandidate(
      {
        text: "src/services/SearchService.ts",
        mode: "lexical",
        limit: 10,
      },
      "lexical",
      entry.source,
      entry.chunk,
      weights,
    );

    expect(entry.source.title).toBeUndefined();
    expect(scores.path).toBe(1);
  });

  it("uses deterministic score and identity tie-breaks", () => {
    const exact = candidate({
      id: "chunk:z",
      sourceId: "source:z",
      path: "z.ts",
      startLine: 1,
      endLine: 1,
      final: 1,
      exact: 1,
    });
    const notExact = candidate({
      id: "chunk:a",
      sourceId: "source:a",
      path: "a.ts",
      startLine: 1,
      endLine: 1,
      final: 1,
    });
    expect([notExact, exact].sort(compareRetrievalCandidates)).toEqual([
      exact,
      notExact,
    ]);

    const sourceA = candidate({
      id: "chunk:z",
      sourceId: "source:a",
      path: "a.ts",
      startLine: 1,
      endLine: 1,
      final: 1,
    });
    const sourceB = candidate({
      id: "chunk:a",
      sourceId: "source:b",
      path: "b.ts",
      startLine: 1,
      endLine: 1,
      final: 1,
    });
    expect([sourceB, sourceA].sort(compareRetrievalCandidates)).toEqual([
      sourceA,
      sourceB,
    ]);
  });

  it("collapses overlaps, caps repeated sources, and backfills", () => {
    const ranked = [
      candidate({
        id: "source-a-best",
        sourceId: "source:a",
        path: "src/a.ts",
        startLine: 1,
        endLine: 10,
        final: 1,
      }),
      candidate({
        id: "source-a-overlap",
        sourceId: "source:a",
        path: "src/a.ts",
        startLine: 5,
        endLine: 15,
        final: 0.9,
      }),
      candidate({
        id: "source-a-second",
        sourceId: "source:a",
        path: "src/a.ts",
        startLine: 20,
        endLine: 25,
        final: 0.8,
      }),
      candidate({
        id: "source-a-over-cap",
        sourceId: "source:a",
        path: "src/a.ts",
        startLine: 30,
        endLine: 35,
        final: 0.7,
      }),
      candidate({
        id: "source-b-backfill",
        sourceId: "source:b",
        path: "src/b.ts",
        startLine: 1,
        endLine: 5,
        final: 0.6,
      }),
    ];

    expect(
      diversifyRetrievalCandidates(ranked, query).map(
        (entry) => entry.chunk.id,
      ),
    ).toEqual(["source-a-best", "source-a-second", "source-b-backfill"]);
  });

  it("validates source diversity bounds", () => {
    expect(() =>
      diversifyRetrievalCandidates([], {
        ...query,
        diversity: { maxPerSource: 0 },
      }),
    ).toThrow("positive integer");
  });
});
