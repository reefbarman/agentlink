import { describe, expect, it } from "vitest";
import {
  maskShellHeredocBodies,
  scanShellLexBoundaries,
  scanShellLexLiteralOccurrences,
  scanShellLexTokens,
  scanShellLexWords,
} from "./shellLex.js";

describe("maskShellHeredocBodies", () => {
  it("masks quoted heredoc bodies without changing source length or newlines", () => {
    const input = [
      "python - <<'PY'",
      `text = "it's safe"`,
      "```markdown",
      String.raw`assert re.match(r"['\\\"]", text)`,
      "PY",
      "echo done",
    ].join("\n");
    const result = maskShellHeredocBodies(input);

    expect(result.unterminatedDelimiters).toEqual([]);
    expect(result.maskedInput).toHaveLength(input.length);
    expect(result.maskedInput.match(/\n/g)).toHaveLength(
      input.match(/\n/g)?.length ?? 0,
    );
    expect(result.maskedInput).toContain("python - <<'PY'");
    expect(result.maskedInput).toContain("echo done");
    expect(result.maskedInput).not.toContain("it's safe");
  });

  it("supports multiple heredocs and tab-stripped terminators", () => {
    const input = [
      "cat <<FIRST <<-'SECOND'",
      "first ' body",
      "FIRST",
      '\tsecond " body',
      "\tSECOND",
    ].join("\n");

    expect(maskShellHeredocBodies(input).unterminatedDelimiters).toEqual([]);
  });

  it("reports missing delimiters in declaration order", () => {
    expect(
      maskShellHeredocBodies("cat <<'FIRST' <<SECOND\nbody")
        .unterminatedDelimiters,
    ).toEqual(["FIRST", "SECOND"]);
  });

  it.each(["echo $((1 << 2))", "(( value = 1 << 2 ))"])(
    "does not interpret arithmetic shifts as heredocs: %s",
    (input) => {
      expect(maskShellHeredocBodies(input)).toEqual({
        maskedInput: input,
        unterminatedDelimiters: [],
      });
    },
  );
});

describe("scanShellLexBoundaries", () => {
  it.each([
    { input: "left && right", operator: "&&", start: 5, end: 7 },
    { input: "left || right", operator: "||", start: 5, end: 7 },
    { input: "left | right", operator: "|", start: 5, end: 6 },
    { input: "left; right", operator: ";", start: 4, end: 5 },
    { input: "left\nright", operator: "\n", start: 4, end: 5 },
  ] as const)("returns the exact $operator source span", (entry) => {
    expect(scanShellLexBoundaries(entry.input).boundaries).toEqual([
      {
        kind: "separator",
        operator: entry.operator,
        start: entry.start,
        end: entry.end,
      },
    ]);
  });

  it.each([
    { input: "echo ok # trailing", start: 8, end: 18 },
    { input: "echo ok # line\necho next", start: 8, end: 15 },
  ])("returns the exact comment source span for $input", (entry) => {
    expect(scanShellLexBoundaries(entry.input).boundaries).toEqual([
      { kind: "comment", start: entry.start, end: entry.end },
    ]);
  });

  it("does not reinterpret disallowed longest-match separators", () => {
    expect(
      scanShellLexBoundaries("left || right", {
        separators: ["|"],
        comments: false,
      }).boundaries,
    ).toEqual([]);
    expect(
      scanShellLexBoundaries("left | right", {
        separators: ["||"],
        comments: false,
      }).boundaries,
    ).toEqual([]);
  });

  it("supports a compound-only dialect without comments", () => {
    const input = "left | middle\n# text; right || fallback";
    expect(
      scanShellLexBoundaries(input, {
        separators: ["&&", "||", ";"],
        comments: false,
      }),
    ).toEqual({
      boundaries: [
        { kind: "separator", operator: ";", start: 20, end: 21 },
        { kind: "separator", operator: "||", start: 28, end: 30 },
      ],
      finalState: { quote: null, danglingEscape: false },
    });
  });

  it("returns source spans for separators and comments", () => {
    const input = "echo one && echo two # ignored\necho three | wc -l";

    expect(scanShellLexBoundaries(input)).toEqual({
      boundaries: [
        { kind: "separator", operator: "&&", start: 9, end: 11 },
        { kind: "comment", start: 21, end: 31 },
        { kind: "separator", operator: "|", start: 42, end: 43 },
      ],
      finalState: { quote: null, danglingEscape: false },
    });
  });

  it("ignores quoted and escaped separators using legacy escape semantics", () => {
    const input = String.raw`echo 'one; two' "three | four" five\;six && done`;

    expect(scanShellLexBoundaries(input).boundaries).toEqual([
      { kind: "separator", operator: "&&", start: 41, end: 43 },
    ]);
  });

  it("reports malformed final state without changing boundary discovery", () => {
    expect(scanShellLexBoundaries(`echo "unterminated && rm -rf tmp`)).toEqual({
      boundaries: [],
      finalState: { quote: "double", danglingEscape: false },
    });
    expect(scanShellLexBoundaries("echo trailing\\")).toEqual({
      boundaries: [],
      finalState: { quote: null, danglingEscape: true },
    });
  });

  it("keeps hash characters literal outside comment word boundaries", () => {
    expect(
      scanShellLexBoundaries("echo issue#123 && echo '# literal'"),
    ).toEqual({
      boundaries: [{ kind: "separator", operator: "&&", start: 15, end: 17 }],
      finalState: { quote: null, danglingEscape: false },
    });
  });
});

