export type BrowserGatewayInstanceStatusKind =
  | "idle"
  | "working"
  | "awaiting_approval"
  | "error"
  | "disconnected";

export interface BrowserGatewayInstanceStatusSummary {
  kind: BrowserGatewayInstanceStatusKind;
  label: string;
  detail?: string;
  sessionTitle?: string;
}
