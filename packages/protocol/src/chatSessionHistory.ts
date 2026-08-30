import type { ChatProjectInfo } from "./chatCatalog.js";

/** Serializable session-history row shared by chat host and UI surfaces. */
export interface ChatSessionHistorySummary {
  id: string;
  project?: ChatProjectInfo;
  mode: string;
  model: string;
  title: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  createdAt: number;
  lastActiveAt: number;
}
