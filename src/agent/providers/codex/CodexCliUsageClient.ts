/**
 * @deprecated Usage is now read directly with AgentLink's OAuth account. This
 * compatibility module no longer invokes the local Codex CLI.
 */
export {
  queryCodexUsage as queryCodexCliUsage,
  type CodexCliUsageResult,
  type CodexRateLimitSnapshot,
  type CodexRateLimitWindow,
  type CodexSubscriptionUsage,
  type CodexUsageResult,
} from "./CodexUsageClient.js";
