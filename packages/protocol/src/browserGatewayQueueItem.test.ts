import { describe, expect, expectTypeOf, it } from "vitest";

import {
  BROWSER_GATEWAY_QUEUE_ITEM_STATES,
  type BrowserGatewayQueueItem,
  type BrowserGatewayQueueItemState,
} from "./browserGatewayQueueItem.js";

describe("browser gateway queue item", () => {
  it("pins and freezes the complete queue-item state set", () => {
    expect(BROWSER_GATEWAY_QUEUE_ITEM_STATES).toEqual([
      "queued",
      "running",
      "completed",
      "failed",
    ]);
    expect(Object.isFrozen(BROWSER_GATEWAY_QUEUE_ITEM_STATES)).toBe(true);
    expect(() =>
      (BROWSER_GATEWAY_QUEUE_ITEM_STATES as unknown as string[]).push("other"),
    ).toThrow(TypeError);
    expectTypeOf<BrowserGatewayQueueItemState>().toEqualTypeOf<
      "queued" | "running" | "completed" | "failed"
    >();
  });

  it("pins the complete queue-item contract", () => {
    expectTypeOf<BrowserGatewayQueueItem>().toEqualTypeOf<{
      itemId: string;
      summary: string;
      state: BrowserGatewayQueueItemState;
    }>();
  });
});
