import {
  EXPECTED_RESULT_PROPERTY,
  REVIEW_SCOPE_PROPERTY,
  parseExpectedResultInput,
  parseReviewScopeInput,
} from "./backgroundAgentTools.js";
import {
  MISSING_TEXT_RESULT_ISSUE,
  backgroundSetTaskStatusTool,
  checkBackgroundTaskStatusResult,
  describeExpectedResultIssue,
  formatFleetResultEnvelope,
  parseFleetResultEnvelopeDetailed,
  withFleetResultInstruction,
} from "./backgroundResults.js";
import { describe, expect, it } from "vitest";

import { SET_TASK_STATUS_TOOL } from "./interactionTools.js";

describe("background results", () => {
  it("adds a result envelope typed to the expected result to set_task_status", () => {
    const tool = backgroundSetTaskStatusTool("review_findings");
    expect(tool.name).toBe(SET_TASK_STATUS_TOOL.name);
    expect(tool.description).toContain(
      "This background task expects a structured review_findings result",
    );
    const properties = tool.input_schema.properties as Record<
      string,
      { required?: string[]; $schema?: string }
    >;
    expect(properties.result?.required).toEqual(
      expect.arrayContaining(["type", "findings", "emptyDiff"]),
    );
    expect(properties.result).not.toHaveProperty("$schema");
    expect(backgroundSetTaskStatusTool().description).toContain(
      "you may return a structured result",
    );
  });

  it("checks a background completion's result as VS Code does", () => {
    expect(
      checkBackgroundTaskStatusResult({
        status: "completed",
        result: { type: "text", text: "  " },
      }),
    ).toEqual({
      error:
        "Completion requires non-empty text in set_task_status.result.text",
    });
    expect(
      checkBackgroundTaskStatusResult({
        status: "completed",
        result: { type: "patch", summary: "x", files: ["../escape"] },
        expectedResult: "patch",
      }),
    ).toMatchObject({
      error:
        "Background completion requires a valid patch result in set_task_status.result",
      issues: [{ path: "result.files.0" }],
    });
    // Only completion owes the expected result.
    expect(
      checkBackgroundTaskStatusResult({
        status: "blocked",
        result: undefined,
        expectedResult: "patch",
      }),
    ).toBeUndefined();
    expect(
      checkBackgroundTaskStatusResult({
        status: "blocked",
        result: { type: "nope" },
      }),
    ).toMatchObject({ error: "Invalid structured result" });
  });

  it("explains an incomplete expected result in VS Code's words", () => {
    expect(
      describeExpectedResultIssue({
        expected: undefined,
        missingTextResult: true,
        parsedType: "text",
      }),
    ).toBe(MISSING_TEXT_RESULT_ISSUE);
    expect(
      describeExpectedResultIssue({
        expected: "patch",
        missingTextResult: false,
        providerStopReason: "provider_stop:length",
        parsedType: "text",
      }),
    ).toContain("(provider_stop:length)");
    const parsed = parseFleetResultEnvelopeDetailed("patch", "no envelope");
    expect(
      describeExpectedResultIssue({
        expected: "patch",
        missingTextResult: false,
        parsedType: parsed.envelope.type,
        parseIssue: parsed.issue,
      }),
    ).toBe(
      'Expected a "patch" envelope; the final message parsed as plain text without a valid envelope. No patch envelope candidate was found in the final output. The raw final output is preserved in partialOutput.',
    );
  });

  it("asks reviewers to list every identified issue and blocked check", () => {
    for (const text of [
      backgroundSetTaskStatusTool("review_findings").description,
      withFleetResultInstruction("review_findings", "Review it."),
    ]) {
      expect(text).toContain("must be a findings entry");
      expect(text).toContain("limitations");
    }
    expect(backgroundSetTaskStatusTool("patch").description).not.toContain(
      "limitations",
    );
  });

  it("keeps reviewer prose and blocked validation visible beside a clean review", () => {
    // Reported: the prose named a confirmed finding the envelope omitted.
    const text = [
      "Static review has one confirmed inconsistency in the plan: it still says 13 roots.",
      "Policy blocked `make check-triangle`.",
      "```json",
      '{"type":"review_findings","findings":[],"limitations":["make check-triangle blocked by policy"],"emptyDiff":false}',
      "```",
    ].join("\n");
    const parsed = parseFleetResultEnvelopeDetailed("review_findings", text);
    expect(parsed.envelope).toMatchObject({
      type: "review_findings",
      findings: [],
      limitations: ["make check-triangle blocked by policy"],
    });
    expect(parsed.outsideText).toBe(
      "Static review has one confirmed inconsistency in the plan: it still says 13 roots.\nPolicy blocked `make check-triangle`.",
    );
    const formatted = formatFleetResultEnvelope(parsed.envelope, {
      reviewerNotes: parsed.outsideText,
    });
    expect(formatted).not.toContain("**Review found no issues.**");
    expect(formatted).toContain("some checks did not run");
    expect(formatted).toContain(
      "**Not verified**\n- make check-triangle blocked by policy",
    );
    expect(formatted).toContain("one confirmed inconsistency");

    // A bare envelope has no surrounding prose to show.
    const bare = parseFleetResultEnvelopeDetailed(
      "review_findings",
      '{"type":"review_findings","findings":[],"emptyDiff":false}',
    );
    expect(bare.outsideText).toBeUndefined();
    // Notes are only added to a clean verdict, where a missed finding hides.
    const withFinding = formatFleetResultEnvelope(
      {
        type: "review_findings",
        findings: [{ severity: "low", message: "nit" }],
      },
      { reviewerNotes: "prose" },
    );
    expect(withFinding).not.toContain("Reviewer notes");
    expect(
      formatFleetResultEnvelope(
        { type: "review_findings", findings: [] },
        { reviewerNotes: "x".repeat(5_000) },
      ).length,
    ).toBeLessThan(2_200);
  });

  it("reads VS Code's spawn_background_agent reviewScope and expectedResult inputs", () => {
    expect(EXPECTED_RESULT_PROPERTY.enum).toEqual([
      "text",
      "review_findings",
      "patch",
      "verification",
    ]);
    expect(REVIEW_SCOPE_PROPERTY.oneOf).toHaveLength(4);
    expect(parseExpectedResultInput("patch")).toBe("patch");
    expect(parseExpectedResultInput("other")).toBeUndefined();
    expect(
      parseReviewScopeInput({
        kind: "working_tree",
        include: ["staged", "bogus"],
        paths: ["src"],
        root: " ",
      }),
    ).toEqual({
      kind: "working_tree",
      include: ["staged"],
      paths: ["src"],
      excludePaths: undefined,
      root: undefined,
    });
    expect(parseReviewScopeInput({ kind: "files" })).toEqual({
      kind: "files",
      paths: [],
      excludePaths: undefined,
    });
    expect(parseReviewScopeInput({ kind: "diff", content: "x" })).toEqual({
      kind: "diff",
      content: "x",
      label: undefined,
    });
    expect(parseReviewScopeInput({ kind: "other" })).toBeUndefined();
    expect(parseReviewScopeInput("files")).toBeUndefined();
  });
});
