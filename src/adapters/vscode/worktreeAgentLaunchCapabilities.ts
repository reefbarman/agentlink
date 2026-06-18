import type { OnApprovalRequest } from "../../shared/types.js";
import type { WorktreeAgentLaunchProvider } from "../../core/capabilities/worktree.js";
import { handleStartWorktreeAgent } from "../../tools/startWorktreeAgent.js";

export function createVscodeWorktreeAgentLaunchProvider(deps: {
  globalStorageUri: import("vscode").Uri;
  onApprovalRequest?: OnApprovalRequest;
  sessionId?: string | (() => string);
}): WorktreeAgentLaunchProvider {
  return {
    start(request) {
      return handleStartWorktreeAgent(request, {
        globalStorageUri: deps.globalStorageUri,
        onApprovalRequest: deps.onApprovalRequest,
        sessionId:
          typeof deps.sessionId === "function"
            ? deps.sessionId()
            : deps.sessionId,
      });
    },
  };
}
