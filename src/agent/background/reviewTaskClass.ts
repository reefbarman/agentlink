const REVIEW_TASK_CLASS_PREFIX = "review_";

/** Canonical rule key applied to any review task class without its own rule. */
export const BASE_REVIEW_TASK_CLASS = "review_code";

export function normalizeTaskClass(taskClass: string | undefined): string {
  return taskClass?.trim().toLowerCase() ?? "";
}

/**
 * Shared review predicate. Both the backend router and the model router must
 * agree, otherwise a configured review target can be honored by one layer and
 * silently skipped by the other.
 */
export function isReviewTaskClass(taskClass: string | undefined): boolean {
  return normalizeTaskClass(taskClass).startsWith(REVIEW_TASK_CLASS_PREFIX);
}
