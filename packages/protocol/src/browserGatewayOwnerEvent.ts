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

export type BrowserGatewayOwnerEventPayload =
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

export interface BrowserGatewayOwnerEvent extends BrowserGatewayDataPlaneIdentity {
  protocolVersion: typeof BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION;
  ownerSequence: number;
  eventId: string;
  kind: BrowserGatewayOwnerEventKind;
  emittedAt: number;
  payload: BrowserGatewayOwnerEventPayload;
}
