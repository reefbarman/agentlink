import * as path from "path";

import { describe, expect, it } from "vitest";

import { splitCompoundCommand } from "../approvals/commandSplitter.js";
import {
  classifyCommand,
  type CommandTier,
} from "../approvals/commandTierClassifier.js";
import { validateInteractiveCommand } from "./interactiveValidator.js";
import { validateCommand } from "./pipeValidator.js";
import { validateProtectedWriteCommand } from "./protectedWriteValidator.js";
import {
  scanShellLexBoundaries,
  scanShellLexTokens,
  scanShellLexWords,
  type ShellLexFinalState,
} from "./shellLex.js";

const workspace = path.resolve("/workspace/project");
const scannerNames = [
  "boundaries",
  "words",
  "tokens",
  "tokensWithSingleQuoteEscapes",
] as const;

const cleanFinalState = { quote: null, danglingEscape: false } as const;

type ScannerName = (typeof scannerNames)[number];
type ScannerFinalStates = Record<ScannerName, ShellLexFinalState>;
type RequiredAggregateDisposition =
  | "reject"
  | "force-dangerous-approval"
  | "consumer-specific";

type DifferentialExpectation = {
  name: string;
  command: string;
  split: string[];
  tier: CommandTier;
  interactive: boolean;
  pipe: "direct" | "pipe" | null;
  protectedWrite: boolean;
  difference:
    | "shared-lexical"
    | "intentional-dialect"
    | "intentional-policy"
    | "opaque-unsupported"
    | "malformed";
  lexicalClass: "valid" | "opaque" | "malformed";
  requiredAggregateDisposition: RequiredAggregateDisposition;
  detectingScanners?: ScannerName[];
  scannerFinalStates?: ScannerFinalStates;
};

const cleanScannerFinalStates: ScannerFinalStates = {
  boundaries: cleanFinalState,
  words: cleanFinalState,
  tokens: cleanFinalState,
  tokensWithSingleQuoteEscapes: cleanFinalState,
};

function scannerFinalStates(state: ShellLexFinalState): ScannerFinalStates {
  return {
    boundaries: state,
    words: state,
    tokens: state,
    tokensWithSingleQuoteEscapes: state,
  };
}

const danglingEscapeScannerStates = scannerFinalStates({
  quote: null,
  danglingEscape: true,
});

const doubleQuoteScannerStates = scannerFinalStates({
  quote: "double",
  danglingEscape: false,
});

const singleQuoteScannerStates = scannerFinalStates({
  quote: "single",
  danglingEscape: false,
});

const singleQuoteDanglingEscapeScannerStates: ScannerFinalStates = {
  boundaries: { quote: "single", danglingEscape: true },
  words: { quote: "single", danglingEscape: false },
  tokens: { quote: "single", danglingEscape: false },
  tokensWithSingleQuoteEscapes: { quote: "single", danglingEscape: true },
};

