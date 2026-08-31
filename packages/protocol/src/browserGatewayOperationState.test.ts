import { describe, expect, expectTypeOf, it } from "vitest";

import type { BrowserGatewayDetailHandle } from "./browserGatewayDataPlaneIdentity.js";
import {
  BROWSER_GATEWAY_OPERATION_STATUSES,
  type BrowserGatewayOperationState,
  type BrowserGatewayOperationStatus,
} from "./browserGatewayOperationState.js";
import type { BrowserGatewayOwnerCommandKind } from "./browserGatewayOwnerCommandMetadata.js";

describe("browser gateway operation state", () => {
  it("pins and freezes the complete operation status set", () => {
    expect(BROWSER_GATEWAY_OPERATION_STATUSES).toEqual([
      "accepted",
      "completed",
      "failed",
      "uncertain",
    ]);
    expect(Object.isFrozen(BROWSER_GATEWAY_OPERATION_STATUSES)).toBe(true);
    expect(() =>
      (BROWSER_GATEWAY_OPERATION_STATUSES as unknown as string[]).push("other"),
    ).toThrow(TypeError);
    expectTypeOf<BrowserGatewayOperationStatus>().toEqualTypeOf<
      "accepted" | "completed" | "failed" | "uncertain"
    >();
  });

  it("pins the complete browser gateway operation-state contract", () => {
    expectTypeOf<BrowserGatewayOperationState>().toEqualTypeOf<{
      operationId: string;
      kind: BrowserGatewayOwnerCommandKind;
      state: BrowserGatewayOperationStatus;
      message?: string;
      detailHandle?: BrowserGatewayDetailHandle;
    }>();
  });
});
