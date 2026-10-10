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
  /**
   * Live state, from hosts that track it: a turn is running, the chat is
   * waiting for an approval, or it finished while nobody was viewing it.
   */
  activity?: ChatSessionActivity;
  /** Started by a scheduled job rather than by someone writing to it. */
  scheduled?: boolean;
}

export type ChatSessionActivity = "running" | "needs-you" | "unread";
