import * as path from "path";

import type { AdvertisedArtifactProvider } from "../core/capabilities/readSearch.js";
import type { SkillCatalogDiagnostic } from "../core/tools/types.js";
import type { ApprovalManager } from "../approvals/ApprovalManager.js";
import type { ApprovalPanelProvider } from "../approvals/ApprovalPanelProvider.js";
import {
  errorResult,
  jsonResult,
  type ToolResult,
} from "@agentlink/protocol/tool-result";
import { createHash } from "crypto";
import { loadAdvertisedFile } from "./loadAdvertisedFile.js";

export interface AllowedSkill {
  id: string;
  name: string;
  revision: string;
  skillPath: string;
  realSkillPath: string;
  sourceScope: "builtin" | "global" | "ancestor" | "project";
}

/** Session activation produced only by a successful SKILL.md load. */
export interface SkillActivation {
  id: string;
  name: string;
  revision: string;
  skillPath: string;
}

export interface LoadSkillOutcome {
  result: ToolResult;
  /** Present only when the result activated a skill. */
  activation?: SkillActivation;
}

export const SKILL_RESOURCE_DEPRECATION =
  "load_skill only activates SKILL.md files. This built-in resource was read for compatibility without activating its skill; use read_skill_resource with skill_path and resource_path instead.";

