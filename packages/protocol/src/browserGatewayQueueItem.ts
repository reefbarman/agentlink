export const BROWSER_GATEWAY_QUEUE_ITEM_STATES = Object.freeze([
  "queued",
  "running",
  "completed",
  "failed",
] as const);

export type BrowserGatewayQueueItemState =
  (typeof BROWSER_GATEWAY_QUEUE_ITEM_STATES)[number];

export interface BrowserGatewayQueueItem {
  itemId: string;
  summary: string;
  state: BrowserGatewayQueueItemState;
}
