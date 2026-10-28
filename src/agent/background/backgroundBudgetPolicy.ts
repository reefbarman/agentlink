import { isReviewTaskClass, normalizeTaskClass } from "./reviewTaskClass.js";

import type { SpawnBackgroundRequest } from "../backgroundTypes.js";

const RESEARCH_TASK_CLASSES = new Set(["research", "readonly-research"]);

export function isResearchTaskClass(taskClass: string | undefined): boolean {
  return RESEARCH_TASK_CLASSES.has(normalizeTaskClass(taskClass));
}

/**
 * Task classes whose usage counts toward a deliberately configured shared
 * (subtree or goal) budget owned by another session.
 *
 * Background agents never receive an automatic budget: the foreground
 * coordinator supervises progress through status and steering. Only budgets a
 * caller explicitly requests are enforced.
 */
export function isSharedBudgetMemberTaskClass(
  taskClass: string | undefined,
): boolean {
  return isReviewTaskClass(taskClass) || isResearchTaskClass(taskClass);
}

/**
 * Review cost tier must be an explicit caller or routing-policy decision.
 * Task wording is not a reliable reason to silently select a more expensive model.
 */
export function inferReviewTier(
  request: Pick<SpawnBackgroundRequest, "taskClass">,
): "balanced" | undefined {
  return isReviewTaskClass(request.taskClass) ? "balanced" : undefined;
}
