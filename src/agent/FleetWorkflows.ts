import { randomUUID } from "crypto";
import type { AgentBudget, SpawnBackgroundRequest } from "../core/capabilities/background.js";

export type FleetWorkflowKind =
  | "structured_diff_review"
  | "browser_verification"
  | "best_of_n"
  | "persistent_goal";

export interface FleetWorkflowRequest {
  kind: FleetWorkflowKind;
  task: string;
  message: string;
  candidates?: Array<{ model?: string; provider?: string }>;
  goalId?: string;
  budget?: AgentBudget;
}

export interface FleetWorkflowPlan {
  workflowId: string;
  goalId?: string;
  delegations: SpawnBackgroundRequest[];
}

/** Builds higher-autonomy workflows exclusively from normal fleet delegations. */
export function planFleetWorkflow(request: FleetWorkflowRequest): FleetWorkflowPlan {
  const workflowId = randomUUID();
  const goalId =
    request.kind === "persistent_goal"
      ? request.goalId?.trim() || `goal:${workflowId}`
      : request.goalId?.trim() || undefined;
  const base: SpawnBackgroundRequest = {
    task: request.task,
    message: request.message,
    goalId,
    budget: request.budget,
  };
  if (request.kind === "structured_diff_review") {
    return {
      workflowId,
      goalId,
      delegations: [
        {
          ...base,
          mode: "review",
          taskClass: "review_code",
          permissionProfile: "review-only",
          expectedResult: "review_findings",
        },
      ],
    };
  }
  if (request.kind === "browser_verification") {
    return {
      workflowId,
      goalId,
      delegations: [
        {
          ...base,
          mode: "code",
          taskClass: "verification",
          permissionProfile: "workspace-safe",
          expectedResult: "verification",
        },
      ],
    };
  }
  if (request.kind === "best_of_n") {
    const candidates = request.candidates?.length
      ? request.candidates
      : [{}, {}];
    return {
      workflowId,
      goalId,
      delegations: candidates.map((candidate, index) => ({
        ...base,
        task: `${request.task} · candidate ${index + 1}`,
        mode: "code",
        model: candidate.model,
        provider: candidate.provider,
        worktree: "isolated",
        expectedResult: "patch",
      })),
    };
  }
  return {
    workflowId,
    goalId,
    delegations: [
      {
        ...base,
        mode: "code",
        taskClass: "general",
        permissionProfile: "workspace-safe",
        budget: request.budget
          ? { ...request.budget, scope: "goal" }
          : undefined,
      },
    ],
  };
}

export type FleetResultEnvelope =
  | { type: "text"; text: string }
  | {
      type: "review_findings";
      findings: Array<{
        severity: "critical" | "high" | "medium" | "low";
        message: string;
        path?: string;
        line?: number;
      }>;
    }
  | { type: "patch"; summary: string; files: string[]; verification?: string }
  | {
      type: "verification";
      passed: boolean;
      summary: string;
      screenshots?: string[];
      logs?: string[];
    };

export function parseFleetResultEnvelope(
  expected: SpawnBackgroundRequest["expectedResult"],
  text: string,
): FleetResultEnvelope {
  if (expected && expected !== "text") {
    try {
      const parsed = JSON.parse(text) as FleetResultEnvelope;
      if (parsed.type === expected) return parsed;
    } catch {
      // Preserve useful evidence as text if the backend did not emit JSON.
    }
  }
  return { type: "text", text };
}
