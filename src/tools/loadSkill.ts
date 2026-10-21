import {
  loadSkill as loadSharedSkill,
  type AllowedSkill,
  type LoadSkillOutcome,
} from "@agentlink/node-host";
import type { AdvertisedArtifactProvider } from "../core/capabilities/readSearch.js";
import type { SkillCatalogDiagnostic } from "../core/tools/types.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { ToolResult } from "@agentlink/protocol/tool-result";
import { createLegacyAdvertisedArtifactProvider } from "./loadAdvertisedFile.js";

/**
 * VS Code's `load_skill`. The handler is shared with every agent surface
 * (`skillTools.ts` in `@agentlink/node-host`).
 */
export {
  SKILL_RESOURCE_DEPRECATION,
  isPathWithinDirectory,
  skillResourceGuidance,
  verifyAdvertisedSkillOwner,
  type AllowedSkill,
  type LoadSkillOutcome,
  type SkillActivation,
} from "@agentlink/node-host";

export async function loadSkill(
  params: { path: string },
  advertisedSkills: AllowedSkill[] = [],
  artifactProvider?: AdvertisedArtifactProvider,
  catalogDiagnostics: readonly SkillCatalogDiagnostic[] = [],
): Promise<LoadSkillOutcome> {
  return loadSharedSkill(
    params,
    advertisedSkills,
    artifactProvider,
    catalogDiagnostics,
    artifactProvider ? undefined : createLegacyAdvertisedArtifactProvider(),
  );
}

export async function handleLoadSkill(
  params: {
    path: string;
  },
  _approvalManager: ApprovalManager,
  _approvalPanel: ApprovalPanelProvider,
  _sessionId: string,
  advertisedSkills: AllowedSkill[] = [],
  artifactProvider?: AdvertisedArtifactProvider,
  catalogDiagnostics: readonly SkillCatalogDiagnostic[] = [],
): Promise<ToolResult> {
  return (
    await loadSkill(
      params,
      advertisedSkills,
      artifactProvider,
      catalogDiagnostics,
    )
  ).result;
}
