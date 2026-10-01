import { describe, expect, it } from "vitest";
import { jsonResult, type ToolResult } from "@agentlink/protocol/tool-result";
import { getSearchUsageMetrics } from "./searchUsageMetrics.js";

function textResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

describe("getSearchUsageMetrics", () => {
  it("derives query mode and bounded successful ranking metadata", () => {
    expect(
      getSearchUsageMetrics(
        { query: "find a symbol" },
        jsonResult({
          ranking: "lexical",
          ranking_reason: "embeddings_disabled",
          total_results: 6,
        }),
      ),
    ).toEqual({
      searchMode: "query",
      searchRanking: "lexical",
      searchRankingReason: "embeddings_disabled",
      searchResultCount: "6-10",
    });
  });

  it("parses JSON text when the actual result payload is not available", () => {
    expect(
      getSearchUsageMetrics(
        { query: "find a symbol" },
        textResult({
          ranking: "keyword_fallback",
          ranking_reason: "missing_index",
          results: [{ path: "a.ts" }],
        }),
      ),
    ).toEqual({
      searchMode: "query",
      searchRanking: "keyword_fallback",
      searchRankingReason: "missing_index",
      searchResultCount: "1",
    });
  });

  it("records known mode but no successful ranking for failed or malformed results", () => {
    expect(
      getSearchUsageMetrics(
        { query: "find a symbol" },
        {
          ...jsonResult({ ranking: "hybrid", total_matches: 1 }),
          isError: true,
        },
      ),
    ).toEqual({ searchMode: "query" });
    expect(
      getSearchUsageMetrics(
        { query: "find a symbol" },
        jsonResult({ ranking: "unknown", total_matches: 1 }),
      ),
    ).toEqual({ searchMode: "query" });
    expect(
      getSearchUsageMetrics(
        { query: "find a symbol" },
        jsonResult({
          ranking: "lexical",
          ranking_reason: "raw provider error",
        }),
      ),
    ).toEqual({ searchMode: "query" });
  });

  it.each(["needle", ""])(
    "records regex counts without a ranked tier (%s)",
    (regex) => {
      expect(
        getSearchUsageMetrics(
          { regex },
          jsonResult({ total_matches: 12, ranking: "hybrid" }),
        ),
      ).toEqual({ searchMode: "regex", searchResultCount: "11-20" });
    },
  );

  it("rejects non-canonical modes and the retired semantic parameter", () => {
    expect(
      getSearchUsageMetrics(
        { regex: "needle", query: "needle" },
        jsonResult({ ranking: "hybrid" }),
      ),
    ).toEqual({});
    expect(
      getSearchUsageMetrics(
        { regex: "needle", semantic: false },
        jsonResult({ total_matches: 1 }),
      ),
    ).toEqual({});
    expect(getSearchUsageMetrics({}, jsonResult({}))).toEqual({});
  });
});
