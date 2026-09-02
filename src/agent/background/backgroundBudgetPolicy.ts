import type {
  AgentBudget,
  ModelTier,
  SpawnBackgroundRequest,
} from "../backgroundTypes.js";
import { isReviewTaskClass, normalizeTaskClass } from "./reviewTaskClass.js";

const RESEARCH_TASK_CLASSES = new Set(["research", "readonly-research"]);

const RESEARCH_BUDGETS: Record<ModelTier, AgentBudget> = {
  cheap: {
    maxToolCalls: 24,
    maxApiTurns: 10,
    maxElapsedMs: 360_000,
    warningThresholdRatio: 0.8,
  },
  balanced: {
    maxToolCalls: 48,
    maxApiTurns: 16,
    maxElapsedMs: 600_000,
    warningThresholdRatio: 0.8,
  },
  deep_reasoning: {
    maxToolCalls: 72,
    maxApiTurns: 24,
    maxElapsedMs: 900_000,
    warningThresholdRatio: 0.8,
  },
};

const REVIEW_BUDGETS: Record<ModelTier, AgentBudget> = {
  cheap: {
    maxToolCalls: 50,
    maxApiTurns: 25,
    maxElapsedMs: 900_000,
    warningThresholdRatio: 0.8,
  },
  balanced: {
    maxToolCalls: 100,
    maxApiTurns: 50,
    maxElapsedMs: 1_800_000,
    warningThresholdRatio: 0.8,
  },
  deep_reasoning: {
    maxToolCalls: 150,
    maxApiTurns: 75,
    maxElapsedMs: 2_700_000,
    warningThresholdRatio: 0.8,
  },
};

export function isResearchTaskClass(taskClass: string | undefined): boolean {
  return RESEARCH_TASK_CLASSES.has(normalizeTaskClass(taskClass));
}

export function isAutomaticallyBudgetedTaskClass(
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
): ModelTier | undefined {
  return isReviewTaskClass(request.taskClass) ? "balanced" : undefined;
}

export function getAutomaticBackgroundBudget(
  taskClass: string | undefined,
  tier: ModelTier,
): AgentBudget | undefined {
  if (isReviewTaskClass(taskClass)) return { ...REVIEW_BUDGETS[tier] };
  if (isResearchTaskClass(taskClass)) return { ...RESEARCH_BUDGETS[tier] };
  return undefined;
}
