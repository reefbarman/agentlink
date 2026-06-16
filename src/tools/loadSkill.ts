import type { AdvertisedArtifactProvider } from "../core/capabilities/readSearch.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { ToolResult } from "../shared/types.js";
import { loadAdvertisedFile } from "./loadAdvertisedFile.js";

interface AllowedSkill {
  name: string;
  skillPath: string;
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
): Promise<ToolResult> {
  return loadAdvertisedFile({
    path: params.path,
    advertisedFiles: advertisedSkills.map((skill) => ({
      name: skill.name,
      filePath: skill.skillPath,
    })),
    kind: "skill",
    pathProperty: "skillPath",
    nameProperty: "skill_name",
    allowlistLabel: "skill",
    artifactProvider,
  });
}
