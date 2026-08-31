import { expect, expectTypeOf, it } from "vitest";

import {
  BROWSER_GATEWAY_OWNER_EVENT_KINDS,
  type BrowserGatewayOwnerEventKind,
} from "./browserGatewayOwnerEventMetadata.js";

it("pins and freezes the complete browser gateway owner-event kind set", () => {
  expect(BROWSER_GATEWAY_OWNER_EVENT_KINDS).toEqual([
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
  ]);
  expect(Object.isFrozen(BROWSER_GATEWAY_OWNER_EVENT_KINDS)).toBe(true);
  expect(() =>
    (BROWSER_GATEWAY_OWNER_EVENT_KINDS as unknown as string[]).push("other"),
  ).toThrow(TypeError);
  expectTypeOf<BrowserGatewayOwnerEventKind>().toEqualTypeOf<
    | "foreground.control.updated"
    | "session.catalog.updated"
    | "transcript.message.appended"
    | "transcript.message.upserted"
    | "transcript.block.delta"
    | "transcript.history.prepended"
    | "interaction.updated"
    | "queue.updated"
    | "todo.updated"
    | "background.updated"
    | "fleet.updated"
    | "diff.preview.updated"
    | "repository.updated"
    | "theme.updated"
    | "model_catalog.revision.updated"
    | "plugin_catalog.revision.updated"
    | "owner.capabilities.updated"
    | "operation.updated"
  >();
});
