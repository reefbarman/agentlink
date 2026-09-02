import type {
  BrowserGatewayProjectSummary,
  BrowserGatewaySessionCatalog,
  BrowserGatewaySessionSummary,
} from "./browserGatewaySessionCatalog.js";
import { expectTypeOf, it } from "vitest";

import type { BrowserGatewayChatWorkspaceSummary } from "./browserGatewayChatWorkspaceSummary.js";

it("pins the complete browser gateway session-catalog contract", () => {
  expectTypeOf<BrowserGatewayProjectSummary>().toEqualTypeOf<{
    projectId: string;
    displayName: string;
    availability: "available" | "unavailable";
  }>();
  expectTypeOf<BrowserGatewaySessionSummary>().toEqualTypeOf<{
    sessionId: string;
    projectId: string | null;
    title: string;
    mode: string;
    model: string;
    messageCount: number;
    createdAt: number;
    updatedAt: number;
  }>();
  expectTypeOf<BrowserGatewaySessionCatalog>().toEqualTypeOf<{
    projects: BrowserGatewayProjectSummary[];
    sessions: BrowserGatewaySessionSummary[];
    defaultProjectId: string | null;
    foregroundSessionId: string | null;
    chatWorkspace?: BrowserGatewayChatWorkspaceSummary | null;
  }>();
});
