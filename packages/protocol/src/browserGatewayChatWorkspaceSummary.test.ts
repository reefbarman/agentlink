import { expectTypeOf, it } from "vitest";

import type { BrowserGatewayChatWorkspaceSummary } from "./browserGatewayChatWorkspaceSummary.js";
import type { ChatWorkspaceInteractiveExecutionPhase } from "./chatWorkspace.js";

it("pins the complete browser gateway chat-workspace summary contract", () => {
  expectTypeOf<BrowserGatewayChatWorkspaceSummary>().toEqualTypeOf<{
    controllerEpoch: string;
    focusedTabId: string;
    tabs: Array<{
      tabId: string;
      displayNumber: number;
      label: string;
      sessionId: string | null;
      placement: "docked" | "popped";
      title?: string;
      status:
        | "idle"
        | "streaming"
        | "queued_for_provider"
        | "queued_for_workspace_write"
        | "needs_input"
        | "failed"
        | "completed";
      busy: boolean;
      needsAttention?: boolean;
      mode?: string;
      model?: string;
      interactiveExecutionPhase?: ChatWorkspaceInteractiveExecutionPhase;
      estimatedTokens?: number;
      maximumTokens?: number;
    }>;
  }>();
});
