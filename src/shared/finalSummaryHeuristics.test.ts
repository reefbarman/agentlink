import { describe, expect, it } from "vitest";

import {
  isRecapOnlyFinalSummary,
  isTeaserOnlyFinalSummary,
} from "./finalSummaryHeuristics.js";

describe("isTeaserOnlyFinalSummary", () => {
  it("flags summaries that promise an artifact without including it", () => {
    expect(isTeaserOnlyFinalSummary("Here is the prompt.")).toBe(true);
    expect(isTeaserOnlyFinalSummary("Below is the command to run.")).toBe(true);
    expect(isTeaserOnlyFinalSummary("You're right — here is the answer.")).toBe(
      true,
    );
  });

  it("accepts summaries that actually contain the artifact", () => {
    expect(
      isTeaserOnlyFinalSummary(
        "Here is the command:\n\n```sh\nnpm run release -- --install\n```",
      ),
    ).toBe(false);
    expect(
      isTeaserOnlyFinalSummary(
        "Here is the plan: first collect requirements from the stakeholders, then draft the architecture options.",
      ),
    ).toBe(false);
  });

  it("ignores summaries that neither tease nor name an artifact", () => {
    expect(isTeaserOnlyFinalSummary("")).toBe(false);
    expect(isTeaserOnlyFinalSummary("All checks passed.")).toBe(false);
  });
});

describe("isRecapOnlyFinalSummary", () => {
  it("flags short past-tense recaps that deliver nothing", () => {
    expect(
      isRecapOnlyFinalSummary(
        "Prepared a requirements-focused meeting guide with architecture recommendations, privacy prompts, and effort ranges for prototype through productised API.",
      ),
    ).toBe(true);
    expect(isRecapOnlyFinalSummary("Answered the licensing question.")).toBe(
      true,
    );
    expect(
      isRecapOnlyFinalSummary("I've drafted the comparison you asked for."),
    ).toBe(true);
    expect(isRecapOnlyFinalSummary("Done.")).toBe(true);
  });

  it("accepts summaries that carry the actual content", () => {
    expect(
      isRecapOnlyFinalSummary(
        "Prepared the guide:\n\n1. Start with stakeholder requirements\n2. Compare Azure API Management tiers\n3. Review OAIC privacy obligations",
      ),
    ).toBe(false);
    expect(
      isRecapOnlyFinalSummary(
        "Compared the two options: Azure API Management consumption tier suits the prototype, while standard v2 fits the productised API.",
      ),
    ).toBe(false);
  });

  it("ignores non-recap summaries", () => {
    expect(isRecapOnlyFinalSummary("")).toBe(false);
    expect(
      isRecapOnlyFinalSummary("The consumption tier is the better fit."),
    ).toBe(false);
  });
});
