import type { ToolResult } from "@agentlink/protocol/tool-result";

const SEARCH_RANKINGS = new Set(["hybrid", "lexical", "keyword_fallback"]);
const SEARCH_RANKING_REASONS = new Set([
  "embeddings_disabled",
  "embedding_auth_missing",
  "embedding_http_1xx",
  "embedding_http_2xx",
  "embedding_http_3xx",
  "embedding_http_4xx",
  "embedding_http_5xx",
  "embedding_network",
  "vector_index_unavailable",
  "missing_index",
  "store_unavailable",
  "repair_required",
  "rebuild_required",
  "lexical_index_unavailable",
  "scalar_index_unavailable",
  "unknown",
]);

export function getSearchUsageMetrics(
  input: Record<string, unknown>,
  result: ToolResult,
): Record<string, string | number> {
  const hasRegex = Object.hasOwn(input, "regex");
  const hasQuery = Object.hasOwn(input, "query");
  if (
    Object.hasOwn(input, "semantic") ||
    hasRegex === hasQuery ||
    (hasRegex && typeof input.regex !== "string") ||
    (hasQuery &&
      (typeof input.query !== "string" || input.query.trim().length === 0))
  ) {
    return {};
  }

  const metrics: Record<string, string | number> = {
    searchMode: hasRegex ? "regex" : "query",
  };
  if (result.isError) return metrics;

  const payload = getPayload(result);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return metrics;
  }

  const record = payload as Record<string, unknown>;
  if (hasRegex) {
    const count = getResultCount(record);
    if (count !== undefined)
      metrics.searchResultCount = resultCountBucket(count);
    return metrics;
  }

  const ranking = record.ranking;
  if (typeof ranking !== "string" || !SEARCH_RANKINGS.has(ranking)) {
    return metrics;
  }

  const reason = record.ranking_reason;
  if (
    (ranking === "hybrid" && reason !== undefined) ||
    (ranking !== "hybrid" &&
      (typeof reason !== "string" || !SEARCH_RANKING_REASONS.has(reason)))
  ) {
    return metrics;
  }

  metrics.searchRanking = ranking;
  if (typeof reason === "string") metrics.searchRankingReason = reason;

  const count = getResultCount(record);
  if (count !== undefined) metrics.searchResultCount = resultCountBucket(count);
  return metrics;
}

function getPayload(result: ToolResult): unknown {
  if (result.data !== undefined) return result.data;
  for (const content of result.content) {
    if (content.type !== "text") continue;
    try {
      return JSON.parse(content.text) as unknown;
    } catch {
      continue;
    }
  }
  return undefined;
}

function getResultCount(payload: Record<string, unknown>): number | undefined {
  if (
    typeof payload.total_results === "number" &&
    Number.isFinite(payload.total_results) &&
    payload.total_results >= 0
  ) {
    return Math.floor(payload.total_results);
  }
  if (
    typeof payload.total_matches === "number" &&
    Number.isFinite(payload.total_matches) &&
    payload.total_matches >= 0
  ) {
    return Math.floor(payload.total_matches);
  }
  if (Array.isArray(payload.results)) return payload.results.length;
  if (Array.isArray(payload.counts)) return payload.counts.length;
  return undefined;
}

function resultCountBucket(count: number): string {
  if (count === 0) return "0";
  if (count === 1) return "1";
  if (count <= 5) return "2-5";
  if (count <= 10) return "6-10";
  if (count <= 20) return "11-20";
  return "21+";
}
