import { describe, expect, expectTypeOf, it } from "vitest";

import {
  BROWSER_GATEWAY_TODO_ITEM_STATES,
  type BrowserGatewayTodoItem,
  type BrowserGatewayTodoItemState,
} from "./browserGatewayTodoItem.js";

describe("browser gateway todo item", () => {
  it("pins and freezes the complete todo-item state set", () => {
    expect(BROWSER_GATEWAY_TODO_ITEM_STATES).toEqual([
      "pending",
      "in_progress",
      "completed",
    ]);
    expect(Object.isFrozen(BROWSER_GATEWAY_TODO_ITEM_STATES)).toBe(true);
    expect(() =>
      (BROWSER_GATEWAY_TODO_ITEM_STATES as unknown as string[]).push("other"),
    ).toThrow(TypeError);
    expectTypeOf<BrowserGatewayTodoItemState>().toEqualTypeOf<
      "pending" | "in_progress" | "completed"
    >();
  });

  it("pins the complete todo-item contract", () => {
    expectTypeOf<BrowserGatewayTodoItem>().toEqualTypeOf<{
      itemId: string;
      text: string;
      state: BrowserGatewayTodoItemState;
    }>();
  });
});