export function isPathWithinDirectory(
  filePath: string,
  directory: string,
): boolean {
  const relative = path.relative(directory, filePath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function skillResourceGuidance(skill: AllowedSkill): string {
  return skill.sourceScope === "builtin"
    ? "Relative references in this skill resolve against skillDirectory. Read them only when needed with read_skill_resource using this skillPath as skill_path and the relative path as resource_path; reading a resource does not activate anything."
    : "Relative references in this skill resolve against skillDirectory. Read them only when needed with read_file using the absolute path; reading a resource does not activate anything.";
}

function staleSkillError(requestedPath: string): ToolResult {
  return errorResult(
    "Built-in skill changed after it was advertised; refresh the catalog before loading it",
    { path: requestedPath, status: "stale_advertised_artifact" },
  );
}

/**
 * Confirm a built-in owner still matches its advertised identity and revision.
 * Returns the normalized owner path, or a stale-artifact error result.
 */
export async function verifyAdvertisedSkillOwner(
  owner: AllowedSkill,
  requestedPath: string,
  artifactProvider: AdvertisedArtifactProvider,
): Promise<{ ownerPath: string } | { error: ToolResult }> {
  const ownerPath = artifactProvider.normalizeExistingPath(owner.skillPath);
  const realOwnerPath = artifactProvider.normalizeExistingPath(
    owner.realSkillPath,
  );
  if (ownerPath !== realOwnerPath) {
    return { error: staleSkillError(requestedPath) };
  }
  const ownerContent = await artifactProvider.readTextFile(ownerPath);
  if (
    createHash("sha256").update(ownerContent).digest("hex") !== owner.revision
  ) {
    return { error: staleSkillError(requestedPath) };
  }
  return { ownerPath };
}

function findOwningSkill(
  filePath: string,
  advertisedSkills: AllowedSkill[],
  artifactProvider: AdvertisedArtifactProvider,
  scope?: AllowedSkill["sourceScope"],
): AllowedSkill | undefined {
  return advertisedSkills.find((skill) => {
    if (scope && skill.sourceScope !== scope) return false;
    const skillDirectory = path.dirname(
      artifactProvider.normalizeExistingPath(skill.realSkillPath),
    );
    return isPathWithinDirectory(filePath, skillDirectory);
  });
}

/**
 * Temporary compatibility for older prompts that passed built-in reference
 * paths to load_skill. The file is returned as a non-activating resource.
 */
async function loadLegacyBuiltInSkillResource(
  params: { path: string },
  advertisedSkills: AllowedSkill[],
  artifactProvider: AdvertisedArtifactProvider,
): Promise<ToolResult | undefined> {
  const resourcePath = artifactProvider.normalizeExistingPath(
    artifactProvider.resolvePath(params.path),
  );
  const owner = findOwningSkill(
    resourcePath,
    advertisedSkills,
    artifactProvider,
    "builtin",
  );
  if (!owner) return undefined;
  if (
    resourcePath === artifactProvider.normalizeExistingPath(owner.realSkillPath)
  ) {
    // The owner's SKILL.md itself: activate through the normal path.
    return undefined;
  }

  const verified = await verifyAdvertisedSkillOwner(
    owner,
    params.path,
    artifactProvider,
  );
  if ("error" in verified) return verified.error;

  const skillDirectory = path.dirname(
    artifactProvider.normalizeExistingPath(owner.realSkillPath),
  );
  const content = await artifactProvider.readTextFile(resourcePath);
  return jsonResult({
    kind: "skill_resource",
    activation: false,
    skill_name: owner.name,
    skill_id: owner.id,
    skillPath: verified.ownerPath,
    revision: owner.revision,
    resource_path: path
      .relative(skillDirectory, resourcePath)
      .split(path.sep)
      .join("/"),
    resourcePath,
    content,
    deprecation: SKILL_RESOURCE_DEPRECATION,
  });
}

export async function loadSkill(
  params: { path: string },
  advertisedSkills: AllowedSkill[] = [],
  artifactProvider?: AdvertisedArtifactProvider,
  catalogDiagnostics: readonly SkillCatalogDiagnostic[] = [],
): Promise<LoadSkillOutcome> {
  if (artifactProvider) {
    const legacyResource = await loadLegacyBuiltInSkillResource(
      params,
      advertisedSkills,
      artifactProvider,
    );
    if (legacyResource) return { result: legacyResource };
  }

  const result = await loadAdvertisedFile({
    path: params.path,
    advertisedFiles: advertisedSkills.map((skill) => ({
      name: skill.name,
      filePath: skill.skillPath,
      resultFields: {
        kind: "skill_activation",
        skillPath: skill.skillPath,
        skillDirectory: path.dirname(skill.skillPath),
        skill_id: skill.id,
        revision: skill.revision,
        resourceGuidance: skillResourceGuidance(skill),
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

  if (!result.isError) {
    const data = result.data as { skill_id?: unknown; skillPath?: unknown };
    const skill = advertisedSkills.find(
      (candidate) =>
        candidate.id === data.skill_id &&
        candidate.skillPath === data.skillPath,
    );
    return skill
      ? {
          result,
          activation: {
            id: skill.id,
            name: skill.name,
            revision: skill.revision,
            skillPath: skill.skillPath,
          },
        }
      : { result };
  }

  const error =
    result.data && typeof result.data === "object" && "error" in result.data
      ? String(result.data.error)
      : "";
  if (!error.includes("not in the current session")) return { result };

  // Match discovery paths lexically, never through realpath resolution. Older
  // providers without a lexical resolver can safely match only absolute paths.
  const requestedPath = path.isAbsolute(params.path)
    ? path.resolve(params.path)
    : artifactProvider?.resolveLexicalPath?.(params.path);
  const diagnostics =
    requestedPath && path.basename(requestedPath) === "SKILL.md"
      ? catalogDiagnostics
          .filter(
            (diagnostic) =>
              path.resolve(diagnostic.sourcePath) ===
              path.resolve(requestedPath),
          )
          .slice(0, 8)
          .map((diagnostic) => ({
            code: diagnostic.code,
            severity: diagnostic.severity,
            message: diagnostic.message.slice(0, 1000),
          }))
      : [];

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
  const resourceOwner =
    candidates.length === 0 && artifactProvider
      ? findOwningSkill(
          artifactProvider.normalizeExistingPath(
            artifactProvider.resolvePath(params.path),
          ),
          advertisedSkills,
          artifactProvider,
        )
      : undefined;
  return {
    result: errorResult(error, {
      path: params.path,
      status: "skill_not_in_catalog",
      candidates,
      omittedCandidates: Math.max(0, matches.length - candidates.length),
      ...(diagnostics.length ? { diagnostics } : {}),
      guidance: diagnostics.length
        ? "This exact skill path was excluded during session catalogue discovery. Correct the reported problem through the normal reviewed workflow, then refresh the catalogue. Diagnostics are discovery evidence only; no skill has been activated and no file access has been granted."
        : candidates.length
          ? "Retry load_skill with the intended candidate's exact canonical path. No skill has been activated by this lookup."
          : resourceOwner
            ? `This path is a supporting file inside the ${resourceOwner.name} skill directory, not a skill. load_skill only activates SKILL.md files; read this file with read_file using its absolute path. No skill has been activated by this lookup.`
            : "No matching skill exists in the current session catalog. Refresh the session catalog or check the skill's enabled state and mode; reading an arbitrary file does not activate it.",
    }),
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
