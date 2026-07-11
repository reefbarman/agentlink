import type {
  AgentBudget,
  SpawnBackgroundRequest,
} from "../core/capabilities/background.js";

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
      /** What was actually reviewed, e.g. a commit range or file list. */
      reviewedScope?: string;
      /** True when the requested diff was empty or missing, so an empty findings list is not a clean review. */
      emptyDiff?: boolean;
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
      const parsed = JSON.parse(text) as unknown;
      if (isFleetResultEnvelope(parsed) && parsed.type === expected)
        return parsed;
    } catch {
      // Preserve useful evidence as text if the backend did not emit JSON.
    }
  }
  return { type: "text", text };
}

export function isFleetResultEnvelope(
  value: unknown,
): value is FleetResultEnvelope {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (result.type === "text") return typeof result.text === "string";
  if (result.type === "patch") {
    return (
      typeof result.summary === "string" &&
      isStringArray(result.files) &&
      result.files.every(isWorkspaceRelativeArtifact) &&
      (result.verification === undefined ||
        typeof result.verification === "string")
    );
  }
  if (result.type === "verification") {
    return (
      typeof result.passed === "boolean" &&
      typeof result.summary === "string" &&
      (result.screenshots === undefined ||
        (isStringArray(result.screenshots) &&
          result.screenshots.every(isWorkspaceRelativeArtifact))) &&
      (result.logs === undefined || isStringArray(result.logs))
    );
  }
  if (result.type === "review_findings") {
    return (
      (result.reviewedScope === undefined ||
        typeof result.reviewedScope === "string") &&
      (result.emptyDiff === undefined ||
        typeof result.emptyDiff === "boolean") &&
      Array.isArray(result.findings) &&
      result.findings.every((finding) => {
        if (!finding || typeof finding !== "object") return false;
        const item = finding as Record<string, unknown>;
        return (
          ["critical", "high", "medium", "low"].includes(
            String(item.severity),
          ) &&
          typeof item.message === "string" &&
          (item.path === undefined ||
            (typeof item.path === "string" &&
              isWorkspaceRelativeArtifact(item.path))) &&
          (item.line === undefined ||
            (typeof item.line === "number" &&
              Number.isInteger(item.line) &&
              item.line > 0))
        );
      })
    );
  }
  return false;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isWorkspaceRelativeArtifact(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !/^[a-zA-Z]:\//.test(normalized) &&
    !normalized.split("/").includes("..")
  );
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

export function withFleetResultInstruction(
  expected: SpawnBackgroundRequest["expectedResult"],
  message: string,
): string {
  if (!expected || expected === "text") return message;
  const shapes = {
    review_findings:
      '{"type":"review_findings","findings":[{"severity":"critical|high|medium|low","message":"...","path":"optional","line":1}],"reviewedScope":"what was actually reviewed, e.g. a commit range or file list","emptyDiff":false}',
    patch:
      '{"type":"patch","summary":"...","files":["..."],"verification":"optional"}',
    verification:
      '{"type":"verification","passed":true,"summary":"...","screenshots":["optional paths"],"logs":["optional evidence"]}',
  } as const;
  const guidance =
    expected === "review_findings"
      ? " Before reviewing, resolve the exact change set you were asked to review and describe it in reviewedScope. If that change set is empty or cannot be found (for example the changes were already committed, stashed, or reverted), set emptyDiff to true and explain what you checked in reviewedScope — never return an empty findings list that is indistinguishable from a clean review."
      : "";
  return `${message}\n\nReturn the final answer as JSON matching this exact result envelope: ${shapes[expected]}${guidance}`;
}
