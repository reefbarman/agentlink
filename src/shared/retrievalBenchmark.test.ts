import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateRankedRetrieval } from "./retrievalBenchmark.js";

type RetrievalFixtures = {
  fixtureRevision: string;
  queries: Array<{
    id: string;
    expectedRelevant: string[];
    forbidden: string[];
  }>;
};

type CurrentBaseline = {
  fixtureRevision: string;
  codeRetrieval: {
    capturedQueries: Array<{ queryId: string; rankedPaths: string[] }>;
    rawSimilarityScoresCommitted: boolean;
  };
};

const fixtureRoot = path.resolve(
  __dirname,
  "..",
  "..",
  "fixtures",
  "unified-context-baselines",
  "v1",
);

function readJson<T>(name: string): T {
  return JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, name), "utf-8"),
  ) as T;
}

describe("retrievalBenchmark", () => {
  it("computes ranked relevance metrics without backend scores", () => {
    expect(
      evaluateRankedRetrieval({
        expectedRelevant: ["a", "b", "c"],
        rankedIds: ["x", "b", "a", "forbidden"],
        forbiddenIds: ["forbidden"],
        k: 4,
      }),
    ).toEqual({
      k: 4,
      recallAtK: 2 / 3,
      reciprocalRank: 1 / 2,
      ndcgAtK: expect.closeTo(1.1309297535714575 / 2.1309297535714578),
      sourceDiversity: 4,
      forbiddenReturned: ["forbidden"],
    });
  });

  it("does not award duplicate relevant results more than once", () => {
    expect(
      evaluateRankedRetrieval({
        expectedRelevant: ["a"],
        rankedIds: ["a", "a", "a"],
        k: 3,
      }),
    ).toMatchObject({
      recallAtK: 1,
      reciprocalRank: 1,
      ndcgAtK: 1,
    });
  });

  it("replays the committed Qdrant ranked baseline against canonical labels", () => {
    const fixtures = readJson<RetrievalFixtures>("retrieval-fixtures.json");
    const baseline = readJson<CurrentBaseline>("current-baseline.json");
    expect(baseline.fixtureRevision).toBe(fixtures.fixtureRevision);
    expect(baseline.codeRetrieval.rawSimilarityScoresCommitted).toBe(false);

    for (const captured of baseline.codeRetrieval.capturedQueries) {
      const fixture = fixtures.queries.find(
        (query) => query.id === captured.queryId,
      );
      expect(fixture, captured.queryId).toBeDefined();
      const metrics = evaluateRankedRetrieval({
        expectedRelevant: fixture!.expectedRelevant,
        forbiddenIds: fixture!.forbidden,
        rankedIds: captured.rankedPaths,
        k: 10,
        sourceForId: (id) => path.dirname(id),
      });
      expect(metrics.recallAtK, captured.queryId).toBe(1);
      expect(metrics.forbiddenReturned, captured.queryId).toEqual([]);
      expect(metrics.sourceDiversity, captured.queryId).toBeGreaterThan(0);
    }
  });
});
