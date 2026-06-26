import type { CoreSessionSummaryDto } from "../core/sessionProtocol.js";

export const BROWSER_GATEWAY_ASK_AGENT_TAB_ID = "ask-agent";
export const BROWSER_GATEWAY_ASK_AGENT_TAB_TITLE = "Ask Agent";

export type BrowserGatewayTabKind = "ask-agent" | "session-owner";

export interface BrowserGatewayAskAgentTab<
  TCapabilityId extends string = string,
> {
  kind: "ask-agent";
  tabId: typeof BROWSER_GATEWAY_ASK_AGENT_TAB_ID;
  title: typeof BROWSER_GATEWAY_ASK_AGENT_TAB_TITLE;
  pinned: true;
  order: 0;
  session: CoreSessionSummaryDto<TCapabilityId>;
}

export interface BrowserGatewaySessionOwnerTab {
  kind: "session-owner";
  tabId: string;
  title: string;
  pinned?: false;
  order: number;
  ownerId: string;
  sessionId?: string;
}

export type BrowserGatewaySessionTab<TCapabilityId extends string = string> =
  | BrowserGatewayAskAgentTab<TCapabilityId>
  | BrowserGatewaySessionOwnerTab;

export function createBrowserGatewayAskAgentTab<
  TCapabilityId extends string = string,
>(
  session: CoreSessionSummaryDto<TCapabilityId>,
): BrowserGatewayAskAgentTab<TCapabilityId> {
  if (session.mode !== "ask") {
    throw new Error("browser_gateway_ask_agent_requires_ask_mode");
  }
  if (session.owner.ownerKind !== "browser-gateway") {
    throw new Error("browser_gateway_ask_agent_requires_gateway_owner");
  }
  if (session.owner.scope.kind !== "projectless") {
    throw new Error("browser_gateway_ask_agent_requires_projectless_scope");
  }

  return {
    kind: "ask-agent",
    tabId: BROWSER_GATEWAY_ASK_AGENT_TAB_ID,
    title: BROWSER_GATEWAY_ASK_AGENT_TAB_TITLE,
    pinned: true,
    order: 0,
    session,
  };
}

export function orderBrowserGatewaySessionTabs<
  TCapabilityId extends string = string,
>(
  askAgentTab: BrowserGatewayAskAgentTab<TCapabilityId>,
  ownerTabs: readonly BrowserGatewaySessionOwnerTab[],
): BrowserGatewaySessionTab<TCapabilityId>[] {
  return [
    askAgentTab,
    ...ownerTabs.map((tab, index) => ({
      ...tab,
      pinned: false as const,
      order: index + 1,
    })),
  ];
}
