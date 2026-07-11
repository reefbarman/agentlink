import { describe, expect, it } from "vitest";

import {
  getDiagnosticDelay,
  getMasterBypass,
  type AgentLinkConfigurationReader,
} from "./agentLinkConfig.js";
import { DEFAULT_DIAGNOSTIC_DELAY_MS } from "../../core/capabilities/editReview.js";

function configurationWith(
  values: Record<string, unknown>,
): AgentLinkConfigurationReader {
  return {
    get<T>(section: string, defaultValue: T): T {
      return section in values ? (values[section] as T) : defaultValue;
    },
  };
}

describe("AgentLink config accessors", () => {
  it("uses the established defaults", () => {
    const configuration = configurationWith({});

    expect(getDiagnosticDelay(configuration)).toBe(DEFAULT_DIAGNOSTIC_DELAY_MS);
    expect(getMasterBypass(configuration)).toBe(false);
  });

  it("returns configured values without replacing valid falsy values", () => {
    const configuration = configurationWith({
      diagnosticDelay: 0,
      masterBypass: true,
    });

    expect(getDiagnosticDelay(configuration)).toBe(0);
    expect(getMasterBypass(configuration)).toBe(true);
  });
});