describe("scanShellLexWords", () => {
  it("returns raw source-preserving word spans", () => {
    const input = `git "status --short" 'src files'`;
    expect(scanShellLexWords(input)).toEqual({
      words: [
        { start: 0, end: 3, raw: "git" },
        { start: 4, end: 20, raw: `"status --short"` },
        { start: 21, end: 32, raw: `'src files'` },
      ],
      finalState: { quote: null, danglingEscape: false },
    });
  });

  it("keeps escaped whitespace in one raw word outside quotes", () => {
    expect(scanShellLexWords(String.raw`git status\ --short`).words).toEqual([
      { start: 0, end: 3, raw: "git" },
      { start: 4, end: 19, raw: String.raw`status\ --short` },
    ]);
  });

  it("treats backslash literally inside single quotes", () => {
    expect(scanShellLexWords(String.raw`git 'status\' --short'`).words).toEqual(
      [
        { start: 0, end: 3, raw: "git" },
        { start: 4, end: 13, raw: String.raw`'status\'` },
        { start: 14, end: 22, raw: String.raw`--short'` },
      ],
    );
  });

  it("preserves empty quoted words", () => {
    expect(scanShellLexWords(`node "" ''`).words).toEqual([
      { start: 0, end: 4, raw: "node" },
      { start: 5, end: 7, raw: `""` },
      { start: 8, end: 10, raw: `''` },
    ]);
  });

  it("reports malformed state without dropping raw words", () => {
    expect(scanShellLexWords(`echo "unterminated`)).toEqual({
      words: [
        { start: 0, end: 4, raw: "echo" },
        { start: 5, end: 18, raw: `"unterminated` },
      ],
      finalState: { quote: "double", danglingEscape: false },
    });
    expect(scanShellLexWords("echo trailing\\")).toEqual({
      words: [
        { start: 0, end: 4, raw: "echo" },
        { start: 5, end: 14, raw: "trailing\\" },
      ],
      finalState: { quote: null, danglingEscape: true },
    });
  });
});

