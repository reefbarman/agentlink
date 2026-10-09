import {
  BUDGET_EVIDENCE_DIGEST_MARKER,
  buildBudgetEvidenceDigest,
} from "./budgetEvidenceDigest.js";
import { describe, expect, it } from "vitest";

import type { AgentMessage } from "../types.js";

function toolTurn(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  results: Array<{ id: string; isError?: boolean; content?: string }>,
): AgentMessage[] {
  return [
    {
      role: "assistant",
      content: calls.map((call) => ({ type: "tool_use" as const, ...call })),
    },
    {
      role: "user",
      content: results.map((result) => ({
        type: "tool_result" as const,
        tool_use_id: result.id,
        content: result.content ?? "ok",
        ...(result.isError ? { is_error: true } : {}),
      })),
    },
  ] as AgentMessage[];
}

describe("buildBudgetEvidenceDigest", () => {
  it("lists completed tool calls with identifying inputs but no results", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Research the client binding" } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "I'll start with the binding." }],
      } as AgentMessage,
      ...toolTurn(
        [
          {
            id: "a",
            name: "read_file",
            input: { path: "src/client.ts", offset: 40, limit: 80 },
          },
          {
            id: "b",
            name: "search_files",
            input: { path: "src", regex: "bindClient\\(", context: 2 },
          },
          { id: "c", name: "read_file", input: { path: "src/missing.ts" } },
        ],
        [
          { id: "a", content: "SECRET_FILE_CONTENT" },
          { id: "b" },
          { id: "c", isError: true },
        ],
      ),
      // A pending call without a result is not completed evidence.
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "d",
            name: "read_file",
            input: { path: "src/pending.ts" },
          },
        ],
      } as AgentMessage,
    ];

    const digest = buildBudgetEvidenceDigest(messages);

    expect(digest).toBe(
      [
        `${BUDGET_EVIDENCE_DIGEST_MARKER} The hard budget backstop stopped this agent before it summarized its findings. Completed tool calls (identifying inputs only; results are not included):`,
        "- read_file path=src/client.ts offset=40",
        "- search_files path=src regex=bindClient\\(",
      ].join("\n"),
    );
    expect(digest).not.toContain("SECRET_FILE_CONTENT");
    expect(digest).not.toContain("missing.ts");
    expect(digest).not.toContain("pending.ts");
  });

  it("bounds entries and long values", () => {
    const calls = Array.from({ length: 45 }, (_, index) => ({
      id: `call-${index}`,
      name: "read_file",
      input: { path: `${"x".repeat(300)}-${index}` },
    }));
    const digest = buildBudgetEvidenceDigest(
      toolTurn(
        calls,
        calls.map((call) => ({ id: call.id })),
      ),
    )!;

    const lines = digest.split("\n");
    expect(lines).toHaveLength(1 + 40 + 1);
    expect(lines.at(-1)).toBe("- …and 5 more completed tool calls");
    expect(lines[1].length).toBeLessThan(200);
  });

  it("returns undefined when no tool call completed", () => {
    expect(
      buildBudgetEvidenceDigest([
        { role: "assistant", content: [{ type: "text", text: "Starting" }] },
      ] as AgentMessage[]),
    ).toBeUndefined();
  });
});
