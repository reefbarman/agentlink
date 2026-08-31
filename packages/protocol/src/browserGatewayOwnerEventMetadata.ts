export const BROWSER_GATEWAY_OWNER_EVENT_KINDS = Object.freeze([
  "foreground.control.updated",
  "session.catalog.updated",
  "transcript.message.appended",
  "transcript.message.upserted",
  "transcript.block.delta",
  "transcript.history.prepended",
  "interaction.updated",
  "queue.updated",
  "todo.updated",
  "background.updated",
  "fleet.updated",
  "diff.preview.updated",
  "repository.updated",
  "theme.updated",
  "model_catalog.revision.updated",
  "plugin_catalog.revision.updated",
  "owner.capabilities.updated",
  "operation.updated",
] as const);

export type BrowserGatewayOwnerEventKind =
  (typeof BROWSER_GATEWAY_OWNER_EVENT_KINDS)[number];
