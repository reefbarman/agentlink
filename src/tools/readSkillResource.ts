import * as path from "path";

import type { AdvertisedArtifactProvider } from "../core/capabilities/readSearch.js";
import {
  errorResult,
  jsonResult,
  type ToolResult,
} from "@agentlink/protocol/tool-result";
import {
  isPathWithinDirectory,
  verifyAdvertisedSkillOwner,
  type AllowedSkill,
} from "./loadSkill.js";

export const READ_SKILL_RESOURCE_DEFAULT_LIMIT = 2000;
export const READ_SKILL_RESOURCE_MAX_CHARS = 100_000;

export interface ReadSkillResourceParams {
  skill_path: string;
  resource_path: string;
  offset?: number;
  limit?: number;
}

function normalizeRelativeResourcePath(resourcePath: string): string | null {
  const trimmed = resourcePath.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  if (path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) return null;
  const segments = trimmed.split(/[\\/]+/);
  if (segments.includes("..")) return null;
  const normalized = segments.filter((s) => s && s !== ".").join("/");
  return normalized || null;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

/**
 * Read a supporting file from an advertised built-in skill without
 * activating the skill or granting any wider path trust.
 */
export async function handleReadSkillResource(
  params: ReadSkillResourceParams,
  advertisedSkills: AllowedSkill[],
  artifactProvider: AdvertisedArtifactProvider,
): Promise<ToolResult> {
  const details = {
    skill_path: params.skill_path,
    resource_path: params.resource_path,
  };
  let requestedOwnerPath: string;
  try {
    requestedOwnerPath = artifactProvider.normalizeExistingPath(
      artifactProvider.resolvePath(params.skill_path),
    );
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err), {
      ...details,
      status: "skill_not_in_catalog",
    });
  }
  const owner = advertisedSkills.find(
    (skill) =>
      artifactProvider.normalizeExistingPath(skill.skillPath) ===
        requestedOwnerPath ||
      artifactProvider.normalizeExistingPath(skill.realSkillPath) ===
        requestedOwnerPath,
  );
  if (!owner) {
    return errorResult(
      "skill_path is not an advertised SKILL.md in the current session catalog",
      {
        ...details,
        status: "skill_not_in_catalog",
        guidance:
          "Pass the exact SKILL.md path from the skill catalog (or the skillPath returned by load_skill) as skill_path.",
      },
    );
  }
  if (owner.sourceScope !== "builtin") {
    return errorResult(
      "read_skill_resource only reads resources of built-in AgentLink skills",
      {
        ...details,
        status: "unsupported_skill_scope",
        guidance:
          "Read supporting files of user, project, or global skills with read_file using the absolute path under the skill's directory.",
      },
    );
  }

  const resourcePath = normalizeRelativeResourcePath(params.resource_path);
  if (!resourcePath) {
    return errorResult(
      "resource_path must be a non-empty path relative to the skill directory without '..' segments",
      { ...details, status: "invalid_resource_path" },
    );
  }

  const verified = await verifyAdvertisedSkillOwner(
    owner,
    params.skill_path,
    artifactProvider,
  );
  if ("error" in verified) return verified.error;

  const skillDirectory = path.dirname(
    artifactProvider.normalizeExistingPath(owner.realSkillPath),
  );
  const absolutePath = artifactProvider.normalizeExistingPath(
    path.join(skillDirectory, ...resourcePath.split("/")),
  );
  if (
    absolutePath === skillDirectory ||
    !isPathWithinDirectory(absolutePath, skillDirectory)
  ) {
    return errorResult("resource_path resolves outside the skill directory", {
      ...details,
      status: "resource_outside_skill",
    });
  }
  if (
    absolutePath === artifactProvider.normalizeExistingPath(owner.realSkillPath)
  ) {
    return errorResult(
      "SKILL.md holds the skill's instructions, not a resource",
      {
        ...details,
        status: "invalid_resource_path",
        guidance:
          "Activate the skill with load_skill using skill_path instead of reading SKILL.md as a resource.",
      },
    );
  }

  let raw: string;
  try {
    raw = await artifactProvider.readTextFile(absolutePath);
  } catch (err) {
    const code = errorCode(err);
    return errorResult(
      code === "EISDIR"
        ? "resource_path is a directory, not a file"
        : code === "ENOENT"
          ? "resource_path does not exist in the skill directory"
          : err instanceof Error
            ? err.message
            : String(err),
      {
        ...details,
        status:
          code === "EISDIR"
            ? "resource_is_directory"
            : code === "ENOENT"
              ? "resource_not_found"
              : "resource_read_failed",
      },
    );
  }
  if (raw.includes("\0")) {
    return errorResult("resource_path is a binary file", {
      ...details,
      status: "binary_resource",
    });
  }

  const lines = raw.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const totalLines = lines.length;
  const offset = Math.max(1, Math.floor(params.offset ?? 1));
  const limit = Math.max(
    1,
    Math.floor(params.limit ?? READ_SKILL_RESOURCE_DEFAULT_LIMIT),
  );
  if (offset > Math.max(totalLines, 1)) {
    return errorResult(`offset ${offset} is past the end of the resource`, {
      ...details,
      status: "offset_out_of_range",
      total_lines: totalLines,
    });
  }

  const selected: string[] = [];
  let chars = 0;
  for (
    let index = offset - 1;
    index < totalLines && selected.length < limit;
    index += 1
  ) {
    const line = lines[index];
    if (
      selected.length > 0 &&
      chars + line.length + 1 > READ_SKILL_RESOURCE_MAX_CHARS
    ) {
      break;
    }
    selected.push(line);
    chars += line.length + 1;
  }
  const lastLine = offset - 1 + selected.length;
  const eof = lastLine >= totalLines;

  return jsonResult({
    kind: "skill_resource",
    activation: false,
    skill_name: owner.name,
    skill_id: owner.id,
    skillPath: verified.ownerPath,
    revision: owner.revision,
    resource_path: resourcePath,
    resourcePath: absolutePath,
    total_lines: totalLines,
    showing: selected.length ? `${offset}-${lastLine}` : "0-0",
    eof,
    ...(eof ? {} : { next_offset: lastLine + 1 }),
    content: selected.join("\n"),
  });
}
