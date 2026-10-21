import { loadRule, type AllowedRule } from "@agentlink/node-host";
import type { AdvertisedArtifactProvider } from "../core/capabilities/readSearch.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { ToolResult } from "@agentlink/protocol/tool-result";
import { createLegacyAdvertisedArtifactProvider } from "./loadAdvertisedFile.js";

export type { AllowedRule } from "@agentlink/node-host";

/**
 * VS Code's `load_rule`. The handler is shared with every agent surface
 * (`skillTools.ts` in `@agentlink/node-host`).
 */
export async function handleLoadRule(
  params: {
    path: string;
  },
  _approvalManager: ApprovalManager,
  _approvalPanel: ApprovalPanelProvider,
  _sessionId: string,
  advertisedRules: AllowedRule[] = [],
  artifactProvider?: AdvertisedArtifactProvider,
): Promise<ToolResult> {
  return loadRule(
    params,
    advertisedRules,
    artifactProvider,
    artifactProvider ? undefined : createLegacyAdvertisedArtifactProvider(),
  );
}
