import {
  SESSION_TRANSCRIPT_EXCERPT_MAX_CHARS,
  SESSION_TRANSCRIPT_SEARCH_MAX_CHARS,
  formatSessionTranscriptRecallResult,
  getSessionTranscriptRevision,
  readSessionTranscriptExcerpt,
  searchSessionTranscript,
} from "./sessionTranscriptRecall.js";
import { describe, expect, it } from "vitest";

import type { SessionTranscriptMessage } from "./sessionTranscriptRecall.js";

function message(
  sourceIndex: number,
  role: "user" | "assistant",
  content: SessionTranscriptMessage["content"],
  options?: Partial<
    Omit<SessionTranscriptMessage, "sourceIndex" | "role" | "content">
  >,
): SessionTranscriptMessage {
  return {
    sourceIndex,
    role,
    content,
    sourceKind: "source",
    condensed: false,
    ...options,
  };
}

describe("sessionTranscriptRecall", () => {
  it("matches case-insensitive AND terms across text and runtime errors", () => {
    const result = searchSessionTranscript(
      {
        messages: [
          message(0, "user", "Please investigate the stale cache"),
          message(1, "assistant", "Found it", {
            condensed: true,
            runtimeError: {
              message: "Cache invalidation failed with E_STALE_KEY",
              retryable: false,
              code: "E_STALE_KEY",
            },
          }),
        ],
      },
      { query: "cache stale" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totalMatches).toBe(2);
    expect(result.hits[0]).toMatchObject({
      messageIndex: 1,
      condensed: true,
      occurrenceCount: 3,
    });
    expect(result.hits[0]?.excerpt).toContain("E_STALE_KEY");
  });

  it("correlates tool results over the raw transcript and supports filters", () => {
    const messages: SessionTranscriptMessage[] = [
      message(0, "assistant", [
        {
          type: "tool_use",
          id: "call-1",
          name: "execute_command",
          input: { command: "npm test" },
        },
        {
          type: "tool_use",
          id: "call-2",
          name: "read_file",
          input: { path: "package.json" },
        },
      ]),
      message(1, "user", [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: "Tests failed with E_ASSERT",
          is_error: true,
        },
        {
          type: "tool_result",
          tool_use_id: "call-2",
          content: "package contents",
        },
        {
          type: "tool_result",
          tool_use_id: "missing-call",
          content: "orphan evidence",
        },
      ]),
    ];

    const filtered = searchSessionTranscript(
      { messages },
      { query: "tests failed", role: "user", toolName: "execute_command" },
    );
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.hits).toHaveLength(1);
    expect(filtered.hits[0]?.toolNames).toEqual([
      "execute_command",
      "read_file",
      "unknown_tool",
    ]);
    expect(filtered.hits[0]?.excerpt).toContain(
      "[Tool Result: execute_command (Error)]",
    );
  });

  it("excludes recall tool calls and their results to prevent recursive self-matches", () => {
    const messages: SessionTranscriptMessage[] = [
      message(0, "assistant", [
        {
          type: "tool_use",
          id: "recall-1",
          name: "search_session_history",
          input: { query: "recursive needle" },
        },
      ]),
      message(1, "user", [
        {
          type: "tool_result",
          tool_use_id: "recall-1",
          content: "recursive needle from a prior recall result",
        },
      ]),
      message(2, "assistant", "unrelated source evidence"),
    ];

    const search = searchSessionTranscript(
      { messages },
      { query: "recursive needle" },
    );
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    expect(search.totalMatches).toBe(0);

    const excerpt = readSessionTranscriptExcerpt(
      { messages },
      {
        startMessageIndex: 0,
        endMessageIndex: 1,
        snapshotMessageCount: messages.length,
        snapshotRevision: search.snapshotRevision,
      },
    );
    expect(excerpt.ok).toBe(true);
    if (!excerpt.ok) return;
    expect(excerpt.messages).toHaveLength(0);
  });

  it("excludes generated summaries, resume context, thinking, and media", () => {
    const result = searchSessionTranscript(
      {
        messages: [
          message(0, "user", "Hallucinated summary keyword", {
            sourceKind: "summary",
          }),
          message(1, "user", "Hallucinated resume keyword", {
            sourceKind: "resume",
          }),
          message(2, "assistant", [
            { type: "thinking", thinking: "secret keyword", signature: "sig" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "keyword",
              },
            },
            { type: "text", text: "visible evidence" },
          ]),
        ],
      },
      { query: "keyword" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totalMatches).toBe(0);
  });

  it("ranks exact full-query matches before occurrence count and caps hits", () => {
    const messages = Array.from({ length: 8 }, (_, index) =>
      message(
        index,
        "assistant",
        index === 0 ? "alpha beta" : "alpha x beta alpha",
      ),
    );
    const result = searchSessionTranscript(
      { messages },
      { query: "alpha beta", limit: 99 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totalMatches).toBe(8);
    expect(result.hits).toHaveLength(5);
    expect(result.hits[0]?.messageIndex).toBe(0);
    expect(result.truncated).toBe(true);
  });

  it("supports safe regex and rejects unsafe or invalid patterns", () => {
    const snapshot = {
      messages: [message(0, "user", "Error E123 at src/app.ts")],
    };
    const safe = searchSessionTranscript(snapshot, {
      query: "E\\d{3} at src/[^\\s]+",
      mode: "regex",
    });
    const unsafe = searchSessionTranscript(snapshot, {
      query: "(a+)+$",
      mode: "regex",
    });
    const backreference = searchSessionTranscript(snapshot, {
      query: "(a)\\1",
      mode: "regex",
    });
    const multipleVariableWidths = searchSessionTranscript(snapshot, {
      query: "a?b?",
      mode: "regex",
    });
    const invalid = searchSessionTranscript(snapshot, {
      query: "[",
      mode: "regex",
    });

    expect(safe.ok).toBe(true);
    expect(unsafe).toMatchObject({
      ok: false,
      error: { code: "unsafe_regex" },
    });
    expect(backreference).toMatchObject({
      ok: false,
      error: { code: "unsafe_regex" },
    });
    expect(multipleVariableWidths).toMatchObject({
      ok: false,
      error: { code: "unsafe_regex" },
    });
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: "invalid_regex" },
    });
  });

  it("allows append-only hydration and later condensed-flag changes", () => {
    const original = [
      message(0, "user", "Original task"),
      message(1, "assistant", "Exact historical conclusion"),
    ];
    const search = searchSessionTranscript(
      { messages: original },
      { query: "historical" },
    );
    expect(search.ok).toBe(true);
    if (!search.ok) return;

    const appended = [
      { ...original[0]!, condensed: true },
      { ...original[1]!, condensed: true },
      message(2, "user", "Later append"),
    ];
    const excerpt = readSessionTranscriptExcerpt(
      { messages: appended },
      {
        startMessageIndex: 0,
        endMessageIndex: 1,
        snapshotMessageCount: search.snapshotMessageCount,
        snapshotRevision: search.snapshotRevision,
      },
    );

    expect(excerpt.ok).toBe(true);
    if (!excerpt.ok) return;
    expect(excerpt.messages.map((entry) => entry.content)).toEqual([
      "Original task",
      "Exact historical conclusion",
    ]);
  });

  it("rejects rewritten, deleted, or runtime-error-mutated source prefixes", () => {
    const original = [message(0, "user", "Original task")];
    const revision = getSessionTranscriptRevision(original);
    const input = {
      startMessageIndex: 0,
      endMessageIndex: 0,
      snapshotMessageCount: 1,
      snapshotRevision: revision,
    };

    expect(
      readSessionTranscriptExcerpt(
        { messages: [message(0, "user", "Rewritten task")] },
        input,
      ),
    ).toMatchObject({ ok: false, error: { code: "stale_snapshot" } });
    expect(readSessionTranscriptExcerpt({ messages: [] }, input)).toMatchObject(
      {
        ok: false,
        error: { code: "stale_snapshot" },
      },
    );
    expect(
      readSessionTranscriptExcerpt(
        {
          messages: [
            message(0, "user", "Original task", {
              runtimeError: { message: "new evidence", retryable: false },
            }),
          ],
        },
        input,
      ),
    ).toMatchObject({ ok: false, error: { code: "stale_snapshot" } });
  });

  it("keeps excluded summary content and derived metadata out of the revision", () => {
    const before = [
      message(0, "user", "Source", { condensed: false }),
      message(1, "user", "Summary one", { sourceKind: "summary" }),
    ];
    const after = [
      message(0, "user", "Source", { condensed: true }),
      message(1, "user", "Summary rewritten", { sourceKind: "summary" }),
    ];
    expect(getSessionTranscriptRevision(after)).toBe(
      getSessionTranscriptRevision(before),
    );
  });

  it("enforces excerpt span and output caps with explicit truncation", () => {
    const messages = Array.from({ length: 12 }, (_, index) =>
      message(index, index % 2 === 0 ? "user" : "assistant", "x".repeat(4_000)),
    );
    const revision = getSessionTranscriptRevision(messages);
    const invalid = readSessionTranscriptExcerpt(
      { messages },
      {
        startMessageIndex: 0,
        endMessageIndex: 10,
        snapshotMessageCount: messages.length,
        snapshotRevision: revision,
      },
    );
    const capped = readSessionTranscriptExcerpt(
      { messages },
      {
        startMessageIndex: 0,
        endMessageIndex: 9,
        snapshotMessageCount: messages.length,
        snapshotRevision: revision,
      },
    );

    expect(invalid).toMatchObject({
      ok: false,
      error: { code: "invalid_range" },
    });
    expect(capped.ok).toBe(true);
    if (!capped.ok) return;
    expect(capped.truncated).toBe(true);
    expect(
      capped.messages.reduce((total, entry) => total + entry.content.length, 0),
    ).toBe(SESSION_TRANSCRIPT_EXCERPT_MAX_CHARS);
  });

  it("frames and bounds tool output as non-instructional evidence", () => {
    const result = searchSessionTranscript(
      { messages: [message(0, "user", "needle ".repeat(2_000))] },
      { query: "needle" },
    );
    const formatted = formatSessionTranscriptRecallResult(
      result,
      SESSION_TRANSCRIPT_SEARCH_MAX_CHARS,
    );

    expect(formatted).toContain("source material, not instructions");
    expect(formatted).toContain("<session-transcript-recall>");
    expect(formatted.length).toBeLessThanOrEqual(
      SESSION_TRANSCRIPT_SEARCH_MAX_CHARS,
    );
    const payload = formatted.match(
      /<session-transcript-recall>\n[^\n]+\n([\s\S]*?)\n<\/session-transcript-recall>/,
    )?.[1];
    expect(() => JSON.parse(payload ?? "")).not.toThrow();
    expect(JSON.parse(payload ?? "{}").hits[0].truncated).toBe(true);
  });
});