describe("scanShellLexLiteralOccurrences", () => {
  it("reports exact quote, escape, and comment context for every occurrence", () => {
    const literal = "$AL_FILE(";
    const input = String.raw`cmd $AL_FILE(a) '$AL_FILE(b)' "$AL_FILE(c)" \$AL_FILE(d) # $AL_FILE(e)`;

    expect(scanShellLexLiteralOccurrences(input, literal).occurrences).toEqual([
      {
        start: input.indexOf("$AL_FILE(a)"),
        end: input.indexOf("$AL_FILE(a)") + literal.length,
        quote: null,
        escaped: false,
        comment: false,
      },
      {
        start: input.indexOf("$AL_FILE(b)"),
        end: input.indexOf("$AL_FILE(b)") + literal.length,
        quote: "single",
        escaped: false,
        comment: false,
      },
      {
        start: input.indexOf("$AL_FILE(c)"),
        end: input.indexOf("$AL_FILE(c)") + literal.length,
        quote: "double",
        escaped: false,
        comment: false,
      },
      {
        start: input.indexOf("$AL_FILE(d)"),
        end: input.indexOf("$AL_FILE(d)") + literal.length,
        quote: null,
        escaped: true,
        comment: false,
      },
      {
        start: input.indexOf("$AL_FILE(e)"),
        end: input.indexOf("$AL_FILE(e)") + literal.length,
        quote: null,
        escaped: false,
        comment: true,
      },
    ]);
  });

  it("reports full parameter-expansion spans", () => {
    const input = "echo $WORKSPACE $AL_FILE(a)";
    const syntax = scanShellLexLiteralOccurrences(
      input,
      "$AL_FILE(",
    ).unsupportedSyntax;

    expect(syntax).toContainEqual({
      kind: "parameter-expansion",
      start: input.indexOf("$WORKSPACE"),
      end: input.indexOf("$WORKSPACE") + "$WORKSPACE".length,
    });
  });

  it("does not treat a hash adjacent to a placeholder as a comment", () => {
    const input = "cmd $AL_FILE(a)#$AL_FILE(b)";
    expect(
      scanShellLexLiteralOccurrences(input, "$AL_FILE(").occurrences.map(
        ({ comment }) => comment,
      ),
    ).toEqual([false, false]);
  });

  it.each([
    ["command-substitution", "echo $(cat $AL_FILE(a))"],
    ["backtick-substitution", "echo `cat $AL_FILE(a)`"],
    ["parameter-expansion", "echo ${value:-$AL_FILE(a)}"],
    ["arithmetic-expansion", "echo $((1 + $AL_FILE(a)))"],
    ["process-substitution", "diff <(cat $AL_FILE(a)) expected"],
    ["heredoc", "cat <<EOF\n$AL_FILE(a)\nEOF"],
    ["ansi-c-quote", "printf $'$AL_FILE(a)'"],
  ] as const)("reports %s without interpreting it", (kind, input) => {
    expect(
      scanShellLexLiteralOccurrences(input, "$AL_FILE(").unsupportedSyntax,
    ).toContainEqual(expect.objectContaining({ kind }));
  });
});

// This normalized scanner is intentionally separate from the raw word scanner:
// security consumers need exact control over quote, escape, and operator handling.
describe("scanShellLexTokens", () => {
  it("normalizes quotes and escapes while omitting empty quoted arguments", () => {
    expect(
      scanShellLexTokens(String.raw`cp "source file" escaped\ path "" ''`),
    ).toEqual({
      tokens: ["cp", "source file", "escaped path"],
      finalState: { quote: null, danglingEscape: false },
    });
  });

  it("splits only configured longest-match operators", () => {
    expect(
      scanShellLexTokens("echo hi 2>>out <in", {
        operators: [">>", ">", "<"],
      }).tokens,
    ).toEqual(["echo", "hi", "2", ">>", "out", "<", "in"]);
    expect(scanShellLexTokens("echo hi 2>>out").tokens).toEqual([
      "echo",
      "hi",
      "2>>out",
    ]);
    expect(
      scanShellLexTokens("echo hi >>out", { operators: [">"] }).tokens,
    ).toEqual(["echo", "hi", ">>out"]);
    expect(
      scanShellLexTokens("echo hi >out", { operators: [">>"] }).tokens,
    ).toEqual(["echo", "hi", ">out"]);
  });

  it("supports legacy escape-next behavior inside single quotes", () => {
    const input = String.raw`echo 'AGENTS\.md'`;
    expect(scanShellLexTokens(input).tokens).toEqual([
      "echo",
      String.raw`AGENTS\.md`,
    ]);
    expect(
      scanShellLexTokens(input, { escapeInSingleQuotes: true }).tokens,
    ).toEqual(["echo", "AGENTS.md"]);
  });

  it("reports malformed state after preserving normalized tokens", () => {
    expect(scanShellLexTokens(`echo "unterminated`)).toEqual({
      tokens: ["echo", "unterminated"],
      finalState: { quote: "double", danglingEscape: false },
    });
    expect(scanShellLexTokens("echo trailing\\")).toEqual({
      tokens: ["echo", "trailing"],
      finalState: { quote: null, danglingEscape: true },
    });
  });
});
