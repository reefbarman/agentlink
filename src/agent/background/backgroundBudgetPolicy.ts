import type {
  AgentBudget,
  ModelTier,
  SpawnBackgroundRequest,
} from "../backgroundTypes.js";
import { isReviewTaskClass, normalizeTaskClass } from "./reviewTaskClass.js";

const RESEARCH_TASK_CLASSES = new Set(["research", "readonly-research"]);

const AUTOMATIC_BUDGETS: Record<ModelTier, AgentBudget> = {
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

export function isResearchTaskClass(taskClass: string | undefined): boolean {
  return RESEARCH_TASK_CLASSES.has(normalizeTaskClass(taskClass));
}

export function isAutomaticallyBudgetedTaskClass(
  taskClass: string | undefined,
): boolean {
  return isReviewTaskClass(taskClass) || isResearchTaskClass(taskClass);
}

export function inferReviewTier(
  request: Pick<SpawnBackgroundRequest, "task" | "message" | "taskClass">,
): ModelTier | undefined {
  if (!isReviewTaskClass(request.taskClass)) return undefined;

  const text = `${request.task}\n${request.message}`.toLowerCase();
  const deepSignals = [
    /\bcomplex\b/,
    /\bcritical\b/,
    /\bsecurity\b/,
    /\brisky?\b/,
    /\bdeep\s+review\b/,
    /\barchitecture\b/,
    /\bprincipal[-\s]engineer\b/,
    /\bcross[- ](cutting|system|module)\b/,
    /\bdata integrity\b/,
    /\bproduction\b/,
  ];

  return deepSignals.some((pattern) => pattern.test(text))
    ? "deep_reasoning"
    : "balanced";
}

export function getAutomaticBackgroundBudget(
  taskClass: string | undefined,
  tier: ModelTier,
): AgentBudget | undefined {
  if (!isAutomaticallyBudgetedTaskClass(taskClass)) return undefined;
  return { ...AUTOMATIC_BUDGETS[tier] };
}
