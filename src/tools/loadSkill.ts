import type { AdvertisedArtifactProvider } from "../core/capabilities/readSearch.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { ToolResult } from "../shared/types.js";
import { loadAdvertisedFile } from "./loadAdvertisedFile.js";

interface AllowedSkill {
  id: string;
  name: string;
  revision: string;
  skillPath: string;
  realSkillPath: string;
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
      resultFields: {
        skill_id: skill.id,
        revision: skill.revision,
      },
      expectedRealPath: skill.realSkillPath,
      expectedSha256: skill.revision,
    })),
    kind: "skill",
    pathProperty: "skillPath",
    nameProperty: "skill_name",
    allowlistLabel: "skill",
    artifactProvider,
  });
}
