import {
  BROWSER_GATEWAY_ASK_AGENT_TAB_ID,
  BROWSER_GATEWAY_ASK_AGENT_TAB_TITLE,
  createBrowserGatewayAskAgentTab,
  orderBrowserGatewaySessionTabs,
} from "./askAgentTabs.js";
import { describe, expect, it } from "vitest";

import type { CoreSessionSummaryDto } from "../core/sessionProtocol.js";
import { createProjectlessSessionOwner } from "../core/sessionProtocol.js";

function makeAskSession(
  overrides: Partial<CoreSessionSummaryDto> = {},
): CoreSessionSummaryDto {
  return {
    sessionId: "ask-session",
    title: "Ask Agent",
    mode: "ask",
    model: "gpt-5.3-codex",
    lifecycle: "idle",
    owner: createProjectlessSessionOwner({
      ownerId: "gateway-owner",
      ownerKind: "browser-gateway",
      displayName: "Browser Gateway",
      scopeId: "default-ask-agent",
      scopeDisplayName: "Ask Agent",
      now: 100,
    }),
    capabilities: [],
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

describe("browser gateway Ask Agent tabs", () => {
  it("projects a projectless gateway-owned ask session into the pinned Ask Agent tab", () => {
    const tab = createBrowserGatewayAskAgentTab(makeAskSession());

    expect(tab).toMatchObject({
      kind: "ask-agent",
      tabId: BROWSER_GATEWAY_ASK_AGENT_TAB_ID,
      title: BROWSER_GATEWAY_ASK_AGENT_TAB_TITLE,
      pinned: true,
      order: 0,
      session: { sessionId: "ask-session", mode: "ask" },
    });
  });

  it("orders Ask Agent before VS Code-owned session tabs", () => {
    const askTab = createBrowserGatewayAskAgentTab(makeAskSession());

    const tabs = orderBrowserGatewaySessionTabs(askTab, [
      {
        kind: "session-owner",
        tabId: "vscode-owner-a",
        title: "VS Code · agentlink",
        order: 99,
        ownerId: "vscode-owner-a",
        sessionId: "session-a",
      },
      {
        kind: "session-owner",
        tabId: "vscode-owner-b",
        title: "VS Code · other",
        order: 99,
        ownerId: "vscode-owner-b",
        sessionId: "session-b",
      },
    ]);

    expect(tabs.map((tab) => tab.tabId)).toEqual([
      "ask-agent",
      "vscode-owner-a",
      "vscode-owner-b",
    ]);
    expect(tabs.map((tab) => tab.order)).toEqual([0, 1, 2]);
    expect(tabs.map((tab) => tab.pinned)).toEqual([true, false, false]);
  });

  it("rejects non-ask modes for the Ask Agent tab", () => {
    expect(() =>
      createBrowserGatewayAskAgentTab(makeAskSession({ mode: "code" })),
    ).toThrow("browser_gateway_ask_agent_requires_ask_mode");
  });

  it("rejects non-gateway owners for the Ask Agent tab", () => {
    const session = makeAskSession({
      owner: createProjectlessSessionOwner({
        ownerId: "cli-owner",
        ownerKind: "cli",
        displayName: "CLI",
        scopeId: "cli-projectless",
        scopeDisplayName: "CLI projectless",
        now: 100,
      }),
    });

    expect(() => createBrowserGatewayAskAgentTab(session)).toThrow(
      "browser_gateway_ask_agent_requires_gateway_owner",
    );
  });

  it("rejects workspace-scoped sessions for the Ask Agent tab", () => {
    const session = makeAskSession({
      owner: {
        ownerId: "gateway-owner",
        ownerKind: "browser-gateway",
        displayName: "Browser Gateway",
        scope: {
          kind: "workspace",
          workspaceId: "workspace-1",
          displayName: "Workspace",
        },
        acquiredAt: 100,
      },
    });

    expect(() => createBrowserGatewayAskAgentTab(session)).toThrow(
      "browser_gateway_ask_agent_requires_projectless_scope",
    );
  });
});
