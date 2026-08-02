import {
  CODEX_BANNED_PREFIX_SUGGESTIONS,
  commandRuleMatches,
  evaluateCommandRulePolicy,
  isBannedCommandRulePrefixSuggestion,
} from "./commandRulePolicy.js";
import { describe, expect, it } from "vitest";

import type { CommandRule } from "./CommandRuleStore.js";

function rules(input: {
  session?: CommandRule[];
  project?: CommandRule[];
  global?: CommandRule[];
}) {
  return {
    session: input.session ?? [],
    project: input.project ?? [],
    global: input.global ?? [],
  };
}

describe("commandRulePolicy", () => {
  it("uses most-restrictive-wins across every scope and matching rule", () => {
    const evaluation = evaluateCommandRulePolicy(
      rules({
        session: [
          {
            pattern: "npm test -- --runInBand",
            mode: "exact",
            decision: "allow",
          },
        ],
        project: [{ pattern: "npm test", mode: "prefix", decision: "prompt" }],
        global: [{ pattern: "npm", mode: "prefix", decision: "forbidden" }],
      }),
      "npm test -- --runInBand",
    );

    expect(evaluation.decision).toBe("forbidden");
    expect(evaluation.segments[0]?.matches).toHaveLength(3);
    expect(evaluation.allSegmentsExplicitlyAllowed).toBe(false);
  });

  it("requires an explicit allow for every parsed compound segment", () => {
    const partial = evaluateCommandRulePolicy(
      rules({
        session: [{ pattern: "npm test", mode: "exact", decision: "allow" }],
      }),
      "npm test && npm run lint",
    );
    expect(partial.decision).toBe("allow");
    expect(partial.allSegmentsExplicitlyAllowed).toBe(false);
    expect(partial.allSegmentsApprovedByRule).toBe(false);

    const complete = evaluateCommandRulePolicy(
      rules({
        session: [
          { pattern: "npm test", mode: "exact", decision: "allow" },
          { pattern: "npm run lint", mode: "exact", decision: "allow" },
        ],
      }),
      "npm test && npm run lint",
    );
    expect(complete.allSegmentsExplicitlyAllowed).toBe(true);
    expect(complete.allSegmentsApprovedByRule).toBe(true);
  });

  it("treats legacy trust rules as allow rules", () => {
    const evaluation = evaluateCommandRulePolicy(
      rules({
        project: [{ pattern: "dotnet build", mode: "exact" }],
      }),
      "dotnet build",
    );

    expect(evaluation.decision).toBe("allow");
    expect(evaluation.allSegmentsApprovedByRule).toBe(true);
    expect(evaluation.allSegmentsExplicitlyAllowed).toBe(true);
  });

  it("keeps quoted wrapped scripts as one opaque invocation", () => {
    const evaluation = evaluateCommandRulePolicy(
      rules({
        session: [
          { pattern: "rm", mode: "prefix", decision: "forbidden" },
          {
            pattern: "bash -lc 'echo ok && rm -rf generated'",
            mode: "exact",
            decision: "allow",
          },
        ],
      }),
      "bash -lc 'echo ok && rm -rf generated'",
    );

    expect(evaluation.segments).toHaveLength(1);
    expect(evaluation.segments[0]?.matches).toHaveLength(1);
    expect(evaluation.allSegmentsExplicitlyAllowed).toBe(true);
  });

  it("treats regex matches as allow authority", () => {
    const evaluation = evaluateCommandRulePolicy(
      rules({
        session: [
          {
            pattern: "^npm (?:test|run test)(?:\\s|$)",
            mode: "regex",
            decision: "allow",
          },
        ],
      }),
      "npm test",
    );

    expect(evaluation.decision).toBe("allow");
    expect(evaluation.allSegmentsApprovedByRule).toBe(true);
    expect(evaluation.allSegmentsExplicitlyAllowed).toBe(true);
  });

  it("requires a matching rule for complete wrapper commands", () => {
    const evaluation = evaluateCommandRulePolicy(
      rules({
        project: [
          { pattern: "timeout", mode: "exact", decision: "allow" },
          { pattern: "npm test", mode: "exact", decision: "allow" },
        ],
      }),
      "timeout 60 npm test",
    );

    expect(evaluation.segments.map((segment) => segment.command)).toEqual([
      "timeout 60 npm test",
    ]);
    expect(evaluation.decision).toBe("allow");
    expect(evaluation.allSegmentsExplicitlyAllowed).toBe(false);
  });

  it("does not grant wrapper arguments through separately allowed inner commands", () => {
    const evaluation = evaluateCommandRulePolicy(
      rules({
        project: [
          { pattern: "env", mode: "exact", decision: "allow" },
          { pattern: "npm test", mode: "exact", decision: "allow" },
        ],
      }),
      "env LD_PRELOAD=/tmp/untrusted.dylib npm test",
    );

    expect(evaluation.decision).toBe("allow");
    expect(evaluation.allSegmentsExplicitlyAllowed).toBe(false);
  });

  it("preserves Prompt and Forbidden rules for complete wrapper commands", () => {
    const evaluation = evaluateCommandRulePolicy(
      rules({
        project: [
          {
            pattern: "sudo npm publish",
            mode: "exact",
            decision: "forbidden",
          },
          { pattern: "sudo", mode: "exact", decision: "allow" },
          { pattern: "npm publish", mode: "exact", decision: "allow" },
        ],
      }),
      "sudo npm publish",
    );

    expect(evaluation.decision).toBe("forbidden");
    expect(evaluation.allSegmentsExplicitlyAllowed).toBe(false);
  });

  it("requires every wrapper-expanded command to be allowed", () => {
    const evaluation = evaluateCommandRulePolicy(
      rules({
        project: [{ pattern: "npm test", mode: "exact", decision: "allow" }],
      }),
      "timeout 60 npm test",
    );

    expect(evaluation.decision).toBe("allow");
    expect(evaluation.allSegmentsExplicitlyAllowed).toBe(false);
  });

  it("preserves Forbidden rules for intermediate nested wrappers", () => {
    const evaluation = evaluateCommandRulePolicy(
      rules({
        project: [
          { pattern: "sudo", mode: "exact", decision: "allow" },
          { pattern: "env", mode: "exact", decision: "forbidden" },
          { pattern: "npm test", mode: "exact", decision: "allow" },
        ],
      }),
      "sudo env FOO=1 npm test",
    );

    expect(evaluation.decision).toBe("forbidden");
    expect(evaluation.allSegmentsExplicitlyAllowed).toBe(false);
  });

  it("matches argv prefixes instead of string prefixes", () => {
    const rule: CommandRule = {
      pattern: "npm test",
      mode: "prefix",
      decision: "allow",
    };
    expect(commandRuleMatches("npm  test -- --runInBand", rule)).toBe(true);
    expect(commandRuleMatches("npm testing", rule)).toBe(false);
    expect(commandRuleMatches("npm run test", rule)).toBe(false);
  });

  it("contains the exact pinned Codex banned-prefix fixture", () => {
    expect(CODEX_BANNED_PREFIX_SUGGESTIONS).toHaveLength(88);
    expect(CODEX_BANNED_PREFIX_SUGGESTIONS).toContainEqual(["git"]);
    expect(CODEX_BANNED_PREFIX_SUGGESTIONS).toContainEqual(["npm", "run"]);
    expect(CODEX_BANNED_PREFIX_SUGGESTIONS).toContainEqual([
      "powershell",
      "-EncodedCommand",
    ]);
    expect(CODEX_BANNED_PREFIX_SUGGESTIONS).toContainEqual(["python3", "-"]);
    expect(CODEX_BANNED_PREFIX_SUGGESTIONS).toContainEqual(["zsh", "-lc"]);
  });

  it.each([
    "git",
    "npm run",
    "python -c",
    "powershell -EncodedCommand",
    "sudo",
  ])("suppresses the pinned broad suggestion %s", (prefix) => {
    expect(isBannedCommandRulePrefixSuggestion(prefix)).toBe(true);
  });

  it.each(["git status", "npm test", "python -m pytest", "cargo test"])(
    "does not suppress the narrower suggestion %s",
    (prefix) => {
      expect(isBannedCommandRulePrefixSuggestion(prefix)).toBe(false);
    },
  );
});
