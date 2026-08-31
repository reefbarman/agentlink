import { expectTypeOf, it } from "vitest";

import type { BrowserGatewayInteractionState } from "./browserGatewayInteractionState.js";
import type { BrowserGatewayInteractionSummary } from "./browserGatewayInteractionSummary.js";
import type { BrowserGatewayOperationState } from "./browserGatewayOperationState.js";
import type { BrowserGatewayQueueItem } from "./browserGatewayQueueItem.js";
import type { BrowserGatewayTodoItem } from "./browserGatewayTodoItem.js";

it("pins the complete browser gateway interaction-state contract", () => {
  expectTypeOf<BrowserGatewayInteractionState>().toEqualTypeOf<{
    interaction: BrowserGatewayInteractionSummary | null;
    queue: BrowserGatewayQueueItem[];
    todos: BrowserGatewayTodoItem[];
    operations: BrowserGatewayOperationState[];
  }>();
});
