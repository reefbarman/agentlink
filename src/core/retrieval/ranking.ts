import type {
  RetrievalCandidateScores,
  RetrievalQuery,
  RetrievalQueryCandidate,
  RetrievalQueryResult,
} from "@agentlink/protocol/retrieval-query";
import type {
  RetrievalChunkRecord,
  RetrievalSourceDocument,
} from "@agentlink/protocol/retrieval-records";

export interface RetrievalRankingWeights {
  exact: number;
  lexical: number;
  vector: number;
  path: number;
  source: number;
  recency: number;
}

const DEFAULT_RANKING_BY_MODE: Record<
  RetrievalQueryResult["mode"],
  RetrievalRankingWeights
> = {
  lexical: {
    exact: 0.35,
    lexical: 0.45,
    vector: 0,
    path: 0.15,
    source: 0.05,
    recency: 0,
  },
  vector: {
    exact: 0,
    lexical: 0,
    vector: 1,
    path: 0,
    source: 0,
    recency: 0,
  },
  hybrid: {
    exact: 0.25,
    lexical: 0.35,
    vector: 0.25,
    path: 0.1,
    source: 0.05,
    recency: 0,
  },
};

export function resolveRetrievalRankingWeights(
  mode: RetrievalQueryResult["mode"],
  input: RetrievalQuery["ranking"],
): RetrievalRankingWeights {
  const defaults = DEFAULT_RANKING_BY_MODE[mode];
  const weights: RetrievalRankingWeights = {
    exact: input?.exact ?? defaults.exact,
    lexical: input?.lexical ?? defaults.lexical,
    vector: input?.vector ?? defaults.vector,
    path: input?.path ?? defaults.path,
    source: input?.source ?? defaults.source,
    recency: input?.recency ?? defaults.recency,
  };
  const values = Object.values(weights);
  if (values.some((weight) => !Number.isFinite(weight) || weight < 0)) {
    throw new Error(
      "Retrieval ranking weights must be finite and non-negative",
    );
  }
  const total = values.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) {
    throw new Error("Retrieval ranking requires at least one positive weight");
  }
  return Object.fromEntries(
    Object.entries(weights).map(([key, weight]) => [key, weight / total]),
  ) as unknown as RetrievalRankingWeights;
}

export function scoreRetrievalCandidate(
  query: RetrievalQuery,
  mode: RetrievalQueryResult["mode"],
  source: RetrievalSourceDocument,
  chunk: RetrievalChunkRecord,
  weights: RetrievalRankingWeights,
): RetrievalCandidateScores {
  const queryTerms = tokenize(query.text);
  const normalizedQuery = normalizeValue(query.text);
  const path = normalizePath(chunk.location?.path ?? source.path ?? "");
  const basename = path.split("/").at(-1) ?? "";
  const metadataValues = ["symbolName", "conflictKey"]
    .map((key) => source.metadata[key] ?? chunk.metadata[key])
    .filter((value): value is string => typeof value === "string");
  const sourceText = [
    source.id,
    source.title ?? "",
    path,
    basename,
    ...metadataValues,
  ]
    .join(" ")
    .toLowerCase();
  const chunkText = `${source.title ?? ""} ${chunk.content}`.toLowerCase();
  const exactValues = [
    source.id,
    source.title ?? "",
    path,
    basename,
    ...metadataValues,
  ]
    .map(normalizeValue)
    .filter(Boolean);
  const exactPathValues = [path, basename].map(normalizeValue).filter(Boolean);
  const exact =
    normalizedQuery &&
    (chunkText.includes(normalizedQuery) ||
      exactValues.includes(normalizedQuery))
      ? 1
      : 0;
  const lexical = termOverlap(queryTerms, tokenize(chunkText));
  const vector =
    mode !== "lexical" && query.embedding && chunk.embedding
      ? cosineSimilarity(query.embedding, chunk.embedding)
      : 0;
  const pathScore = exactPathValues.includes(normalizedQuery)
    ? 1
    : termOverlap(queryTerms, tokenize(path));
  const sourceScore = termOverlap(queryTerms, tokenize(sourceText));
  const recency = 0;
  const final =
    exact * weights.exact +
    lexical * weights.lexical +
    vector * weights.vector +
    pathScore * weights.path +
    sourceScore * weights.source +
    recency * weights.recency;
  return {
    exact,
    lexical,
    vector,
    path: pathScore,
    source: sourceScore,
    recency,
    final,
  };
}

