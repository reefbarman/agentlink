import type { CommandRule, CommandRuleDecision } from "./commandRuleTypes.js";
import type { RuleScope, ScopedRules } from "./ruleTypes.js";

import { scanShellLexTokens } from "../util/shellLex.js";
import { splitCompoundCommand } from "./commandSplitter.js";

export type EffectiveCommandRuleDecision = CommandRuleDecision | "unmatched";

export interface MatchedCommandRule {
  rule: CommandRule;
  scope: RuleScope;
}

export interface CommandSegmentRuleEvaluation {
  command: string;
  decision: EffectiveCommandRuleDecision;
  matches: MatchedCommandRule[];
  explicitlyAllowed: boolean;
}

export interface CommandRulePolicyEvaluation {
  decision: EffectiveCommandRuleDecision;
  segments: CommandSegmentRuleEvaluation[];
  allSegmentsExplicitlyAllowed: boolean;
  allSegmentsApprovedByRule: boolean;
}

export function commandRulePolicyFingerprint(
  evaluation: CommandRulePolicyEvaluation,
): string {
  return JSON.stringify({
    decision: evaluation.decision,
    allSegmentsExplicitlyAllowed: evaluation.allSegmentsExplicitlyAllowed,
    allSegmentsApprovedByRule: evaluation.allSegmentsApprovedByRule,
    segments: evaluation.segments.map((segment) => ({
      command: segment.command,
      decision: segment.decision,
      explicitlyAllowed: segment.explicitlyAllowed,
      matches: segment.matches.map(({ rule, scope }) => ({
        scope,
        pattern: rule.pattern,
        mode: rule.mode,
        decision: rule.decision ?? "allow",
      })),
    })),
  });
}

const DECISION_PRIORITY: Record<EffectiveCommandRuleDecision, number> = {
  unmatched: 0,
  allow: 1,
  prompt: 2,
  forbidden: 3,
};

/**
 * Exact fixture from openai/codex
 * codex-rs/core/src/exec_policy.rs at
 * bdd3118c71a29f26b9df3a47f91efea38a0d58bd.
 */
export const CODEX_BANNED_PREFIX_SUGGESTIONS: readonly (readonly string[])[] = [
  ["/bin/bash"],
  ["/bin/bash", "-c"],
  ["/bin/bash", "-lc"],
  ["/bin/sh"],
  ["/bin/sh", "-c"],
  ["/bin/sh", "-lc"],
  ["/bin/zsh"],
  ["/bin/zsh", "-c"],
  ["/bin/zsh", "-lc"],
  ["Rscript"],
  ["bash"],
  ["bash", "-c"],
  ["bash", "-lc"],
  ["bun"],
  ["bun", "-e"],
  ["bun", "run"],
  ["cmd"],
  ["cmd", "/c"],
  ["cmd", "/k"],
  ["cmd.exe"],
  ["cmd.exe", "/c"],
  ["cmd.exe", "/k"],
  ["dash"],
  ["dash", "-c"],
  ["deno"],
  ["deno", "eval"],
  ["env"],
  ["fish"],
  ["fish", "-c"],
  ["git"],
  ["julia"],
  ["julia", "-e"],
  ["ksh"],
  ["ksh", "-c"],
  ["lua"],
  ["lua", "-e"],
  ["node"],
  ["node", "-e"],
  ["nodejs"],
  ["nodejs", "-e"],
  ["npm", "run"],
  ["osascript"],
  ["perl"],
  ["perl", "-e"],
  ["php"],
  ["php", "-r"],
  ["pnpm", "run"],
  ["powershell"],
  ["powershell", "-Command"],
  ["powershell", "-EncodedCommand"],
  ["powershell", "-File"],
  ["powershell", "-c"],
  ["powershell.exe"],
  ["powershell.exe", "-Command"],
  ["powershell.exe", "-EncodedCommand"],
  ["powershell.exe", "-File"],
  ["powershell.exe", "-c"],
  ["pwsh"],
  ["pwsh", "-Command"],
  ["pwsh", "-EncodedCommand"],
  ["pwsh", "-File"],
  ["pwsh", "-c"],
  ["pwsh", "-e"],
  ["pwsh", "-ec"],
  ["pwsh", "-f"],
  ["py"],
  ["py", "-3"],
  ["pypy"],
  ["pypy3"],
  ["python"],
  ["python", "-"],
  ["python", "-c"],
  ["python3"],
  ["python3", "-"],
  ["python3", "-c"],
  ["pythonw"],
  ["pyw"],
  ["rm"],
  ["ruby"],
  ["ruby", "-e"],
  ["sh"],
  ["sh", "-c"],
  ["sh", "-lc"],
  ["sudo"],
  ["yarn", "run"],
  ["zsh"],
  ["zsh", "-c"],
  ["zsh", "-lc"],
] as const;

