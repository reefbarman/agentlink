import {
  SESSION_TRANSCRIPT_EXCERPT_MAX_CHARS,
  SESSION_TRANSCRIPT_SEARCH_MAX_CHARS,
  formatSessionTranscriptRecallResult,
  readSessionTranscriptExcerpt,
  searchSessionTranscript,
} from "../core/sessionTranscriptRecall.js";

import type { SessionTranscriptSnapshot } from "../core/sessionTranscriptRecall.js";
import type { ToolResult } from "../shared/types.js";

export async function handleSearchSessionHistory(
  params: Record<string, unknown>,
  getSessionTranscript?: () => SessionTranscriptSnapshot,
  getHandoffSourceTranscript?: () =>
    | Promise<
        | {
            snapshot: SessionTranscriptSnapshot;
            sourceSessionId: string;
            sourceSessionTitle: string;
          }
        | { error: "handoff_source_unavailable" | "handoff_source_too_large" }
      >
    | {
        snapshot: SessionTranscriptSnapshot;
        sourceSessionId: string;
        sourceSessionTitle: string;
      }
    | { error: "handoff_source_unavailable" | "handoff_source_too_large" },
): Promise<ToolResult> {
  if (params.scope !== "handoff_source" && !getSessionTranscript) {
    return textResult(
      formatSessionTranscriptRecallResult(
        { ok: false, ...unavailableResultObject() },
        SESSION_TRANSCRIPT_SEARCH_MAX_CHARS,
      ),
    );
  }
  const source = await resolveTranscriptSource(
    params.scope,
    getSessionTranscript,
    getHandoffSourceTranscript,
  );
  if ("error" in source)
    return textResult(
      formatSessionTranscriptRecallResult(
        { ok: false, ...source },
        SESSION_TRANSCRIPT_SEARCH_MAX_CHARS,
      ),
    );
  const result = searchSessionTranscript(source.snapshot, {
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
      snakeCaseSearchResult(result, source),
      SESSION_TRANSCRIPT_SEARCH_MAX_CHARS,
    ),
  );
}

export async function handleReadSessionExcerpt(
  params: Record<string, unknown>,
  getSessionTranscript?: () => SessionTranscriptSnapshot,
  getHandoffSourceTranscript?: () =>
    | Promise<
        | {
            snapshot: SessionTranscriptSnapshot;
            sourceSessionId: string;
            sourceSessionTitle: string;
          }
        | { error: "handoff_source_unavailable" | "handoff_source_too_large" }
      >
    | {
        snapshot: SessionTranscriptSnapshot;
        sourceSessionId: string;
        sourceSessionTitle: string;
      }
    | { error: "handoff_source_unavailable" | "handoff_source_too_large" },
): Promise<ToolResult> {
  if (params.scope !== "handoff_source" && !getSessionTranscript) {
    return textResult(
      formatSessionTranscriptRecallResult(
        { ok: false, ...unavailableResultObject() },
        SESSION_TRANSCRIPT_EXCERPT_MAX_CHARS,
      ),
    );
  }
  const source = await resolveTranscriptSource(
    params.scope,
    getSessionTranscript,
    getHandoffSourceTranscript,
  );
  if ("error" in source)
    return textResult(
      formatSessionTranscriptRecallResult(
        { ok: false, ...source },
        SESSION_TRANSCRIPT_EXCERPT_MAX_CHARS,
      ),
    );
  if (
    source.scope === "handoff_source" &&
    params.source_session_id !== source.sourceSessionId
  ) {
    return textResult(
      formatSessionTranscriptRecallResult(
        {
          ok: false,
          error: {
            code: "handoff_source_unavailable",
            message:
              "source_session_id must match the direct predecessor returned by search_session_history.",
          },
        },
        SESSION_TRANSCRIPT_EXCERPT_MAX_CHARS,
      ),
    );
  }
  const result = readSessionTranscriptExcerpt(source.snapshot, {
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
      snakeCaseExcerptResult(result, source),
      SESSION_TRANSCRIPT_EXCERPT_MAX_CHARS,
    ),
  );
}

function snakeCaseSearchResult(
  result: ReturnType<typeof searchSessionTranscript>,
  source: ResolvedTranscriptSource,
): unknown {
  if (!result.ok) return result;
  return {
    ok: true,
    snapshot_message_count: result.snapshotMessageCount,
    snapshot_revision: result.snapshotRevision,
    scope: source.scope,
    ...(source.scope === "handoff_source"
      ? {
          source_session_id: source.sourceSessionId,
          source_session_title: source.sourceSessionTitle,
        }
      : {}),
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
  source: ResolvedTranscriptSource,
): unknown {
  if (!result.ok) return result;
  return {
    ok: true,
    snapshot_message_count: result.snapshotMessageCount,
    snapshot_revision: result.snapshotRevision,
    scope: source.scope,
    ...(source.scope === "handoff_source"
      ? {
          source_session_id: source.sourceSessionId,
          source_session_title: source.sourceSessionTitle,
        }
      : {}),
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

type ResolvedTranscriptSource =
  | { scope: "current"; snapshot: SessionTranscriptSnapshot }
  | {
      scope: "handoff_source";
      snapshot: SessionTranscriptSnapshot;
      sourceSessionId: string;
      sourceSessionTitle: string;
    };

async function resolveTranscriptSource(
  rawScope: unknown,
  getSessionTranscript: (() => SessionTranscriptSnapshot) | undefined,
  getHandoffSourceTranscript:
    | (() =>
        | Promise<
            | {
                snapshot: SessionTranscriptSnapshot;
                sourceSessionId: string;
                sourceSessionTitle: string;
              }
            | {
                error:
                  | "handoff_source_unavailable"
                  | "handoff_source_too_large";
              }
          >
        | {
            snapshot: SessionTranscriptSnapshot;
            sourceSessionId: string;
            sourceSessionTitle: string;
          }
        | { error: "handoff_source_unavailable" | "handoff_source_too_large" })
    | undefined,
): Promise<
  ResolvedTranscriptSource | { error: { code: string; message: string } }
> {
  if (rawScope !== "handoff_source") {
    if (!getSessionTranscript) return unavailableResultObject();
    return { scope: "current", snapshot: getSessionTranscript() };
  }
  if (!getHandoffSourceTranscript) {
    return handoffSourceError("handoff_source_unavailable");
  }
  const result = await getHandoffSourceTranscript();
  if ("error" in result) return handoffSourceError(result.error);
  return { scope: "handoff_source", ...result };
}

function handoffSourceError(
  code: "handoff_source_unavailable" | "handoff_source_too_large",
): { error: { code: string; message: string } } {
  return {
    error: {
      code,
      message:
        code === "handoff_source_too_large"
          ? "The linked predecessor transcript is too large to load safely."
          : "The linked predecessor session is unavailable.",
    },
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

function unavailableResultObject(): {
  error: { code: string; message: string };
} {
  return {
    error: {
      code: "session_transcript_unavailable",
      message:
        "Current-session transcript recall is unavailable in this runtime.",
    },
  };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
