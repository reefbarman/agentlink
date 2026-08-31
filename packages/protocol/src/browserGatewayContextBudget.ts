export interface BrowserGatewayContextBudget {
  contextWindow: number;
  maxInputTokens: number;
  usedInputTokens: number;
  outputReservation: number;
  safetyBufferTokens: number;
  softThresholdBudget: number;
  hardBudget: number;
}
