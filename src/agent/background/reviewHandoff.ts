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
      ? `Requested resource limit: ${budget}. The delegating agent set this deliberately; the run is stopped at a hard boundary beyond it, so prioritize the highest-risk hypotheses first.`
      : undefined,
    "There is no automatic time or resource deadline. Take the time a meaningful review needs, and finish as soon as the target and its direct impact are understood. If the coordinator asks for progress, briefly say what you have established, what material question remains, and what your next step will resolve, then continue. Cite workspace-relative paths and lines where practical.",
  ]
    .filter((section): section is string => section !== undefined)
    .join("\n");
}
