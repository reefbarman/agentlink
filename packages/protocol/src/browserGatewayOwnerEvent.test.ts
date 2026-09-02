import type {
  BrowserGatewayOwnerEvent,
  BrowserGatewayOwnerEventPayload,
} from "./browserGatewayOwnerEvent.js";
import { expectTypeOf, it } from "vitest";

import type { BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION } from "./browserGatewayDataPlaneVersion.js";
import type { BrowserGatewayBackgroundSummary } from "./browserGatewayBackgroundSummary.js";
import type { BrowserGatewayCapabilityStatus } from "./browserGatewayCapabilityStatus.js";
import type { BrowserGatewayDataPlaneIdentity } from "./browserGatewayDataPlaneIdentity.js";
import type { BrowserGatewayDiffPreview } from "./browserGatewayDiffPreview.js";
import type { BrowserGatewayForegroundControlState } from "./browserGatewayForegroundControlState.js";
import type { BrowserGatewayInteractionSummary } from "./browserGatewayInteractionSummary.js";
import type { BrowserGatewayOperationState } from "./browserGatewayOperationState.js";
import type { BrowserGatewayOwnerEventKind } from "./browserGatewayOwnerEventMetadata.js";
import type { BrowserGatewayQueueItem } from "./browserGatewayQueueItem.js";
import type { BrowserGatewayRepositoryState } from "./browserGatewayRepositoryState.js";
import type { BrowserGatewaySessionCatalog } from "./browserGatewaySessionCatalog.js";
import type { BrowserGatewayThemeState } from "./browserGatewayTheme.js";
import type { BrowserGatewayTodoItem } from "./browserGatewayTodoItem.js";
import type { BrowserGatewayTranscriptMessage } from "./browserGatewayTranscriptMessage.js";
import type { BrowserGatewayTranscriptWindow } from "./browserGatewayTranscriptWindow.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <
        Value,
      >() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;

type ExpectedBrowserGatewayOwnerEventPayload =
  | { foreground: BrowserGatewayForegroundControlState | null }
  | { catalog: BrowserGatewaySessionCatalog }
  | { message: BrowserGatewayTranscriptMessage }
  | {
      messageId: string;
      blockId: string;
      field: "text" | "thinking";
      delta: string;
      revision: number;
    }
  | BrowserGatewayTranscriptWindow
  | { interaction: BrowserGatewayInteractionSummary | null }
  | { queue: BrowserGatewayQueueItem[] }
  | { todos: BrowserGatewayTodoItem[] }
  | { sessions: BrowserGatewayBackgroundSummary[] }
  | { diffs: BrowserGatewayDiffPreview[] }
  | { repository: BrowserGatewayRepositoryState | null }
  | { theme: BrowserGatewayThemeState }
  | { revision: string }
  | { capabilities: BrowserGatewayCapabilityStatus[] }
  | { operation: BrowserGatewayOperationState };

interface ExpectedBrowserGatewayOwnerEvent extends BrowserGatewayDataPlaneIdentity {
  protocolVersion: typeof BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION;
  ownerSequence: number;
  eventId: string;
  kind: BrowserGatewayOwnerEventKind;
  emittedAt: number;
  payload: BrowserGatewayOwnerEventPayload;
}

it("pins the complete browser gateway owner-event payload and envelope contract", () => {
  expectTypeOf<
    Equal<
      BrowserGatewayOwnerEventPayload,
      ExpectedBrowserGatewayOwnerEventPayload
    >
  >().toEqualTypeOf<true>();
  expectTypeOf<BrowserGatewayOwnerEvent>().toEqualTypeOf<ExpectedBrowserGatewayOwnerEvent>();
  expectTypeOf<
    BrowserGatewayOwnerEvent["kind"]
  >().toEqualTypeOf<BrowserGatewayOwnerEventKind>();
});