const corpus: DifferentialExpectation[] = [
  {
    name: "mixed compound operators",
    command: "git status && npm test | grep pass; echo done || rm -rf tmp",
    split: ["git status", "npm test", "grep pass", "echo done", "rm -rf tmp"],
    tier: "dangerous",
    interactive: false,
    pipe: "pipe",
    protectedWrite: false,
    difference: "intentional-policy",
    lexicalClass: "valid",
    requiredAggregateDisposition: "consumer-specific",
  },
  {
    name: "operators inside quotes",
    command: `echo "a && b | c; d || e"`,
    split: [`echo "a && b | c; d || e"`],
    tier: "safe",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "shared-lexical",
    lexicalClass: "valid",
    requiredAggregateDisposition: "consumer-specific",
  },
  {
    name: "escaped operator",
    command: String.raw`echo a\;b`,
    split: [String.raw`echo a\;b`],
    tier: "safe",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "shared-lexical",
    lexicalClass: "valid",
    requiredAggregateDisposition: "consumer-specific",
  },
  {
    name: "word-boundary comment",
    command: "echo before # ignored | grep hidden\necho after",
    split: ["echo before", "echo after"],
    tier: "safe",
    interactive: false,
    pipe: "pipe",
    protectedWrite: false,
    difference: "intentional-dialect",
    lexicalClass: "valid",
    requiredAggregateDisposition: "consumer-specific",
  },
  {
    name: "hash inside a word",
    command: "echo issue#123 && echo done",
    split: ["echo issue#123", "echo done"],
    tier: "safe",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "shared-lexical",
    lexicalClass: "valid",
    requiredAggregateDisposition: "consumer-specific",
  },
  {
    name: "command substitution",
    command: "echo $(whoami)",
    split: ["echo $(whoami)"],
    tier: "dangerous",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "intentional-policy",
    lexicalClass: "opaque",
    requiredAggregateDisposition: "consumer-specific",
  },
  {
    name: "environment assignment before interactive command",
    command: "NODE_ENV=prod python",
    split: ["NODE_ENV=prod python"],
    tier: "dangerous",
    interactive: true,
    pipe: null,
    protectedWrite: false,
    difference: "intentional-policy",
    lexicalClass: "valid",
    requiredAggregateDisposition: "consumer-specific",
  },
  {
    name: "pipeline filtering",
    command: "npm test | head -20",
    split: ["npm test", "head -20"],
    tier: "sensitive",
    interactive: false,
    pipe: "pipe",
    protectedWrite: false,
    difference: "intentional-policy",
    lexicalClass: "valid",
    requiredAggregateDisposition: "consumer-specific",
  },
  {
    name: "workspace output redirection",
    command: "echo result > generated.txt",
    split: ["echo result > generated.txt"],
    tier: "sensitive",
    interactive: false,
    pipe: "direct",
    protectedWrite: false,
    difference: "intentional-policy",
    lexicalClass: "valid",
    requiredAggregateDisposition: "consumer-specific",
  },
  {
    name: "protected output redirection",
    command: "echo memory > .agentlink/memory.md",
    split: ["echo memory > .agentlink/memory.md"],
    tier: "sensitive",
    interactive: false,
    pipe: "direct",
    protectedWrite: true,
    difference: "intentional-policy",
    lexicalClass: "valid",
    requiredAggregateDisposition: "consumer-specific",
  },
  {
    name: "file descriptor duplication",
    command: "gh api repos 2>&1 | wc -l",
    split: ["gh api repos 2>&1", "wc -l"],
    tier: "sensitive",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "shared-lexical",
    lexicalClass: "valid",
    requiredAggregateDisposition: "consumer-specific",
  },
  {
    name: "quoted heredoc delimiter",
    command: "cat <<'EOF' > generated.txt\nhello; world\nEOF",
    split: ["cat <<'EOF' > generated.txt", "hello", "world", "EOF"],
    tier: "dangerous",
    interactive: false,
    pipe: "direct",
    protectedWrite: false,
    difference: "opaque-unsupported",
    lexicalClass: "opaque",
    requiredAggregateDisposition: "consumer-specific",
  },
  {
    name: "separator inside command substitution",
    command: "echo $(echo first; rm -rf tmp)",
    split: ["echo $(echo first", "rm -rf tmp)"],
    tier: "dangerous",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "opaque-unsupported",
    lexicalClass: "opaque",
    requiredAggregateDisposition: "consumer-specific",
  },
  {
    name: "line continuation",
    command: "echo first \\\nsecond && echo third",
    split: ["echo first \\\nsecond", "echo third"],
    tier: "safe",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "shared-lexical",
    lexicalClass: "valid",
    requiredAggregateDisposition: "consumer-specific",
  },
  {
    name: "dangling escape",
    command: "echo trailing\\",
    split: ["echo trailing\\"],
    tier: "safe",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "malformed",
    lexicalClass: "malformed",
    requiredAggregateDisposition: "reject",
    detectingScanners: [
      "boundaries",
      "words",
      "tokens",
      "tokensWithSingleQuoteEscapes",
    ],
    scannerFinalStates: danglingEscapeScannerStates,
  },
  {
    name: "dangling escape after pipe",
    command: "npm test | grep trailing\\",
    split: ["npm test", "grep trailing\\"],
    tier: "sensitive",
    interactive: false,
    pipe: "pipe",
    protectedWrite: false,
    difference: "malformed",
    lexicalClass: "malformed",
    requiredAggregateDisposition: "reject",
    detectingScanners: [
      "boundaries",
      "words",
      "tokens",
      "tokensWithSingleQuoteEscapes",
    ],
    scannerFinalStates: danglingEscapeScannerStates,
  },
  {
    name: "dangling escape in command substitution",
    command: "echo $(printf trailing\\",
    split: ["echo $(printf trailing\\"],
    tier: "dangerous",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "malformed",
    lexicalClass: "malformed",
    requiredAggregateDisposition: "reject",
    detectingScanners: [
      "boundaries",
      "words",
      "tokens",
      "tokensWithSingleQuoteEscapes",
    ],
    scannerFinalStates: danglingEscapeScannerStates,
  },
  {
    name: "dangling escape inside single quote",
    command: "echo 'trailing\\",
    split: ["echo 'trailing\\"],
    tier: "safe",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "malformed",
    lexicalClass: "malformed",
    requiredAggregateDisposition: "reject",
    detectingScanners: [
      "boundaries",
      "words",
      "tokens",
      "tokensWithSingleQuoteEscapes",
    ],
    scannerFinalStates: singleQuoteDanglingEscapeScannerStates,
  },
  {
    name: "CRLF compound lines",
    command: "echo first\r\necho second\r\n",
    split: ["echo first", "echo second"],
    tier: "safe",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "shared-lexical",
    lexicalClass: "valid",
    requiredAggregateDisposition: "consumer-specific",
  },
  {
    name: "grouped shell expression",
    command: "(echo first; echo second)",
    split: ["(echo first", "echo second)"],
    tier: "sensitive",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "opaque-unsupported",
    lexicalClass: "opaque",
    requiredAggregateDisposition: "consumer-specific",
  },
  {
    name: "unterminated double quote",
    command: `echo "unterminated && rm -rf tmp`,
    split: [`echo "unterminated && rm -rf tmp`],
    tier: "safe",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "malformed",
    lexicalClass: "malformed",
    requiredAggregateDisposition: "reject",
    detectingScanners: [
      "boundaries",
      "words",
      "tokens",
      "tokensWithSingleQuoteEscapes",
    ],
    scannerFinalStates: doubleQuoteScannerStates,
  },
  {
    name: "unterminated single quote",
    command: "echo 'unterminated && rm -rf tmp",
    split: ["echo 'unterminated && rm -rf tmp"],
    tier: "safe",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "malformed",
    lexicalClass: "malformed",
    requiredAggregateDisposition: "reject",
    detectingScanners: [
      "boundaries",
      "words",
      "tokens",
      "tokensWithSingleQuoteEscapes",
    ],
    scannerFinalStates: singleQuoteScannerStates,
  },
  {
    name: "unterminated quote after pipe",
    command: `npm test | grep "unterminated`,
    split: ["npm test", `grep "unterminated`],
    tier: "sensitive",
    interactive: false,
    pipe: "pipe",
    protectedWrite: false,
    difference: "malformed",
    lexicalClass: "malformed",
    requiredAggregateDisposition: "reject",
    detectingScanners: [
      "boundaries",
      "words",
      "tokens",
      "tokensWithSingleQuoteEscapes",
    ],
    scannerFinalStates: doubleQuoteScannerStates,
  },
  {
    name: "unterminated quote in command substitution",
    command: `echo $(printf "unterminated`,
    split: [`echo $(printf "unterminated`],
    tier: "dangerous",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "malformed",
    lexicalClass: "malformed",
    requiredAggregateDisposition: "reject",
    detectingScanners: [
      "boundaries",
      "words",
      "tokens",
      "tokensWithSingleQuoteEscapes",
    ],
    scannerFinalStates: doubleQuoteScannerStates,
  },
  {
    name: "inline interpreter unterminated quote",
    command: `python -c "print('unterminated)`,
    split: [`python -c "print('unterminated)`],
    tier: "dangerous",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "malformed",
    lexicalClass: "malformed",
    requiredAggregateDisposition: "reject",
    detectingScanners: [
      "boundaries",
      "words",
      "tokens",
      "tokensWithSingleQuoteEscapes",
    ],
    scannerFinalStates: doubleQuoteScannerStates,
  },
  {
    name: "unsupported background operator",
    command: "npm test & echo done",
    split: ["npm test & echo done"],
    tier: "dangerous",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "opaque-unsupported",
    lexicalClass: "opaque",
    requiredAggregateDisposition: "consumer-specific",
  },
  {
    name: "PowerShell environment syntax",
    command: "$env:NODE_ENV = 'test'; npm test",
    split: ["$env:NODE_ENV = 'test'", "npm test"],
    tier: "dangerous",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "opaque-unsupported",
    lexicalClass: "opaque",
    requiredAggregateDisposition: "consumer-specific",
  },
];