export function hasRetrievalSignal(
  scores: RetrievalCandidateScores,
  mode: RetrievalQueryResult["mode"],
): boolean {
  if (mode === "vector") return scores.vector > 0;
  if (mode === "lexical") {
    return (
      scores.exact > 0 ||
      scores.lexical > 0 ||
      scores.path > 0 ||
      scores.source > 0
    );
  }
  return (
    scores.exact > 0 ||
    scores.lexical > 0 ||
    scores.vector > 0 ||
    scores.path > 0 ||
    scores.source > 0
  );
}

export function compareRetrievalCandidates(
  left: RetrievalQueryCandidate,
  right: RetrievalQueryCandidate,
): number {
  for (const key of [
    "final",
    "exact",
    "lexical",
    "path",
    "source",
    "vector",
    "recency",
  ] as const) {
    const difference = right.scores[key] - left.scores[key];
    if (difference !== 0) return difference;
  }
  return (
    compareText(left.source.id, right.source.id) ||
    compareText(candidatePath(left), candidatePath(right)) ||
    compareOptionalNumber(
      left.chunk.location?.startLine,
      right.chunk.location?.startLine,
    ) ||
    compareOptionalNumber(
      left.chunk.location?.endLine,
      right.chunk.location?.endLine,
    ) ||
    compareText(left.chunk.id, right.chunk.id)
  );
}

export function diversifyRetrievalCandidates(
  candidates: RetrievalQueryCandidate[],
  query: RetrievalQuery,
): RetrievalQueryCandidate[] {
  const maxPerSource = query.diversity?.maxPerSource ?? 2;
  if (!Number.isInteger(maxPerSource) || maxPerSource <= 0) {
    throw new Error(
      "Retrieval diversity maxPerSource must be a positive integer",
    );
  }
  const collapseOverlaps = query.diversity?.collapseOverlaps ?? true;
  const selected: RetrievalQueryCandidate[] = [];
  const sourceCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if ((sourceCounts.get(candidate.source.id) ?? 0) >= maxPerSource) continue;
    if (
      collapseOverlaps &&
      selected.some((existing) => candidatesOverlap(existing, candidate))
    ) {
      continue;
    }
    selected.push(candidate);
    sourceCounts.set(
      candidate.source.id,
      (sourceCounts.get(candidate.source.id) ?? 0) + 1,
    );
    if (selected.length === query.limit) break;
  }
  return selected;
}

export function normalizeRetrievalPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function candidatesOverlap(
  left: RetrievalQueryCandidate,
  right: RetrievalQueryCandidate,
): boolean {
  if (
    left.source.id !== right.source.id ||
    candidatePath(left) !== candidatePath(right)
  ) {
    return false;
  }
  const leftStart = left.chunk.location?.startLine;
  const leftEnd = left.chunk.location?.endLine;
  const rightStart = right.chunk.location?.startLine;
  const rightEnd = right.chunk.location?.endLine;
  if (
    leftStart === undefined ||
    leftEnd === undefined ||
    rightStart === undefined ||
    rightEnd === undefined
  ) {
    return false;
  }
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function candidatePath(candidate: RetrievalQueryCandidate): string {
  return normalizeRetrievalPath(
    candidate.chunk.location?.path ?? candidate.source.path ?? "",
  );
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9_]+/g) ?? [])];
}

function termOverlap(queryTerms: string[], candidateTerms: string[]): number {
  if (queryTerms.length === 0) return 0;
  const candidate = new Set(candidateTerms);
  return (
    queryTerms.filter((term) => candidate.has(term)).length / queryTerms.length
  );
}

function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return Math.max(0, dot / Math.sqrt(leftNorm * rightNorm));
}

function normalizeValue(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePath(value: string): string {
  return normalizeRetrievalPath(value).toLowerCase();
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareOptionalNumber(left?: number, right?: number): number {
  return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER);
}
