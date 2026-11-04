import { describe, expect, it } from "vitest";

import {
  applyMcpPromptCompletion,
  formatMcpPromptSignature,
  parseMcpPromptArguments,
  type McpPromptArgumentDefinition,
} from "./mcpPromptArguments.js";

const definitions: McpPromptArgumentDefinition[] = [
  { name: "to", required: true },
  { name: "question", required: true },
  { name: "tone" },
];

describe("MCP prompt argument parsing", () => {
  it("parses positional arguments and lets the last positional argument take the rest", () => {
    const parsed = parseMcpPromptArguments("tab-2 can you check the build?", [
      { name: "to", required: true },
      { name: "question", required: true },
    ]);

    expect(parsed.values).toEqual({
      to: "tab-2",
      question: "can you check the build?",
    });
    expect(parsed.missing).toEqual([]);
  });

  it("parses named arguments, including quoted values, in any order", () => {
    const parsed = parseMcpPromptArguments(
      'tone="very carefully" to=tab-2 question="check the build"',
      definitions,
    );

    expect(parsed.values).toEqual({
      tone: "very carefully",
      to: "tab-2",
      question: "check the build",
    });
    expect(parsed.missing).toEqual([]);
  });

  it("uses only free positional slots around named arguments", () => {
    const parsed = parseMcpPromptArguments(
      "tab-2 tone=brief review this",
      definitions,
    );

    expect(parsed.values).toEqual({
      to: "tab-2",
      tone: "brief",
      question: "review this",
    });
  });

  it("does not reinterpret named-looking text inside the final argument", () => {
    const parsed = parseMcpPromptArguments(
      "tab-2 please deploy to=prod now",
      definitions.slice(0, 2),
    );
    expect(parsed.values).toEqual({
      to: "tab-2",
      question: "please deploy to=prod now",
    });
    expect(
      parseMcpPromptArguments('tab-2 "a b" c', definitions.slice(0, 2)).values
        .question,
    ).toBe("a b c");
  });

  it("reports the active argument and required arguments with no value", () => {
    const text = 'to=tab-2 question="please';
    const parsed = parseMcpPromptArguments(text, definitions);

    expect(parsed.active).toMatchObject({
      name: "question",
      value: "please",
      start: text.indexOf("please"),
      named: true,
    });
    expect(parsed.missing).toEqual([]);
    expect(parseMcpPromptArguments("", definitions).missing).toEqual([
      "to",
      "question",
    ]);
  });

  it("formats required and optional arguments as a command signature", () => {
    expect(formatMcpPromptSignature(definitions)).toBe(
      "<to> <question> [tone]",
    );
  });
});

describe("MCP prompt argument completions", () => {
  it("replaces a bare value and keeps the trailing text separated", () => {
    expect(
      applyMcpPromptCompletion(
        "to=tab question rest",
        {
          name: "question",
          value: "question",
          start: 7,
          end: 15,
          named: true,
        },
        "check status",
      ),
    ).toEqual({ text: 'to=tab "check status" rest', cursor: 22 });
  });

  it("replaces an existing opening quote and escapes quotes and backslashes", () => {
    const text = 'question="old"';
    expect(
      applyMcpPromptCompletion(
        text,
        {
          name: "question",
          value: "old",
          start: text.indexOf("old"),
          end: text.length,
          named: true,
        },
        'a "quote" \\ path',
      ),
    ).toEqual({ text: 'question="a \\"quote\\" \\\\ path" ', cursor: 31 });
  });

  it("does not add an extra separator before existing whitespace", () => {
    expect(
      applyMcpPromptCompletion(
        "tone=sho next",
        { name: "tone", value: "sho", start: 5, end: 8, named: true },
        "short",
      ),
    ).toEqual({ text: "tone=short next", cursor: 11 });
  });
});
