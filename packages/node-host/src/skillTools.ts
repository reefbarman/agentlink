/**
 * Handlers for `load_skill`, `read_skill_resource` and `load_rule`, shared
 * by every AgentLink agent surface. Moved verbatim from VS Code's
 * `src/tools/loadAdvertisedFile.ts`, `loadSkill.ts`, `readSkillResource.ts`
 * and `loadRule.ts`, which now delegate here. Each surface supplies an
 * {@link AdvertisedArtifactProvider} for path resolution and reads.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import {
  errorResult,
  jsonResult,
  type ToolResult,
} from "@agentlink/protocol/tool-result";
import {
  parseUndiscoveredSkillEntry,
  type SkillEntry,
} from "./skillDiscovery.js";

/** How a surface resolves and reads advertised skill and rule files. */
export interface AdvertisedArtifactProvider {
  resolvePath(inputPath: string): string;
  /** Discovery identity only, without following symlinks or granting file access. */
  resolveLexicalPath?(inputPath: string): string;
  normalizeExistingPath(filePath: string): string;
  readTextFile(filePath: string): Promise<string>;
  /**
   * Whether `load_skill` may read and activate this canonical SKILL.md path
   * when it is absent from (or newer than) the session catalog. Return true
   * only for paths the agent could already read without approval. Omit to
   * keep activation limited to the catalog.
   */
  canLoadUndiscoveredSkill?(realSkillPath: string): boolean;
}

/** Session-scoped discovery evidence. This does not grant file or activation access. */
export interface SkillCatalogDiagnosticEvidence {
  code: string;
  severity: "warning" | "error";
  message: string;
  sourcePath: string;
}

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
  /**
   * Parsed entry for a skill read directly from disk because it was not in
   * the session catalog, or its bytes changed since discovery. The session
   * still decides whether to commit it.
   */
  entry?: SkillEntry;
}

export interface LoadSkillOutcome {
  result: ToolResult;
  /** Present only when the result activated a skill. */
  activation?: SkillActivation;
}

export interface AllowedRule {
  source: string;
  filePath: string;
  summary?: string;
}

export interface AllowedAdvertisedFile {
  name: string;
  filePath: string;
  resultFields?: Record<string, unknown>;
  expectedRealPath?: string;
  expectedSha256?: string;
}

function normalizeExistingPathSync(filePath: string): string {
  try {
    return path.normalize(fs.realpathSync(filePath));
  } catch {
    return path.normalize(path.resolve(filePath));
  }
}

/**
 * A provider over this machine's filesystem. Relative paths resolve
 * against `root` (default: the process working directory). It grants no
 * access by itself: the handlers only read advertised files.
 */
export function createNodeAdvertisedArtifactProvider(
  root?: string,
): AdvertisedArtifactProvider {
  const resolve = (inputPath: string) =>
    root ? path.resolve(root, inputPath) : path.resolve(inputPath);
  return {
    resolveLexicalPath: resolve,
    resolvePath: resolve,
    normalizeExistingPath: normalizeExistingPathSync,
    readTextFile(filePath) {
      return fsp.readFile(filePath, "utf-8");
    },
    // Skills not yet in the catalog may load only from inside the project.
    ...(root
      ? {
          canLoadUndiscoveredSkill: (realSkillPath: string) =>
            isPathWithinDirectory(
              realSkillPath,
              normalizeExistingPathSync(root),
            ),
        }
      : {}),
  };
}

// --- loadAdvertisedFile (was src/tools/loadAdvertisedFile.ts) ---

