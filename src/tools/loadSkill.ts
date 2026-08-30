import * as path from "path";

import type { AdvertisedArtifactProvider } from "../core/capabilities/readSearch.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import type { ToolResult } from "@agentlink/protocol/tool-result";
import { createHash } from "crypto";
import { loadAdvertisedFile } from "./loadAdvertisedFile.js";

interface AllowedSkill {
  id: string;
  name: string;
  revision: string;
  skillPath: string;
  realSkillPath: string;
  sourceScope: "builtin" | "global" | "ancestor" | "project";
}

function isPathWithinDirectory(filePath: string, directory: string): boolean {
  const relative = path.relative(directory, filePath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function loadBuiltInSkillResource(
  params: { path: string },
  advertisedSkills: AllowedSkill[],
  artifactProvider: AdvertisedArtifactProvider,
): Promise<ToolResult | undefined> {
  const resourcePath = artifactProvider.normalizeExistingPath(
    artifactProvider.resolvePath(params.path),
  );
  const owner = advertisedSkills.find((skill) => {
    if (skill.sourceScope !== "builtin") return false;
    const skillDirectory = path.dirname(
      artifactProvider.normalizeExistingPath(skill.realSkillPath),
    );
    return isPathWithinDirectory(resourcePath, skillDirectory);
  });
  if (!owner) return undefined;

  const ownerPath = artifactProvider.normalizeExistingPath(owner.skillPath);
  const realOwnerPath = artifactProvider.normalizeExistingPath(
    owner.realSkillPath,
  );
  if (ownerPath !== realOwnerPath) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error:
              "Built-in skill changed after it was advertised; refresh the catalog before loading it",
            path: params.path,
            status: "stale_advertised_artifact",
          }),
        },
      ],
      isError: true,
    };
  }

  const ownerContent = await artifactProvider.readTextFile(ownerPath);
  if (
    createHash("sha256").update(ownerContent).digest("hex") !== owner.revision
  ) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error:
              "Built-in skill changed after it was advertised; refresh the catalog before loading it",
            path: params.path,
            status: "stale_advertised_artifact",
          }),
        },
      ],
      isError: true,
    };
  }

  const content = await artifactProvider.readTextFile(resourcePath);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          skill_name: owner.name,
          skillPath: ownerPath,
          skill_id: owner.id,
          revision: owner.revision,
          resourcePath,
          content,
        }),
      },
    ],
  };
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
  const provider = artifactProvider;
  if (provider) {
    const builtInResource = await loadBuiltInSkillResource(
      params,
      advertisedSkills,
      provider,
    );
    if (builtInResource) return builtInResource;
  }

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
