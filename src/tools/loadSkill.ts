import * as path from "path";

import type { AdvertisedArtifactProvider } from "../core/capabilities/readSearch.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import { errorResult, type ToolResult } from "@agentlink/protocol/tool-result";
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

  const result = await loadAdvertisedFile({
    path: params.path,
    advertisedFiles: advertisedSkills.map((skill) => ({
      name: skill.name,
      filePath: skill.skillPath,
      resultFields: {
        skillPath: skill.skillPath,
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
  const error =
    result.data && typeof result.data === "object" && "error" in result.data
      ? String(result.data.error)
      : "";
  if (result.isError && error.includes("not in the current session")) {
    const requestedName =
      path.basename(params.path) === "SKILL.md"
        ? path.basename(path.dirname(params.path))
        : params.path;
    const matches = advertisedSkills.filter(
      (skill) => skill.name === requestedName || skill.id === requestedName,
    );
    const candidates = matches.slice(0, 10).map((skill) => ({
      id: skill.id,
      name: skill.name,
      path: skill.skillPath,
      revision: skill.revision,
    }));
    return errorResult(error, {
      path: params.path,
      status: "skill_not_in_catalog",
      candidates,
      omittedCandidates: Math.max(0, matches.length - candidates.length),
      guidance: candidates.length
        ? "Retry load_skill with the intended candidate's exact canonical path. No skill has been activated by this lookup."
        : "No matching skill exists in the current session catalog. Refresh the session catalog or check the skill's enabled state and mode; reading an arbitrary file does not activate it.",
    });
  }
  return result;
}
