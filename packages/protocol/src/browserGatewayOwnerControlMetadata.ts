export const BROWSER_GATEWAY_OWNER_CONTROL_KINDS = [
  "hello",
  "demand.changed",
  "checkpoint.requested",
  "command.cancelled",
  "drain",
] as const;

export type BrowserGatewayOwnerControlKind =
  (typeof BROWSER_GATEWAY_OWNER_CONTROL_KINDS)[number];

export const BROWSER_GATEWAY_RELAY_RESET_REASONS = Object.freeze([
  "helper_generation_changed",
  "owner_generation_changed",
  "sequence_gap",
  "stale_replay_cursor",
  "subscription_changed",
  "checkpoint_required",
] as const);

export type BrowserGatewayRelayResetReason =
  (typeof BROWSER_GATEWAY_RELAY_RESET_REASONS)[number];
