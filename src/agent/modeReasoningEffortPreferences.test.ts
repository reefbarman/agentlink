import { describe, expect, it } from "vitest";

import {
  getModeReasoningEffortPreferences,
  resolveReasoningEffortForMode,
} from "./modeReasoningEffortPreferences.js";

function makeConfig(value: unknown) {
  return {
    get: (key: string) =>
      key === "modeReasoningEffortPreferences" ? value : undefined,
  } as never;
}

describe("mode reasoning effort preferences", () => {
  it("keeps valid per-mode efforts and ignores malformed entries", () => {
    const config = makeConfig({
      code: "high",
      architect: "xhigh",
      ask: "unsupported",
      " ": "low",
      debug: 42,
    });

    expect(getModeReasoningEffortPreferences(config)).toEqual({
      code: "high",
      architect: "xhigh",
    });
    expect(resolveReasoningEffortForMode(config, "architect")).toBe("xhigh");
  });

  it("falls back to high when a mode has no preference", () => {
    expect(resolveReasoningEffortForMode(makeConfig({}), "code")).toBe("high");
  });
});
