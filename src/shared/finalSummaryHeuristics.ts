/**
 * Heuristics for detecting final-status summaries that claim or promise a
 * deliverable without containing it. Shared by the VS Code agent's
 * `set_task_status` handling, the browser Ask Agent turn loop, and the SDK's
 * standalone hosts through `@agentlink/core/interaction-tools`.
 */
export {
  isRecapOnlyFinalSummary,
  isTeaserOnlyFinalSummary,
} from "@agentlink/core/interaction-tools";
