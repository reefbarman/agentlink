import { describe, expectTypeOf, it } from "vitest";

import type { FleetResultEnvelope } from "./fleetResult.js";

describe("fleet result protocol", () => {
  it("keeps every result envelope serializable", () => {
    expectTypeOf<FleetResultEnvelope>().toMatchTypeOf<
      | { type: "text"; text: string }
      | { type: "review_findings"; findings: unknown[] }
      | { type: "patch"; summary: string; files: string[] }
      | { type: "verification"; passed: boolean; summary: string }
    >();
  });
});