function observe(command: string) {
  return {
    split: splitCompoundCommand(command),
    tier: classifyCommand(command, {
      cwd: workspace,
      workspaceRoots: [workspace],
    }).tier,
    interactive: validateInteractiveCommand(command) !== null,
    pipe: validateCommand(command)?.type ?? null,
    protectedWrite: validateProtectedWriteCommand(command, workspace) !== null,
    scannerFinalStates: {
      boundaries: scanShellLexBoundaries(command).finalState,
      words: scanShellLexWords(command).finalState,
      tokens: scanShellLexTokens(command).finalState,
      tokensWithSingleQuoteEscapes: scanShellLexTokens(command, {
        escapeInSingleQuotes: true,
        operators: [">>", ">", "<"],
      }).finalState,
    },
  };
}

function isCleanFinalState(state: ShellLexFinalState): boolean {
  return state.quote === null && !state.danglingEscape;
}

describe("shell lexical differential corpus", () => {
  it.each(corpus)("records $difference behavior for $name", (entry) => {
    const observation = observe(entry.command);

    expect(observation).toMatchObject({
      split: entry.split,
      tier: entry.tier,
      interactive: entry.interactive,
      pipe: entry.pipe,
      protectedWrite: entry.protectedWrite,
    });
  });

  it.each(corpus)(
    "records scanner final state and target disposition for $name",
    (entry) => {
      const { scannerFinalStates: observedStates } = observe(entry.command);
      const expectedStates =
        entry.scannerFinalStates ?? cleanScannerFinalStates;

      expect(observedStates).toEqual(expectedStates);

      if (entry.lexicalClass === "malformed") {
        const detectingScanners = entry.detectingScanners ?? [];
        const nonCleanScanners = scannerNames.filter(
          (scanner) => !isCleanFinalState(observedStates[scanner]),
        );

        expect(entry.requiredAggregateDisposition).toBe("reject");
        expect(detectingScanners.length).toBeGreaterThan(0);
        expect(nonCleanScanners).toEqual(detectingScanners);
        for (const scanner of detectingScanners) {
          expect(isCleanFinalState(observedStates[scanner])).toBe(false);
        }
        return;
      }

      expect(entry.requiredAggregateDisposition).not.toBe("reject");
      for (const scanner of scannerNames) {
        expect(observedStates[scanner]).toEqual(cleanFinalState);
      }
    },
  );

  it("preserves quoted and escaped operators across deterministic adversarial cases", () => {
    const operators = ["&&", "||", "|", ";"];
    const escapedOutcomes: Record<string, string[]> = {
      "&&": [String.raw`echo left \&& right`],
      "||": [String.raw`echo left \|`, "right"],
      "|": [String.raw`echo left \| right`],
      ";": [String.raw`echo left \; right`],
    };
    const quotePairs = [
      ["'", "'"],
      ['"', '"'],
    ] as const;

    for (const operator of operators) {
      for (const [open, close] of quotePairs) {
        const command = `echo ${open}left ${operator} right${close}`;
        expect(splitCompoundCommand(command)).toEqual([command]);
      }

      const escaped = `echo left \\${operator} right`;
      expect(splitCompoundCommand(escaped)).toEqual(escapedOutcomes[operator]);
    }
  });

  it("documents current fail-open parsing for malformed input separately from policy", () => {
    // B1a records the target reject disposition as characterization data only;
    // this keeps today's non-enforcement visible until the B1b production slice.
    const malformed = corpus.filter(
      ({ lexicalClass }) => lexicalClass === "malformed",
    );

    expect(malformed.length).toBeGreaterThan(0);
    for (const entry of malformed) {
      const observation = observe(entry.command);
      expect(entry.requiredAggregateDisposition).toBe("reject");
      expect(observation).toMatchObject({
        interactive: false,
        protectedWrite: false,
      });
    }
  });
});
