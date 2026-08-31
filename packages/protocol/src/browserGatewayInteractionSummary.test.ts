import { describe, expect, expectTypeOf, it } from "vitest";

import type { BrowserGatewayDetailHandle } from "./browserGatewayDataPlaneIdentity.js";
import {
  BROWSER_GATEWAY_INTERACTION_KINDS,
  BROWSER_GATEWAY_INTERACTION_SUMMARY_STATES,
  type BrowserGatewayInteractionKind,
  type BrowserGatewayInteractionSummary,
  type BrowserGatewayInteractionSummaryState,
} from "./browserGatewayInteractionSummary.js";

describe("browser gateway interaction summary", () => {
  it("pins and freezes the complete interaction kind set", () => {
    expect(BROWSER_GATEWAY_INTERACTION_KINDS).toEqual([
      "approval",
      "question",
      "form",
      "url",
    ]);
    expect(Object.isFrozen(BROWSER_GATEWAY_INTERACTION_KINDS)).toBe(true);
    expect(() =>
      (BROWSER_GATEWAY_INTERACTION_KINDS as unknown as string[]).push("other"),
    ).toThrow(TypeError);
    expectTypeOf<BrowserGatewayInteractionKind>().toEqualTypeOf<
      "approval" | "question" | "form" | "url"
    >();
  });

  it("pins and freezes the complete interaction-summary state set", () => {
    expect(BROWSER_GATEWAY_INTERACTION_SUMMARY_STATES).toEqual([
      "pending",
      "progressed",
      "cleared",
    ]);
    expect(Object.isFrozen(BROWSER_GATEWAY_INTERACTION_SUMMARY_STATES)).toBe(
      true,
    );
    expect(() =>
      (BROWSER_GATEWAY_INTERACTION_SUMMARY_STATES as unknown as string[]).push(
        "other",
      ),
    ).toThrow(TypeError);
    expectTypeOf<BrowserGatewayInteractionSummaryState>().toEqualTypeOf<
      "pending" | "progressed" | "cleared"
    >();
  });

  it("pins the complete browser gateway interaction-summary contract", () => {
    expectTypeOf<BrowserGatewayInteractionSummary>().toEqualTypeOf<{
      requestId: string;
      kind: BrowserGatewayInteractionKind;
      state: BrowserGatewayInteractionSummaryState;
      summary: string;
      step?: number;
      totalSteps?: number;
      detailHandle?: BrowserGatewayDetailHandle;
    }>();
  });
});
