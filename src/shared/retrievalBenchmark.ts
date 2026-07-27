export interface RankedRetrievalEvaluationInput {
  expectedRelevant: readonly string[];
  rankedIds: readonly string[];
  forbiddenIds?: readonly string[];
  k?: number;
  sourceForId?: (id: string) => string;
}

export interface RankedRetrievalMetrics {
  k: number;
  recallAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
  sourceDiversity: number;
  forbiddenReturned: string[];
}

export function evaluateRankedRetrieval(
  input: RankedRetrievalEvaluationInput,
): RankedRetrievalMetrics {
  const k = Math.max(1, Math.floor(input.k ?? 10));
  const expected = new Set(input.expectedRelevant);
  const ranked = input.rankedIds.slice(0, k);
  const seenRelevant = new Set<string>();
  const relevantRanks = ranked.flatMap((id, index) => {
    if (!expected.has(id) || seenRelevant.has(id)) return [];
    seenRelevant.add(id);
    return [index + 1];
  });
  const relevantReturned = seenRelevant.size;
  const idealRelevantCount = Math.min(expected.size, k);
  const dcg = relevantRanks.reduce(
    (sum, rank) => sum + 1 / Math.log2(rank + 1),
    0,
  );
  const idealDcg = Array.from(
    { length: idealRelevantCount },
    (_, index) => 1 / Math.log2(index + 2),
  ).reduce((sum, gain) => sum + gain, 0);
  const sourceForId =
    input.sourceForId ?? ((id: string) => id.split(":", 1)[0]!);
  const forbidden = new Set(input.forbiddenIds ?? []);

  return {
    k,
    recallAtK: expected.size === 0 ? 1 : relevantReturned / expected.size,
    reciprocalRank: relevantRanks.length > 0 ? 1 / relevantRanks[0]! : 0,
    ndcgAtK: idealDcg > 0 ? dcg / idealDcg : 1,
    sourceDiversity: new Set(ranked.map(sourceForId)).size,
    forbiddenReturned: ranked.filter((id) => forbidden.has(id)),
  };
}
