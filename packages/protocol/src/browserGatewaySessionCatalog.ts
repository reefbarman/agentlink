import type { BrowserGatewayChatWorkspaceSummary } from "./browserGatewayChatWorkspaceSummary.js";

export interface BrowserGatewayProjectSummary {
  projectId: string;
  displayName: string;
  availability: "available" | "unavailable";
}

export interface BrowserGatewaySessionSummary {
  sessionId: string;
  projectId: string | null;
  title: string;
  mode: string;
  model: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface BrowserGatewaySessionCatalog {
  projects: BrowserGatewayProjectSummary[];
  sessions: BrowserGatewaySessionSummary[];
  defaultProjectId: string | null;
  foregroundSessionId: string | null;
  chatWorkspace?: BrowserGatewayChatWorkspaceSummary | null;
}
