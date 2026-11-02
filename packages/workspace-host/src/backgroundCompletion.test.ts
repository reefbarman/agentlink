import { describe, expect, it } from "vitest";

import { MISSING_TEXT_RESULT_ISSUE } from "@agentlink/core/background-results";
import { resolveWorkspaceBackgroundCompletion } from "./backgroundCompletion.js";

const roots = ["/project"];

describe("resolveWorkspaceBackgroundCompletion", () => {
  it("takes a completed set_task_status result and credits the review scope", () => {
    expect(
      resolveWorkspaceBackgroundCompletion({
        expectedResult: "review_findings",
        reviewScopeSummary: "current files: a.ts",
        marker: {
          status: "completed",
          result: { type: "review_findings", findings: [], emptyDiff: false },
        },
        text: "",
        workspaceRoots: roots,
      }),
    ).toMatchObject({
      lifecycle: "completed",
      resultState: "completed",
      structuredResult: { reviewedScope: "current files: a.ts" },
      resultText: expect.stringContaining("**Review found no issues.**"),
    });
  });

  it("never treats a blocked or cancelled status as a completed result", () => {
    const marker = {
      status: "blocked" as const,
      result: {
        type: "review_findings" as const,
        findings: [],
        emptyDiff: false,
      },
    };
    expect(
      resolveWorkspaceBackgroundCompletion({
        marker,
        text: "",
        workspaceRoots: roots,
      }),
    ).toMatchObject({
      lifecycle: "interrupted",
      resultState: "interrupted",
      terminalReason: "blocked",
      partialOutput: expect.stringContaining(
        "Review did not complete; this is not a clean result.",
      ),
    });
    expect(
      resolveWorkspaceBackgroundCompletion({
        marker: { status: "cancelled", summary: "stopped" },
        text: "",
        workspaceRoots: roots,
      }),
    ).toMatchObject({
      lifecycle: "cancelled",
      terminalReason: "cancelled_by_user",
      partialOutput: "stopped",
    });
  });

  it("parses an envelope from the final text, normalizing finding paths", () => {
    expect(
      resolveWorkspaceBackgroundCompletion({
        expectedResult: "review_findings",
        text: '```json\n{"type":"review_findings","findings":[{"severity":"nit","message":"x","path":"/project/a.ts"}],"emptyDiff":false}\n```',
        workspaceRoots: roots,
      }),
    ).toMatchObject({
      lifecycle: "completed",
      structuredResult: {
        findings: [{ severity: "low", path: "a.ts" }],
      },
    });
  });

  it("fails a run without its expected envelope or any text", () => {
    expect(
      resolveWorkspaceBackgroundCompletion({
        expectedResult: "patch",
        marker: { status: "completed", summary: "did it" },
        text: "did it",
        workspaceRoots: roots,
      }),
    ).toMatchObject({
      lifecycle: "failed",
      resultState: "incomplete_expected_result",
      expectedResultIssue: expect.stringContaining('Expected a "patch"'),
      partialOutput: "did it",
    });
    expect(
      resolveWorkspaceBackgroundCompletion({
        text: "  ",
        workspaceRoots: roots,
      }),
    ).toMatchObject({
      resultState: "incomplete_expected_result",
      expectedResultIssue: MISSING_TEXT_RESULT_ISSUE,
    });
    expect(
      resolveWorkspaceBackgroundCompletion({
        text: "plain answer",
        workspaceRoots: roots,
      }),
    ).toMatchObject({
      lifecycle: "completed",
      resultText: "plain answer",
    });
  });
});
