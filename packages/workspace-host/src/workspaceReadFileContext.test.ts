import {
  WorkspaceReadFileContextTracker,
  buildWorkspaceReadFileContext,
  createManagedTypeScriptReadFileEnrichment,
} from "./workspaceReadFileContext.js";
import { describe, expect, it } from "vitest";

function build(
  content: string,
  tracker: WorkspaceReadFileContextTracker,
  params: Parameters<typeof buildWorkspaceReadFileContext>[0]["params"] = {},
) {
  const bytes = Buffer.from(content);
  return buildWorkspaceReadFileContext(
    {
      sessionId: "session-a",
      path: "src/example.ts",
      absolutePath: "/workspace/src/example.ts",
      bytes,
      modifiedMs: 1_700_000_000_000,
      content,
      redacted: false,
      language: "typescript",
      gitStatus: "modified",
      params,
      now: 123,
    },
    tracker,
  );
}

describe("workspace read_file context", () => {
  it("uses VS Code's bounded line preview and continuation shape", () => {
    const result = build(
      "x".repeat(2_500),
      new WorkspaceReadFileContextTracker(),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.payload).toMatchObject({
      path: "src/example.ts",
      total_lines: 1,
      showing: "1-1",
      truncated: true,
      content_truncation: {
        max_line_chars: 2_000,
        max_content_chars: 20_000,
        omitted_bytes: 500,
        omitted_lines: 0,
        next_read: {
          path: "src/example.ts",
          view: "context",
          offset: 1,
          character_offset: 2_000,
          limit: 1,
        },
      },
      git_status: "modified",
    });
    expect(String(result.payload.content)).toHaveLength(2_004);
  });

  it("deduplicates only the same unchanged range and refreshes on request", () => {
    const tracker = new WorkspaceReadFileContextTracker();
    const first = build("alpha\nbeta", tracker, { limit: 1 });
    const second = build("alpha\nbeta", tracker, {
      limit: 1,
      dedupeUnchangedContent: true,
    });
    const otherRange = build("alpha\nbeta", tracker, {
      offset: 2,
      limit: 1,
      dedupeUnchangedContent: true,
    });
    const refreshed = build("alpha\nbeta", tracker, {
      limit: 1,
      dedupeUnchangedContent: true,
      refresh: true,
    });
    expect(first.ok && first.payload.working_set).toMatchObject({
      status: "new",
    });
    expect(second.ok && second.payload).not.toHaveProperty("content");
    expect(second.ok && second.payload.working_set).toMatchObject({
      status: "omitted_unchanged",
      should_include_content: false,
    });
    expect(otherRange.ok && otherRange.payload).toHaveProperty("content");
    expect(refreshed.ok && refreshed.payload).toHaveProperty("content");
  });

  it("projects managed TypeScript diagnostics and symbols into the context shape", () => {
    const enrichment = createManagedTypeScriptReadFileEnrichment(
      {
        state: "stale",
        value: [{ severity: 1 }, { severity: 2 }, { severity: 3 }],
      },
      {
        state: "ready",
        value: [
          {
            name: "Example",
            kind: 5,
            range: { start: { line: 2 } },
            children: [
              {
                name: "method",
                kind: 6,
                range: { start: { line: 4 } },
              },
            ],
          },
        ],
      },
    );
    expect(enrichment).toEqual({
      diagnostics: {
        errors: 1,
        warnings: 1,
        note: expect.stringContaining("stale"),
      },
      symbols: {
        class: ["Example (line 3)"],
        method: ["Example.method (line 5)"],
      },
    });
  });
});
