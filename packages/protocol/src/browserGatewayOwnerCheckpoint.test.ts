import { expectTypeOf, it } from "vitest";

import type { BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION } from "./browserGatewayDataPlaneVersion.js";
import type { BrowserGatewayBackgroundSummary } from "./browserGatewayBackgroundSummary.js";
import type { BrowserGatewayCapabilityStatus } from "./browserGatewayCapabilityStatus.js";
import type { BrowserGatewayDataPlaneIdentity } from "./browserGatewayDataPlaneIdentity.js";
import type { BrowserGatewayDiffPreview } from "./browserGatewayDiffPreview.js";
import type { BrowserGatewayForegroundControlState } from "./browserGatewayForegroundControlState.js";
import type { BrowserGatewayInteractionState } from "./browserGatewayInteractionState.js";
import type { BrowserGatewayOwnerCheckpoint } from "./browserGatewayOwnerCheckpoint.js";
import type { BrowserGatewayRepositoryState } from "./browserGatewayRepositoryState.js";
import type { BrowserGatewaySessionCatalog } from "./browserGatewaySessionCatalog.js";
import type { BrowserGatewayThemeState } from "./browserGatewayTheme.js";
import type { BrowserGatewayTranscriptWindow } from "./browserGatewayTranscriptWindow.js";

interface ExpectedBrowserGatewayOwnerCheckpoint extends BrowserGatewayDataPlaneIdentity {
  protocolVersion: typeof BROWSER_GATEWAY_DATA_PLANE_PROTOCOL_VERSION;
  checkpointId: string;
  checkpointSequence: number;
  emittedAt: number;
  foreground: BrowserGatewayForegroundControlState | null;
  catalog: BrowserGatewaySessionCatalog;
  transcript: BrowserGatewayTranscriptWindow;
  ui: BrowserGatewayInteractionState;
  background: BrowserGatewayBackgroundSummary[];
  fleet: BrowserGatewayBackgroundSummary[];
  diffs: BrowserGatewayDiffPreview[];
  repository: BrowserGatewayRepositoryState | null;
  theme: BrowserGatewayThemeState;
  modelCatalogRevision: string;
  pluginCatalogRevision?: string;
  capabilities: BrowserGatewayCapabilityStatus[];
}

it("pins the complete browser gateway owner-checkpoint contract", () => {
  expectTypeOf<BrowserGatewayOwnerCheckpoint>().toEqualTypeOf<ExpectedBrowserGatewayOwnerCheckpoint>();
});
