import { describe, expect, it } from "vitest";
import {
  formatFleetResultEnvelope,
  parseFleetResultEnvelope,
  planFleetWorkflow,
  scoreFleetCandidate,
  withFleetResultInstruction,
} from "./FleetWorkflows.js";

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

  it("scores verified patches above unverified or plain-text candidates", () => {
    expect(
      scoreFleetCandidate({
        type: "patch",
        summary: "done",
        files: ["a.ts"],
        verification: "tests pass",
      }),
    ).toBeGreaterThan(
      scoreFleetCandidate({ type: "text", text: "looks plausible" }),
    );
  });

  it("runs best-of-N candidates as ordinary background agents", () => {
    const plan = planFleetWorkflow({
      kind: "best_of_n",
      task: "Implement",
      message: "Implement it",
      candidates: [{ model: "one" }, { model: "two" }, { model: "three" }],
    });
    expect(plan.delegations).toHaveLength(3);
    expect(plan.delegations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "one", expectedResult: "patch" }),
        expect.objectContaining({ model: "two", expectedResult: "patch" }),
        expect.objectContaining({ model: "three", expectedResult: "patch" }),
      ]),
    );
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
    expect(withFleetResultInstruction("verification", "Verify it")).toContain(
      '"type":"verification"',
    );
  });

  it("distinguishes empty-diff reviews from clean reviews", () => {
    const emptyDiffEnvelope = {
      type: "review_findings" as const,
      findings: [],
      reviewedScope: "git diff HEAD -- src/indexer was empty",
      emptyDiff: true,
    };
    expect(
      parseFleetResultEnvelope(
        "review_findings",
        JSON.stringify(emptyDiffEnvelope),
      ),
    ).toEqual(emptyDiffEnvelope);
    expect(scoreFleetCandidate(emptyDiffEnvelope)).toBe(0);
    expect(
      scoreFleetCandidate({ type: "review_findings", findings: [] }),
    ).toBeGreaterThan(scoreFleetCandidate(emptyDiffEnvelope));
    const instruction = withFleetResultInstruction(
      "review_findings",
      "Review it",
    );
    expect(instruction).toContain("emptyDiff");
    expect(instruction).toContain("reviewedScope");
  });

  it("formats structured review results as readable markdown", () => {
    expect(
      formatFleetResultEnvelope({
        type: "review_findings",
        findings: [
          {
            severity: "high",
            message: "The checkpoint can be lost.",
            path: "src/indexer/workerLib.ts",
            line: 42,
          },
        ],
        reviewedScope: "abc123..def456",
        emptyDiff: false,
      }),
    ).toContain(
      "**HIGH** — `src/indexer/workerLib.ts:42`: The checkpoint can be lost.",
    );
  });

  it("rejects malformed envelopes and artifact paths outside the workspace", () => {
    const raw = JSON.stringify({
      type: "verification",
      passed: true,
      summary: "ok",
      screenshots: ["../../outside.png"],
    });
    expect(parseFleetResultEnvelope("verification", raw)).toEqual({
      type: "text",
      text: raw,
    });
    expect(
      parseFleetResultEnvelope(
        "review_findings",
        JSON.stringify({
          type: "review_findings",
          findings: [{ severity: "urgent", message: "bad" }],
        }),
      ).type,
    ).toBe("text");
    expect(
      parseFleetResultEnvelope(
        "review_findings",
        JSON.stringify({
          type: "review_findings",
          findings: [],
          emptyDiff: "yes",
        }),
      ).type,
    ).toBe("text");
  });
});
