import {
  FeedbackLookupError,
  readFeedback,
  readFeedbackContent,
  type FeedbackFullContent,
  type FeedbackPriority,
  type FeedbackRecord,
} from "../util/feedbackStore.js";

import type { ToolResult } from "@agentlink/protocol/tool-result";

export const FEEDBACK_PAGE_DEFAULT_CHARS = 4_000;
export const FEEDBACK_PAGE_MAX_CHARS = 8_000;
export const FEEDBACK_RESPONSE_MAX_BYTES = 16 * 1024;

export interface GetFeedbackParams {
  tool_name?: string;
  triaged?: boolean;
  priorities?: FeedbackPriority[];
  id?: string;
  offset?: number;
  limit?: number;
}

function json(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function rejected(error: string): ToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify({ status: "rejected", error }) },
    ],
  };
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), "utf-8");
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Never ends a page between the halves of a surrogate pair. */
function safePageEnd(text: string, offset: number, end: number): number {
  if (end >= text.length) return text.length;
  if (!isHighSurrogate(text.charCodeAt(end - 1))) return end;
  return end - 1 > offset ? end - 1 : end + 1;
}

function withRetrievalHint(entry: FeedbackRecord): FeedbackRecord & {
  full_record?: unknown;
} {
  if (entry.content_status !== "preview") return entry;
  return {
    ...entry,
    full_record: {
      tool: "get_feedback",
      input: { id: entry.id },
      note: "This entry is a preview; some fields were shortened or omitted. Read the complete report by ID.",
    },
  };
}

function recordMetadata(full: FeedbackFullContent) {
  const { record } = full;
  return {
    id: record.id,
    global_index: record.global_index,
    triaged: record.triaged,
    priority: record.priority,
    triaged_at: record.triaged_at,
    content_status: full.content_status,
    content_bytes: full.bytes,
    content_sha256: full.sha256,
  };
}

function lookupError(error: FeedbackLookupError): ToolResult {
  return json({
    status: "error",
    code: error.code,
    error: error.message,
    ...(error.record
      ? {
          // Retained preview, explicitly labelled partial; never presented as full content.
          partial_preview: error.record,
          partial: true,
        }
      : {}),
  });
}

function pageResult(
  full: FeedbackFullContent,
  offset: number,
  limit: number,
): ToolResult {
  const text = full.content_json;
  if (offset >= text.length) {
    return rejected(
      `offset ${offset} is out of range; the record has ${text.length} UTF-16 characters`,
    );
  }
  if (
    offset > 0 &&
    isLowSurrogate(text.charCodeAt(offset)) &&
    isHighSurrogate(text.charCodeAt(offset - 1))
  ) {
    return rejected(
      `offset ${offset} splits a surrogate pair; use an offset returned by get_feedback`,
    );
  }
  const render = (end: number) => {
    const final = end >= text.length;
    return {
      status: "success",
      mode: "page",
      ...recordMetadata(full),
      total_length: text.length,
      offset,
      next_offset: final ? null : end,
      final_page: final,
      record_json: text.slice(offset, end),
      ...(final
        ? {}
        : {
            next_request: {
              tool: "get_feedback",
              input: { id: full.record.id, offset: end, limit },
            },
          }),
    };
  };
  let end = safePageEnd(text, offset, Math.min(text.length, offset + limit));
  let page = render(end);
  // Highly escaped content can exceed the response bound; shrink without losing text.
  while (bytesOf(page) > FEEDBACK_RESPONSE_MAX_BYTES) {
    const span = end - offset;
    const next = safePageEnd(text, offset, offset + Math.floor(span / 2));
    if (next >= end || next <= offset) break;
    end = next;
    page = render(end);
  }
  return json(page);
}

export async function handleGetFeedback(
  params: GetFeedbackParams,
): Promise<ToolResult> {
  try {
    if (params.id === undefined) {
      if (params.offset !== undefined || params.limit !== undefined) {
        return rejected("offset and limit require id");
      }
      const entries = readFeedback({
        tool_name: params.tool_name,
        triaged: params.triaged,
        priorities: params.priorities,
      }).map(withRetrievalHint);
      return json({ status: "success", count: entries.length, entries });
    }

    if (
      params.tool_name !== undefined ||
      params.triaged !== undefined ||
      params.priorities !== undefined
    ) {
      return rejected(
        "id retrieves one exact report and cannot be combined with tool_name, triaged or priorities",
      );
    }
    if (typeof params.id !== "string" || !params.id.trim()) {
      return rejected("id must be a non-empty stable feedback ID");
    }
    if (
      params.offset !== undefined &&
      (!Number.isSafeInteger(params.offset) || params.offset < 0)
    ) {
      return rejected("offset must be a non-negative integer");
    }
    if (
      params.limit !== undefined &&
      (!Number.isSafeInteger(params.limit) ||
        params.limit < 1 ||
        params.limit > FEEDBACK_PAGE_MAX_CHARS)
    ) {
      return rejected(
        `limit must be an integer from 1 to ${FEEDBACK_PAGE_MAX_CHARS}`,
      );
    }

    let full: FeedbackFullContent;
    try {
      full = readFeedbackContent(params.id);
    } catch (error) {
      if (error instanceof FeedbackLookupError) return lookupError(error);
      throw error;
    }

    if (params.offset === undefined && params.limit === undefined) {
      const whole = {
        status: "success",
        mode: "entry",
        ...recordMetadata(full),
        entry: full.content,
      };
      if (bytesOf(whole) <= FEEDBACK_RESPONSE_MAX_BYTES) return json(whole);
    }
    return pageResult(
      full,
      params.offset ?? 0,
      params.limit ?? FEEDBACK_PAGE_DEFAULT_CHARS,
    );
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            error: String(err),
          }),
        },
      ],
    };
  }
}
