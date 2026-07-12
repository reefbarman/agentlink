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

const workspace = path.resolve("/workspace/project");

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
    | "unsupported";
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
  },
  {
    name: "quoted heredoc delimiter",
    command: "cat <<'EOF' > generated.txt\nhello; world\nEOF",
    split: ["cat <<'EOF' > generated.txt", "hello", "world", "EOF"],
    tier: "dangerous",
    interactive: false,
    pipe: "direct",
    protectedWrite: false,
    difference: "unsupported",
  },
  {
    name: "separator inside command substitution",
    command: "echo $(echo first; rm -rf tmp)",
    split: ["echo $(echo first", "rm -rf tmp)"],
    tier: "dangerous",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "unsupported",
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
  },
  {
    name: "dangling escape",
    command: "echo trailing\\",
    split: ["echo trailing\\"],
    tier: "safe",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "unsupported",
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
  },
  {
    name: "grouped shell expression",
    command: "(echo first; echo second)",
    split: ["(echo first", "echo second)"],
    tier: "sensitive",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "unsupported",
  },
  {
    name: "unterminated quote",
    command: `echo "unterminated && rm -rf tmp`,
    split: [`echo "unterminated && rm -rf tmp`],
    tier: "safe",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "unsupported",
  },
  {
    name: "unsupported background operator",
    command: "npm test & echo done",
    split: ["npm test & echo done"],
    tier: "dangerous",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "unsupported",
  },
  {
    name: "PowerShell environment syntax",
    command: "$env:NODE_ENV = 'test'; npm test",
    split: ["$env:NODE_ENV = 'test'", "npm test"],
    tier: "dangerous",
    interactive: false,
    pipe: null,
    protectedWrite: false,
    difference: "unsupported",
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
  };
}

describe("shell lexical differential corpus", () => {
  it.each(corpus)("records $difference behavior for $name", (entry) => {
    expect(observe(entry.command)).toEqual({
      split: entry.split,
      tier: entry.tier,
      interactive: entry.interactive,
      pipe: entry.pipe,
      protectedWrite: entry.protectedWrite,
    });
  });

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

  it("documents current fail-open parsing for malformed quotes separately from policy", () => {
    const malformed = corpus.find(({ name }) => name === "unterminated quote");
    expect(malformed?.difference).toBe("unsupported");
    expect(observe(malformed!.command)).toMatchObject({
      tier: "safe",
      interactive: false,
      pipe: null,
      protectedWrite: false,
    });
  });
});
