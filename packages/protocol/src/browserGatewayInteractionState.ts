import type { BrowserGatewayInteractionSummary } from "./browserGatewayInteractionSummary.js";
import type { BrowserGatewayOperationState } from "./browserGatewayOperationState.js";
import type { BrowserGatewayQueueItem } from "./browserGatewayQueueItem.js";
import type { BrowserGatewayTodoItem } from "./browserGatewayTodoItem.js";

export interface BrowserGatewayInteractionState {
  interaction: BrowserGatewayInteractionSummary | null;
  queue: BrowserGatewayQueueItem[];
  todos: BrowserGatewayTodoItem[];
  operations: BrowserGatewayOperationState[];
}
