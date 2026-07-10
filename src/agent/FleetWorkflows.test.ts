import { describe, expect, it } from "vitest";
import { parseFleetResultEnvelope, planFleetWorkflow } from "./FleetWorkflows.js";

describe("fleet workflows", () => {
  it("builds structured review and verification delegations", () => {
    expect(
      planFleetWorkflow({
        kind: "structured_diff_review",
        task: "Review",
        message: "Review the diff",
      }).delegations[0],
    ).toEqual(
      expect.objectContaining({
        mode: "review",
        permissionProfile: "review-only",
        expectedResult: "review_findings",
      }),
    );
    expect(
      planFleetWorkflow({
        kind: "browser_verification",
        task: "Verify",
        message: "Verify in browser",
      }).delegations[0].expectedResult,
    ).toBe("verification");
  });

  it("isolates every best-of-N candidate", () => {
    const plan = planFleetWorkflow({
      kind: "best_of_n",
      task: "Implement",
      message: "Implement it",
      candidates: [{ model: "one" }, { model: "two" }, { model: "three" }],
    });
    expect(plan.delegations).toHaveLength(3);
    expect(plan.delegations.every((item) => item.worktree === "isolated")).toBe(true);
  });

  it("creates goal-scoped budgets and parses structured evidence", () => {
    const plan = planFleetWorkflow({
      kind: "persistent_goal",
      task: "Goal",
      message: "Complete goal",
      budget: { maxTokens: 1000 },
    });
    expect(plan.goalId).toMatch(/^goal:/);
    expect(plan.delegations[0].budget?.scope).toBe("goal");
    expect(
      parseFleetResultEnvelope(
        "verification",
        JSON.stringify({ type: "verification", passed: true, summary: "ok" }),
      ),
    ).toEqual({ type: "verification", passed: true, summary: "ok" });
  });
});