export function isBannedCommandRulePrefixSuggestion(
  commandPrefix: string,
): boolean {
  const parsed = scanShellLexTokens(commandPrefix.trim());
  if (
    parsed.finalState.quote !== null ||
    parsed.finalState.danglingEscape ||
    parsed.tokens.length === 0
  ) {
    return true;
  }
  return CODEX_BANNED_PREFIX_SUGGESTIONS.some(
    (banned) =>
      banned.length === parsed.tokens.length &&
      banned.every((token, index) => token === parsed.tokens[index]),
  );
}

// Compiled-regex cache for regex-mode rules. Rule patterns are static user
// configuration evaluated for every proposed command, so compiling per check
// (× segments × scopes) is wasted work. Bounded as a safety valve.
const compiledRuleRegexCache = new Map<string, RegExp>();
const COMPILED_RULE_REGEX_CACHE_MAX = 500;

function compiledRuleRegex(pattern: string): RegExp {
  const cached = compiledRuleRegexCache.get(pattern);
  if (cached) return cached;
  const compiled = new RegExp(pattern);
  if (compiledRuleRegexCache.size >= COMPILED_RULE_REGEX_CACHE_MAX) {
    compiledRuleRegexCache.clear();
  }
  compiledRuleRegexCache.set(pattern, compiled);
  return compiled;
}

export function commandRuleMatches(
  command: string,
  rule: CommandRule,
): boolean {
  try {
    switch (rule.mode) {
      case "exact":
        return command.trim() === rule.pattern.trim();
      case "prefix": {
        const pattern = scanShellLexTokens(rule.pattern.trim());
        const candidate = scanShellLexTokens(command.trim());
        if (
          pattern.finalState.quote !== null ||
          pattern.finalState.danglingEscape ||
          candidate.finalState.quote !== null ||
          candidate.finalState.danglingEscape
        ) {
          return false;
        }
        return (
          pattern.tokens.length > 0 &&
          pattern.tokens.length <= candidate.tokens.length &&
          pattern.tokens.every(
            (token, index) => token === candidate.tokens[index],
          )
        );
      }
      case "regex":
        return compiledRuleRegex(rule.pattern).test(command.trim());
    }
  } catch {
    return false;
  }
}

export function evaluateCommandSegmentRules(
  rulesByScope: ScopedRules<CommandRule>,
  command: string,
): CommandSegmentRuleEvaluation {
  const matches: MatchedCommandRule[] = [];
  for (const scope of ["session", "project", "global"] as const) {
    for (const rule of rulesByScope[scope]) {
      if (commandRuleMatches(command, rule)) matches.push({ rule, scope });
    }
  }

  let decision: EffectiveCommandRuleDecision = "unmatched";
  for (const { rule } of matches) {
    const candidate: EffectiveCommandRuleDecision = rule.decision ?? "allow";
    if (DECISION_PRIORITY[candidate] > DECISION_PRIORITY[decision]) {
      decision = candidate;
    }
  }

  return {
    command,
    decision,
    matches,
    explicitlyAllowed: decision === "allow",
  };
}

export function evaluateCommandRulePolicy(
  rulesByScope: ScopedRules<CommandRule>,
  fullCommand: string,
): CommandRulePolicyEvaluation {
  // Only top-level, safely recognized shell boundaries are segmented. Quoted or
  // wrapped scripts remain opaque command text and require an explicit match.
  const commands = splitCompoundCommand(fullCommand);
  const segments = (commands.length > 0 ? commands : [fullCommand.trim()]).map(
    (command) => evaluateCommandSegmentRules(rulesByScope, command),
  );

  let decision: EffectiveCommandRuleDecision = "unmatched";
  for (const segment of segments) {
    if (DECISION_PRIORITY[segment.decision] > DECISION_PRIORITY[decision]) {
      decision = segment.decision;
    }
  }

  return {
    decision,
    segments,
    allSegmentsExplicitlyAllowed:
      segments.length > 0 &&
      segments.every((segment) => segment.explicitlyAllowed),
    allSegmentsApprovedByRule:
      segments.length > 0 &&
      segments.every((segment) => segment.decision === "allow"),
  };
}