export async function loadAdvertisedFile(params: {
  path: string;
  advertisedFiles: AllowedAdvertisedFile[];
  kind: "skill" | "rule";
  pathProperty: "skillPath" | "rulePath";
  nameProperty: "skill_name" | "rule_name";
  allowlistLabel: string;
  contentTransform?: (raw: string) => string;
  artifactProvider?: AdvertisedArtifactProvider;
  /** Used when `artifactProvider` is absent. Defaults to the Node provider. */
  fallbackArtifactProvider?: AdvertisedArtifactProvider;
}): Promise<ToolResult> {
  try {
    const artifactProvider =
      params.artifactProvider ??
      params.fallbackArtifactProvider ??
      createNodeAdvertisedArtifactProvider();
    const absolutePath = artifactProvider.resolvePath(params.path);
    const normalizedAbsolutePath =
      artifactProvider.normalizeExistingPath(absolutePath);
    const allowed = params.advertisedFiles.find((file) => {
      try {
        return (
          artifactProvider.normalizeExistingPath(file.filePath) ===
          normalizedAbsolutePath
        );
      } catch {
        return false;
      }
    });

    if (!allowed) {
      return errorResult(
        `${params.kind[0].toUpperCase()}${params.kind.slice(1)} path is not in the current session's advertised ${params.allowlistLabel} allowlist`,
        params.path ? { path: params.path } : undefined,
      );
    }

    if (
      allowed.expectedRealPath &&
      artifactProvider.normalizeExistingPath(allowed.expectedRealPath) !==
        normalizedAbsolutePath
    ) {
      return errorResult(
        `${params.kind[0].toUpperCase()}${params.kind.slice(1)} changed after it was advertised; refresh the catalog before loading it`,
        { path: params.path, status: "stale_advertised_artifact" },
      );
    }

    const raw = await artifactProvider.readTextFile(absolutePath);
    if (
      allowed.expectedSha256 &&
      createHash("sha256").update(raw).digest("hex") !== allowed.expectedSha256
    ) {
      return errorResult(
        `${params.kind[0].toUpperCase()}${params.kind.slice(1)} changed after it was advertised; refresh the catalog before loading it`,
        { path: params.path, status: "stale_advertised_artifact" },
      );
    }
    const content = params.contentTransform?.(raw) ?? raw;

    return jsonResult(
      {
        [params.nameProperty]: allowed.name,
        [params.pathProperty]: absolutePath,
        ...allowed.resultFields,
        content,
      },
      true,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(
      message,
      params.path ? { path: params.path } : undefined,
    );
  }
}

// --- load_skill (was src/tools/loadSkill.ts) ---

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
  catalogDiagnostics: readonly SkillCatalogDiagnosticEvidence[] = [],
  /** Reads with this provider when `artifactProvider` is absent. */
  fallbackArtifactProvider?: AdvertisedArtifactProvider,
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
    fallbackArtifactProvider,
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
  const status =
    result.data && typeof result.data === "object" && "status" in result.data
      ? result.data.status
      : undefined;
  if (
    error.includes("not in the current session") ||
    status === "stale_advertised_artifact"
  ) {
    const direct = await loadUndiscoveredSkill(
      params,
      advertisedSkills,
      artifactProvider,
    );
    if (direct) return direct;
  }
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

  // A built-in skill path from an older or newer extension install (for
  // example after an update mid-session) names the same bundled skill as the
  // live catalog entry. Follow it to that entry instead of failing; the load
  // still goes through the normal advertised-path verification.
  const builtInRedirect =
    !diagnostics.length && requestedPath
      ? builtInSkillRedirect(requestedPath, matches)
      : undefined;
  if (builtInRedirect) {
    const redirected = await loadSkill(
      { path: builtInRedirect.skillPath },
      advertisedSkills,
      artifactProvider,
      catalogDiagnostics,
      fallbackArtifactProvider,
    );
    if (!redirected.result.isError && redirected.activation) {
      const data = redirected.result.data as Record<string, unknown>;
      return {
        result: jsonResult({
          ...data,
          requestedPath: params.path,
          pathNote:
            "The requested built-in skill path belongs to a different extension install. Loaded the current catalog entry; use skillPath for later references.",
        }),
        activation: redirected.activation,
      };
    }
  }

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

/**
 * Read a SKILL.md the agent may already read, when the session catalog does
 * not list it or lists older bytes. The catalog is for discovery; it is not a
 * second read permission. Returns undefined to fall back to the catalog error
 * when the host does not allow this path or the file cannot be read.
 */
async function loadUndiscoveredSkill(
  params: { path: string },
  advertisedSkills: readonly AllowedSkill[],
  artifactProvider: AdvertisedArtifactProvider | undefined,
): Promise<LoadSkillOutcome | undefined> {
  if (!artifactProvider?.canLoadUndiscoveredSkill) return undefined;
  let requestedPath: string;
  let realSkillPath: string;
  let raw: string;
  try {
    requestedPath = artifactProvider.resolvePath(params.path);
    if (path.basename(requestedPath) !== "SKILL.md") return undefined;
    realSkillPath = artifactProvider.normalizeExistingPath(requestedPath);
    if (!artifactProvider.canLoadUndiscoveredSkill(realSkillPath)) {
      return undefined;
    }
    raw = await artifactProvider.readTextFile(realSkillPath);
  } catch {
    return undefined;
  }

  const known = advertisedSkills.find((skill) => {
    try {
      return (
        artifactProvider.normalizeExistingPath(skill.realSkillPath) ===
        realSkillPath
      );
    } catch {
      return false;
    }
  });
  const skillPath = known?.skillPath ?? requestedPath;
  const parsed = parseUndiscoveredSkillEntry({
    raw,
    skillPath,
    realSkillPath,
    id: known?.id,
    scope: known?.sourceScope,
  });
  if ("diagnostic" in parsed) {
    return {
      result: errorResult(
        `SKILL.md metadata is invalid: ${parsed.diagnostic.message}`,
        {
          path: params.path,
          status: "invalid_skill",
          diagnostics: [
            {
              code: parsed.diagnostic.code,
              severity: "error",
              message: parsed.diagnostic.message.slice(0, 1000),
            },
          ],
          guidance:
            "Fix the reported frontmatter problem, then load the skill again. No skill has been activated.",
        },
      ),
    };
  }
  const entry = parsed.entry;
  if (!entry.enabled) {
    return {
      result: errorResult("Skill is disabled by its frontmatter", {
        path: params.path,
        status: "skill_disabled",
      }),
    };
  }
  if (entry.dependencies.length > 0) {
    return {
      result: errorResult(
        "Skill declares dependencies, which are resolved only for skills in the session catalog",
        {
          path: params.path,
          status: "skill_not_in_catalog",
          guidance:
            "The catalog refreshes automatically when skill files change. Retry load_skill shortly. No skill has been activated.",
        },
      ),
    };
  }

  return {
    result: jsonResult(
      {
        skill_name: entry.name,
        skillPath,
        kind: "skill_activation",
        skillDirectory: path.dirname(skillPath),
        skill_id: entry.id,
        revision: entry.revision,
        resourceGuidance: skillResourceGuidance({
          ...entry,
          skillPath,
          realSkillPath,
          sourceScope: entry.provenance.scope,
        }),
        catalogNote: known
          ? "Loaded the current file, which changed after the session catalog was built."
          : "Loaded directly from disk; this skill was not in the session catalog yet.",
        content: raw,
      },
      true,
    ),
    activation: {
      id: entry.id,
      name: entry.name,
      revision: entry.revision,
      skillPath,
      entry,
    },
  };
}

const BUILTIN_SKILL_SUFFIX =
  /[\\/]resources[\\/]builtin-skills[\\/]([^\\/]+)[\\/]SKILL\.md$/;

/**
 * The unique built-in catalog skill a stale built-in `SKILL.md` path refers
 * to: same bundled skill directory name, differing only in install root.
 */
function builtInSkillRedirect(
  requestedPath: string,
  matches: readonly AllowedSkill[],
): AllowedSkill | undefined {
  const requestedDir = BUILTIN_SKILL_SUFFIX.exec(requestedPath)?.[1];
  if (!requestedDir) return undefined;
  const builtIns = matches.filter(
    (skill) =>
      skill.sourceScope === "builtin" &&
      BUILTIN_SKILL_SUFFIX.exec(skill.skillPath)?.[1] === requestedDir,
  );
  return builtIns.length === 1 &&
    path.resolve(builtIns[0].skillPath) !== path.resolve(requestedPath)
    ? builtIns[0]
    : undefined;
}

// --- read_skill_resource (was src/tools/readSkillResource.ts) ---

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

// --- load_rule (was src/tools/loadRule.ts) ---

function stripRuleFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;

  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;

  return content.slice(end + 4).trim();
}

export async function loadRule(
  params: { path: string },
  advertisedRules: AllowedRule[] = [],
  artifactProvider?: AdvertisedArtifactProvider,
  /** Reads with this provider when `artifactProvider` is absent. */
  fallbackArtifactProvider?: AdvertisedArtifactProvider,
): Promise<ToolResult> {
  return loadAdvertisedFile({
    path: params.path,
    advertisedFiles: advertisedRules.map((rule) => ({
      name: rule.summary ? `${rule.source} — ${rule.summary}` : rule.source,
      filePath: rule.filePath,
    })),
    kind: "rule",
    pathProperty: "rulePath",
    nameProperty: "rule_name",
    allowlistLabel: "rule",
    contentTransform: stripRuleFrontmatter,
    artifactProvider,
    fallbackArtifactProvider,
  });
}
