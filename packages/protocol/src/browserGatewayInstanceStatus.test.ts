import type {
  BrowserGatewayInstanceStatusKind,
  BrowserGatewayInstanceStatusSummary,
} from "./browserGatewayInstanceStatus.js";
import { describe, expectTypeOf, it } from "vitest";

describe("browser gateway instance status", () => {
  it("pins the full wire status union", () => {
    expectTypeOf<BrowserGatewayInstanceStatusKind>().toEqualTypeOf<
      "idle" | "working" | "awaiting_approval" | "error" | "disconnected"
    >();
  });

  it("represents compact status summaries without presentation policy", () => {
    expectTypeOf<BrowserGatewayInstanceStatusSummary>().toEqualTypeOf<{
      kind: BrowserGatewayInstanceStatusKind;
      label: string;
      detail?: string;
      sessionTitle?: string;
    }>();
  });
});
