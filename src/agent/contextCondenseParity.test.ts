import {
  estimateTokensFromChars as coreEstimateTokensFromChars,
  stripMemoryCandidateReminders as coreStripMemoryCandidateReminders,
} from "@agentlink/core/context-condense";
import { describe, expect, it } from "vitest";

import { estimateTokensFromChars } from "../util/tokenEstimation.js";
import { stripMemoryCandidateReminders } from "../shared/memoryCandidates.js";

// The browser webview and indexer worker bundles keep these two helpers in
// VS Code, so core carries its own copies for the shared summariser.
describe("context-condense helpers match VS Code's", () => {
  it("estimates tokens the same way", () => {
    for (const chars of [0, 1, 3, 4, 5, 1_001, 120_000]) {
      expect(coreEstimateTokensFromChars(chars)).toBe(
        estimateTokensFromChars(chars),
      );
    }
  });

  it("strips memory-candidate reminders the same way", () => {
    const text = [
      "keep this",
      "<system-reminder>\n[memory-candidate] drop me\n</system-reminder>",
      "and this",
      "<system-reminder>other reminder</system-reminder>",
    ].join("\n");
    expect(coreStripMemoryCandidateReminders(text)).toBe(
      stripMemoryCandidateReminders(text),
    );
  });
});
