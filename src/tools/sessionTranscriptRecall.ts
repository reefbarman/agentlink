import {
  SESSION_TRANSCRIPT_EXCERPT_MAX_CHARS,
  SESSION_TRANSCRIPT_SEARCH_MAX_CHARS,
  formatSessionTranscriptRecallResult,
  readSessionTranscriptExcerpt,
  searchSessionTranscript,
} from "../core/sessionTranscriptRecall.js";

import type { SessionTranscriptSnapshot } from "../core/sessionTranscriptRecall.js";
import type { ToolResult } from "../shared/types.js";

export function handleSearchSessionHistory(
  params: Record<string, unknown>,
  getSessionTranscript?: () => SessionTranscriptSnapshot,
): ToolResult {
  if (!getSessionTranscript) return unavailableResult();
  const result = searchSessionTranscript(getSessionTranscript(), {
    query: typeof params.query === "string" ? params.query : "",
    mode: params.mode === "regex" ? "regex" : "terms",
    limit: numberValue(params.limit),
    role:
      params.role === "user" || params.role === "assistant"
        ? params.role
        : undefined,
    toolName:
      typeof params.tool_name === "string" ? params.tool_name : undefined,
  });
  return textResult(
    formatSessionTranscriptRecallResult(
      snakeCaseSearchResult(result),
      SESSION_TRANSCRIPT_SEARCH_MAX_CHARS,
    ),
  );
}

export function handleReadSessionExcerpt(
  params: Record<string, unknown>,
  getSessionTranscript?: () => SessionTranscriptSnapshot,
): ToolResult {
  if (!getSessionTranscript) return unavailableResult();
  const result = readSessionTranscriptExcerpt(getSessionTranscript(), {
    startMessageIndex: numberValue(params.start_message_index) ?? Number.NaN,
    endMessageIndex: numberValue(params.end_message_index) ?? Number.NaN,
    snapshotMessageCount:
      numberValue(params.snapshot_message_count) ?? Number.NaN,
    snapshotRevision:
      typeof params.snapshot_revision === "string"
        ? params.snapshot_revision
        : "",
  });
  return textResult(
    formatSessionTranscriptRecallResult(
      snakeCaseExcerptResult(result),
      SESSION_TRANSCRIPT_EXCERPT_MAX_CHARS,
    ),
  );
}

function snakeCaseSearchResult(
  result: ReturnType<typeof searchSessionTranscript>,
): unknown {
  if (!result.ok) return result;
  return {
    ok: true,
    snapshot_message_count: result.snapshotMessageCount,
    snapshot_revision: result.snapshotRevision,
    total_matches: result.totalMatches,
    truncated: result.truncated,
    hits: result.hits.map((hit) => ({
      message_index: hit.messageIndex,
      role: hit.role,
      tool_names: hit.toolNames,
      condensed: hit.condensed,
      excerpt: hit.excerpt,
      occurrence_count: hit.occurrenceCount,
      truncated: hit.truncated,
    })),
  };
}

function snakeCaseExcerptResult(
  result: ReturnType<typeof readSessionTranscriptExcerpt>,
): unknown {
  if (!result.ok) return result;
  return {
    ok: true,
    snapshot_message_count: result.snapshotMessageCount,
    snapshot_revision: result.snapshotRevision,
    start_message_index: result.startMessageIndex,
    end_message_index: result.endMessageIndex,
    truncated: result.truncated,
    messages: result.messages.map((message) => ({
      message_index: message.messageIndex,
      role: message.role,
      tool_names: message.toolNames,
      condensed: message.condensed,
      content: message.content,
      truncated: message.truncated,
    })),
  };
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function unavailableResult(): ToolResult {
  return textResult(
    JSON.stringify({
      ok: false,
      error: {
        code: "session_transcript_unavailable",
        message:
          "Current-session transcript recall is unavailable in this runtime.",
      },
    }),
  );
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
