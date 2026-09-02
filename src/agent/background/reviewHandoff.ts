import type { AgentBudget } from "../../core/capabilities/background.js";
import type { ReviewScopeHandoff } from "../reviewScopeSnapshot.js";

export interface BuildReviewHandoffOptions {
  message: string;
  target?: ReviewScopeHandoff;
  budget?: AgentBudget;
}

function renderBudget(budget: AgentBudget | undefined): string | undefined {
  if (!budget) return undefined;
  const limits = [
    budget.maxToolCalls !== undefined
      ? `${budget.maxToolCalls} tool calls`
      : undefined,
    budget.maxApiTurns !== undefined
      ? `${budget.maxApiTurns} model turns`
      : undefined,
    budget.maxElapsedMs !== undefined
      ? `${Math.max(1, Math.round(budget.maxElapsedMs / 60_000))} minutes`
      : undefined,
  ].filter((value): value is string => Boolean(value));
  return limits.length > 0 ? limits.join(", ") : undefined;
}

/** Compose the same compact, bounded review brief for native and ACP agents. */
export function buildReviewHandoff(options: BuildReviewHandoffOptions): string {
  const budget = renderBudget(options.budget);
  return [
    "## Review goal",
    "",
    options.message.trim(),
    options.target?.content ? `\n${options.target.content}` : undefined,
    "",
    "## Review boundaries",
    "",
    "Review the target and only the directly affected callers, dependencies, and tests needed to validate a concrete correctness, safety, compatibility, or maintainability risk. Do not explore adjacent subsystems for general confidence. Prefer a few evidence-backed findings over broad commentary, and return no findings rather than inventing criticism.",
    budget
      ? `Planned budget: ${budget}. Treat these as completion limits: prioritize the highest-risk hypotheses and finish within them unless one additional check is necessary to substantiate a critical or high-severity finding.`
      : undefined,
    "Finish as soon as the target and its direct impact are understood. Cite workspace-relative paths and lines where practical.",
  ]
    .filter((section): section is string => section !== undefined)
    .join("\n");
}
