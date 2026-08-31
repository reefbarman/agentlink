import type { BrowserGatewayDetailHandle } from "./browserGatewayDataPlaneIdentity.js";

export const BROWSER_GATEWAY_INTERACTION_KINDS = Object.freeze([
  "approval",
  "question",
  "form",
  "url",
] as const);

export type BrowserGatewayInteractionKind =
  (typeof BROWSER_GATEWAY_INTERACTION_KINDS)[number];

export const BROWSER_GATEWAY_INTERACTION_SUMMARY_STATES = Object.freeze([
  "pending",
  "progressed",
  "cleared",
] as const);

export type BrowserGatewayInteractionSummaryState =
  (typeof BROWSER_GATEWAY_INTERACTION_SUMMARY_STATES)[number];

export interface BrowserGatewayInteractionSummary {
  requestId: string;
  kind: BrowserGatewayInteractionKind;
  state: BrowserGatewayInteractionSummaryState;
  summary: string;
  step?: number;
  totalSteps?: number;
  detailHandle?: BrowserGatewayDetailHandle;
}
