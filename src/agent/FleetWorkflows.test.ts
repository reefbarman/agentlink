import { describe, expect, it } from "vitest";
import {
  formatFleetResultEnvelope,
  parseFleetResultEnvelope,
  parseFleetResultEnvelopeDetailed,
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

  it("recovers one valid expected envelope from a fenced final response", () => {
    const envelope = {
      type: "review_findings" as const,
      findings: [
        {
          severity: "high" as const,
          message: "The worker can stop before finalization completes.",
          path: "src/indexer/worker.ts",
          line: 1347,
        },
      ],
      reviewedScope: "src/indexer worker shutdown and context health",
      emptyDiff: false,
    };

    for (const response of [
      `The review is complete.\n\n\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\``,
      `Findings follow.\r\n\r\n~~~ JSON \r\n${JSON.stringify(envelope)}\r\n~~~`,
      `Outer commentary.\n\n\`\`\`\`\n\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\`\n\`\`\`\`\n\n~~~json\n${JSON.stringify(envelope)}\n~~~`,
    ]) {
      expect(parseFleetResultEnvelope("review_findings", response)).toEqual(
        envelope,
      );
    }
  });

  it("salvages envelopes from repeated, mislabeled, unclosed, or unfenced output", () => {
    const parsed = {
      type: "review_findings" as const,
      findings: [],
      reviewedScope: "src/agent",
      emptyDiff: false,
    };
    const envelope = JSON.stringify(parsed);
    const revised = JSON.stringify({ ...parsed, reviewedScope: "src/core" });

    // The last occurrence is the agent's answer when the envelope repeats.
    expect(
      parseFleetResultEnvelope(
        "review_findings",
        `\`\`\`json\n${envelope}\n\`\`\`\n\n\`\`\`json\n${revised}\n\`\`\``,
      ),
    ).toEqual({ ...parsed, reviewedScope: "src/core" });
    // Truncation or a stream cut can eat the closing fence.
    expect(
      parseFleetResultEnvelope("review_findings", `\`\`\`json\n${envelope}`),
    ).toEqual(parsed);
    // Payload on the opener line and json-family info strings.
    expect(
      parseFleetResultEnvelope(
        "review_findings",
        `\`\`\`json ${envelope}\`\`\``,
      ),
    ).toEqual(parsed);
    expect(
      parseFleetResultEnvelope(
        "review_findings",
        `\`\`\`jsonc\n${envelope}\n\`\`\``,
      ),
    ).toEqual(parsed);
    // No json fence at all: the brace scan recovers mislabeled or bare JSON.
    expect(
      parseFleetResultEnvelope(
        "review_findings",
        `\`\`\`typescript\n${envelope}\n\`\`\``,
      ),
    ).toEqual(parsed);
    expect(
      parseFleetResultEnvelope("review_findings", `Final result: ${envelope}`),
    ).toEqual(parsed);
  });

  it("fails closed when fenced JSON exists but no candidate validates", () => {
    const envelope = JSON.stringify({
      type: "review_findings",
      findings: [],
      reviewedScope: "src/agent",
      emptyDiff: false,
    });
    const trailing = `\`\`\`json\n${envelope}\nnot-json\n\`\`\``;

    const result = parseFleetResultEnvelopeDetailed(
      "review_findings",
      trailing,
    );
    expect(result.envelope).toEqual({ type: "text", text: trailing });
    expect(result.issue).toContain("No review_findings envelope candidate");

    const structural = `\`\`\`json\n{"type":"review_findings","findings":"none"}\n\`\`\``;
    const detailed = parseFleetResultEnvelopeDetailed(
      "review_findings",
      structural,
    );
    expect(detailed.envelope.type).toBe("text");
    expect(detailed.issue).toContain("findings is not an array");
  });

  it("normalizes tolerable finding deviations instead of rejecting the envelope", () => {
    const raw = JSON.stringify({
      type: "Review-Findings",
      findings: [
        {
          severity: "warning",
          message: "Absolute path finding",
          path: "/workspace/repo/src/agent/toolAdapter.ts",
          line: "42",
        },
        {
          severity: "nit",
          message: "Zero line and traversal path are dropped",
          path: "../outside.ts",
          line: 0,
        },
      ],
      reviewedScope: "src/agent",
      emptyDiff: "no",
    });

    expect(
      parseFleetResultEnvelope("review_findings", raw, {
        workspaceRoots: ["/workspace/repo"],
      }),
    ).toEqual({
      type: "review_findings",
      findings: [
        {
          severity: "medium",
          message: "Absolute path finding",
          path: "src/agent/toolAdapter.ts",
          line: 42,
        },
        {
          severity: "low",
          message: "Zero line and traversal path are dropped",
        },
      ],
      reviewedScope: "src/agent",
      emptyDiff: false,
    });
  });

  it("does not recover a fenced envelope of the wrong expected type", () => {
    const response =
      '```json\n{"type":"verification","passed":true,"summary":"ok"}\n```';

    expect(parseFleetResultEnvelope("review_findings", response)).toEqual({
      type: "text",
      text: response,
    });
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
    // Unknown severities and stringy emptyDiff are normalized, not rejected.
    expect(
      parseFleetResultEnvelope(
        "review_findings",
        JSON.stringify({
          type: "review_findings",
          findings: [{ severity: "urgent", message: "bad" }],
        }),
      ),
    ).toEqual({
      type: "review_findings",
      findings: [{ severity: "medium", message: "bad" }],
    });
    expect(
      parseFleetResultEnvelope(
        "review_findings",
        JSON.stringify({
          type: "review_findings",
          findings: [],
          emptyDiff: "yes",
        }),
      ),
    ).toEqual({ type: "review_findings", findings: [], emptyDiff: true });
    // Structural absence still fails: a finding without a message.
    expect(
      parseFleetResultEnvelope(
        "review_findings",
        JSON.stringify({
          type: "review_findings",
          findings: [{ severity: "high" }],
        }),
      ).type,
    ).toBe("text");
  });
});
