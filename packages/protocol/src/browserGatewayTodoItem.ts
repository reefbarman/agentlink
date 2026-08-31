export const BROWSER_GATEWAY_TODO_ITEM_STATES = Object.freeze([
  "pending",
  "in_progress",
  "completed",
] as const);

export type BrowserGatewayTodoItemState =
  (typeof BROWSER_GATEWAY_TODO_ITEM_STATES)[number];

export interface BrowserGatewayTodoItem {
  itemId: string;
  text: string;
  state: BrowserGatewayTodoItemState;
}
