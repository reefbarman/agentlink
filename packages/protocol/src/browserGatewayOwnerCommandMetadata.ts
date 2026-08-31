export const BROWSER_GATEWAY_OWNER_COMMAND_KINDS = Object.freeze([
  "session.select",
  "session.detail",
  "session.send",
  "session.stop",
  "approval.respond",
  "question.respond",
  "history.load",
  "diff.detail",
] as const);

export type BrowserGatewayOwnerCommandKind =
  (typeof BROWSER_GATEWAY_OWNER_COMMAND_KINDS)[number];

export const BROWSER_GATEWAY_COMMAND_IDEMPOTENCIES = Object.freeze([
  "idempotent",
  "non_idempotent",
] as const);

export type BrowserGatewayCommandIdempotency =
  (typeof BROWSER_GATEWAY_COMMAND_IDEMPOTENCIES)[number];

export const BROWSER_GATEWAY_COMMAND_DEADLINE_CLASSES = Object.freeze([
  "default",
  "long",
] as const);

export type BrowserGatewayCommandDeadlineClass =
  (typeof BROWSER_GATEWAY_COMMAND_DEADLINE_CLASSES)[number];

export const BROWSER_GATEWAY_COMMAND_IDEMPOTENCY = Object.freeze({
  "session.select": "idempotent",
  "session.detail": "idempotent",
  "session.send": "non_idempotent",
  "session.stop": "idempotent",
  "approval.respond": "non_idempotent",
  "question.respond": "non_idempotent",
  "history.load": "idempotent",
  "diff.detail": "idempotent",
} as const satisfies Readonly<
  Record<BrowserGatewayOwnerCommandKind, BrowserGatewayCommandIdempotency>
>);
