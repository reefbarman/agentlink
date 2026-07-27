import { createHash } from "crypto";
import { describe, expect, it } from "vitest";

import {
  buildContextDoctorReport,
  type ContextDoctorInput,
} from "./contextDoctor.js";
import type { AgentMessage } from "./types.js";

function makeInput(
  overrides: Partial<ContextDoctorInput> = {},
): ContextDoctorInput {
  return {
    model: "test-model",
    mode: "code",
    lastInputTokens: 12_345,
    lastOutputTokens: 321,
    lastCacheReadTokens: 4_000,
    contextBreakdown: {
      prompt: {
        sections: [
          { label: "small", chars: 40, estimatedTokens: 10 },
          { label: "large", chars: 400, estimatedTokens: 100, count: 2 },
        ],
        totalChars: 440,
        estimatedTokens: 110,
        profile: "reasoning",
        profileSource: "exact-model-override",
      },
      tools: {
        totalToolCount: 3,
        totalChars: 800,
        estimatedTokens: 200,
        native: {
          label: "Native/meta tools",
          count: 2,
          chars: 600,
          estimatedTokens: 150,
        },
        mcp: {
          totalServerCount: 1,
          totalToolCount: 1,
          totalChars: 200,
          estimatedTokens: 50,
          servers: [
            {
              serverName: "linear",
              chars: 200,
              estimatedTokens: 50,
              toolCount: 1,
            },
          ],
        },
      },
      contextLedger: {
        contextWindowTokens: 128_000,
        maxInputTokens: 120_000,
        outputReservationTokens: 8_000,
        safetyBufferTokens: 6_000,
        hardInputLimitTokens: 114_000,
        requestedInputTokens: 115_500,
        allocatedInputTokens: 114_000,
        remainingInputTokens: 0,
        overflowTokens: 0,
        layers: [
          {
            layer: "system_prompt",
            requestedTokens: 2_000,
            budgetTokens: 2_000,
            allocatedTokens: 2_000,
            omittedTokens: 0,
            required: true,
          },
          {
            layer: "retrieved_context",
            requestedTokens: 2_000,
            budgetTokens: 1_500,
            allocatedTokens: 500,
            omittedTokens: 1_500,
            required: false,
          },
        ],
      },
    },
    toolResultContextAttributions: [
      {
        toolCallId: "call-exact",
        toolName: "read_file",
        chars: 4_000,
        bytes: 4_000,
        estimatedTokens: 1_000,
      },
    ],
    omittedToolResultContextAttributions: 2,
    messages: [],
    ...overrides,
  };
}

function repeatedToolMessages(text: string): AgentMessage[] {
  const hash = createHash("sha256").update(text).digest("hex");
  return [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call-exact", name: "read_file", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call-exact", content: text },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-reference",
          name: "read_file",
          input: {},
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-reference",
          content: [
            "[Unchanged large tool result; exact content retained from read_file call call-exact.]",
            `SHA-256: ${hash}`,
            `Original size: ${text.length} characters`,
            "Full output: /tmp/result.txt — use read_file to access the exact result.",
          ].join("\n"),
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "condensed" }],
      uiHint: { condense: { newInputTokens: 7_500 } },
    },
  ];
}

describe("buildContextDoctorReport", () => {
  it("renders measured prompt, tool, ledger, retention, and condensation evidence", () => {
    const repeatedText = "unchanged result\n".repeat(400);
    const report = buildContextDoctorReport(
      makeInput({ messages: repeatedToolMessages(repeatedText) }),
    );

    expect(report.promptSections.map((section) => section.label)).toEqual([
      "large",
      "small",
    ]);
    expect(report.promptProfile).toBe("reasoning");
    expect(report.repeatedToolResultGroups).toBe(1);
    expect(report.toolResultFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolCallId: "call-exact", repeatCount: 2 }),
        expect.objectContaining({
          toolCallId: "call-reference",
          repeatCount: 2,
        }),
      ]),
    );
    expect(report.latestCondenseEstimate).toBe(7_500);
    expect(report.markdown).toContain("## Request context ledger");
    expect(report.markdown).toContain(
      "retrieved_context: 500 / 2,000 tokens (1,500 omitted)",
    );
    expect(report.markdown).toContain("linear: 50 tokens across 1 tools");
    expect(report.markdown).toContain("2 omitted from bounded detail");
    expect(report.markdown).toContain("## Diagnostics not yet instrumented");
    expect(report.markdown).toContain(
      "This report is read-only and does not rewrite instructions, memory, skills, or settings.",
    );
  });

  it("labels unavailable measurements without mutating its input", () => {
    const input = makeInput({
      contextBreakdown: {
        prompt: {
          sections: [],
          totalChars: 0,
          estimatedTokens: 0,
        },
      },
      messages: [],
      toolResultContextAttributions: [],
      omittedToolResultContextAttributions: 0,
    });
    const before = structuredClone(input);

    const report = buildContextDoctorReport(input);

    expect(input).toEqual(before);
    expect(report.markdown).toContain("No prompt-section measurements");
    expect(report.markdown).toContain("No tool-schema measurement");
    expect(report.markdown).toContain("No completed request ledger");
    expect(report.markdown).toContain("No retained tool results");
    expect(report.markdown).toContain("No completed condensation estimate");
  });
});
