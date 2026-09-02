import type {
  BrowserGatewayChatTabSelection,
  BrowserGatewayOwnerRegistration,
  BrowserGatewayRelayReset,
} from "./browserGatewayDataPlaneTransport.js";
import { expectTypeOf, it } from "vitest";

it("pins the residual browser gateway data-plane transport contracts", () => {
  expectTypeOf<BrowserGatewayChatTabSelection>().toEqualTypeOf<{
    instanceId: string;
    tabId: string;
    sessionId: string | null;
  }>();

  expectTypeOf<BrowserGatewayOwnerRegistration["ownerKind"]>().toEqualTypeOf<
    "vscode" | "browser-gateway" | "cli" | "desktop" | "server" | "test"
  >();
  expectTypeOf<BrowserGatewayOwnerRegistration["scope"]>().toEqualTypeOf<
    | { kind: "workspace"; workspaceId: string; displayName: string }
    | { kind: "projectless"; scopeId: string; displayName: string }
  >();

  expectTypeOf<BrowserGatewayRelayReset>().toMatchTypeOf<{
    helperGenerationId: string;
    ownerId: string;
    ownerGenerationId: string;
    latestSequence: number;
    subscriptionId?: string;
  }>();
});
