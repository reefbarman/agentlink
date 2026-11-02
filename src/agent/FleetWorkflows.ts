import type {
  AgentBudget,
  SpawnBackgroundRequest,
} from "../core/capabilities/background.js";

import type { FleetResultEnvelope } from "@agentlink/protocol/fleet-result";

// Envelope parsing and formatting live in core so every surface reads a
// background result the same way.
export {
  MAX_REVIEW_CHECKED_ITEMS,
  MAX_REVIEW_CHECKED_ITEM_CHARS,
  formatFleetResultEnvelope,
  isFleetResultEnvelope,
  parseFleetResultEnvelope,
  parseFleetResultEnvelopeDetailed,
  withFleetResultInstruction,
  type FleetEnvelopeParseOptions,
  type FleetEnvelopeParseResult,
  type FleetResultFormatOptions,
} from "@agentlink/core/background-results";

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

export interface FleetWorkflowOutcome {
  workflowId: string;
  kind: FleetWorkflowKind;
  completed: boolean;
  candidates: Array<{
    sessionId: string;
    result: FleetResultEnvelope;
    worktreePath?: string;
    worktreeBranch?: string;
    score?: number;
  }>;
  winnerSessionId?: string;
  summary: string;
}

/** Builds higher-autonomy workflows exclusively from normal fleet delegations. */
export function planFleetWorkflow(
  request: FleetWorkflowRequest,
): FleetWorkflowPlan {
  const workflowId = globalThis.crypto.randomUUID();
  const goalId =
    request.kind === "persistent_goal"
      ? request.goalId?.trim() || `goal:${workflowId}`
      : request.goalId?.trim() || undefined;
  const base: SpawnBackgroundRequest = {
    task: request.task,
    message: request.message,
    goalId,
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
          budget: request.budget,
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
      },
    ],
  };
}

export function scoreFleetCandidate(result: FleetResultEnvelope): number {
  if (result.type === "patch") {
    return 100 + result.files.length * 5 + (result.verification ? 25 : 0);
  }
  if (result.type === "verification") {
    return (
      (result.passed ? 100 : 0) +
      (result.screenshots?.length ?? 0) * 5 +
      (result.logs?.length ?? 0)
    );
  }
  if (result.type === "review_findings") {
    if (result.emptyDiff) return 0;
    return Math.max(0, 50 - result.findings.length);
  }
  return Math.min(25, result.text.trim().length / 100);
}
