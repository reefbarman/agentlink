import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { Dirent } from "fs";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { parseDocument } from "yaml";

const BUNDLED_SKILLS_DIRS = [
  path.resolve(__dirname, "..", "resources", "builtin-skills"),
  path.resolve(__dirname, "..", "..", "resources", "builtin-skills"),
];

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SkillSourceScope = "builtin" | "global" | "ancestor" | "project";
export type SkillSourceNamespace = "agents" | "claude" | "agentlink";
export type SkillDiagnosticSeverity = "warning" | "error";

export interface SkillProvenance {
  scope: SkillSourceScope;
  namespace: SkillSourceNamespace;
  modeSlug?: string;
  sourceRoot: string;
  skillDirectory: string;
  realSkillPath: string;
  priority: number;
}

export interface SkillRestrictions {
  /** Tool names this skill permits from the already-authorized runtime set. */
  allowedTools?: string[];
}

export interface SkillPermissions {
  /** Descriptive capability requests. These never grant runtime authority. */
  requestedTools: string[];
}

export interface SkillEntry {
  /** Canonical, source-qualified identity. */
  id: string;
  name: string;
  description: string;
  /** SHA-256 revision of the exact authoritative SKILL.md bytes. */
  revision: string;
  /** Exact UTF-16 character count of the authoritative SKILL.md source. */
  sourceChars: number;
  provenance: SkillProvenance;
  /** Absolute path to the authoritative SKILL.md file. */
  skillPath: string;
  /** Full SKILL.md body. Only populated by loaders that explicitly request it. */
  body?: string;
  /** Compatibility projection of restrictions.allowedTools. */
  allowedTools?: string[];
  restrictions: SkillRestrictions;
  permissions: SkillPermissions;
  dependencies: string[];
  recommendations: string[];
  resolvedDependencies: string[];
  /** Optional invocation mode declared by SKILL.md frontmatter. */
  invocation?: "auto" | "manual";
  enabled: boolean;
  disabledReason?:
    | "declared"
    | "configuration"
    | "missing-dependency"
    | "ambiguous-dependency"
    | "dependency-cycle";
}

export interface SkillDiagnostic {
  code:
    | "invalid-frontmatter"
    | "invalid-metadata"
    | "unreadable-skill"
    | "unsafe-symlink"
    | "name-collision"
    | "missing-dependency"
    | "ambiguous-dependency"
    | "dependency-cycle";
  severity: SkillDiagnosticSeverity;
  message: string;
  sourcePath: string;
  skillId?: string;
  relatedSkillIds?: string[];
}

export interface SkillCollision {
  name: string;
  skillIds: string[];
}

export interface SkillCatalogSnapshot {
  schemaVersion: 1;
  revision: string;
  cwd?: string;
  modeSlug: string;
  entries: SkillEntry[];
  diagnostics: SkillDiagnostic[];
  collisions: SkillCollision[];
}

export interface SkillCapabilityPolicySnapshot {
  schemaVersion: 1;
  revision: string;
  skillIds: string[];
  dependencies: string[];
  recommendations: string[];
  requestedTools: string[];
  /** Undefined means no loaded skill adds a tool restriction. */
  allowedTools?: string[];
}

interface RawSkill extends SkillEntry {
  modeSlugs?: string[];
}

interface SkillSource {
  scope: SkillSourceScope;
  namespace: SkillSourceNamespace;
  modeSlug?: string;
  dir: string;
  identityRoot?: string;
  priority: number;
}

export interface SkillCatalogOptions {
  includeBody?: boolean;
  disabledSkillIds?: readonly string[];
}

type FrontmatterRecord = Record<string, unknown>;

export class SkillFrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillFrontmatterError";
  }
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeContent(content: string): string {
  return content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function extractFrontmatterSource(content: string): string | undefined {
  const normalized = normalizeContent(content);
  if (!normalized.startsWith("---\n")) return undefined;
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    throw new SkillFrontmatterError("SKILL.md frontmatter is not terminated");
  }
  const closingRemainder = normalized.slice(end + 4);
  if (closingRemainder && !closingRemainder.startsWith("\n")) {
    throw new SkillFrontmatterError(
      "SKILL.md frontmatter closing delimiter must occupy its own line",
    );
  }
  return normalized.slice(4, end);
}

/** Parse standards-compatible YAML frontmatter from a SKILL.md document. */
export function parseFrontmatter(content: string): FrontmatterRecord {
  const source = extractFrontmatterSource(content);
  if (source === undefined) return {};

  const document = parseDocument(source, {
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new SkillFrontmatterError(
      document.errors.map((error) => error.message).join("; "),
    );
  }

  const parsed = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (parsed === null || parsed === undefined) return {};
  if (Array.isArray(parsed) || typeof parsed !== "object") {
    throw new SkillFrontmatterError(
      "SKILL.md frontmatter must be a YAML mapping",
    );
  }
  return parsed as FrontmatterRecord;
}

function stripFrontmatterBody(content: string): string {
  const normalized = normalizeContent(content);
  const source = extractFrontmatterSource(normalized);
  if (source === undefined) return normalized.trim();
  const end = normalized.indexOf("\n---", 4);
  return normalized.slice(end + 4).trim();
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === "string")) return undefined;
    return value.map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return undefined;
}

function readMapping(value: unknown): FrontmatterRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as FrontmatterRecord)
    : undefined;
}

function parseInvocation(value: unknown): "auto" | "manual" | undefined {
  const raw = readString(value)?.toLowerCase();
  if (raw === "auto" || raw === "automatic") return "auto";
  if (raw === "manual" || raw === "manual-only") return "manual";
  return undefined;
}

function validateSkillMetadata(
  frontmatter: FrontmatterRecord,
  directoryName: string,
): string[] {
  const errors: string[] = [];
  const name = readString(frontmatter.name);
  const description = readString(frontmatter.description);
  if (!name) {
    errors.push("frontmatter field 'name' is required");
  } else {
    if (name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
      errors.push(
        "frontmatter field 'name' must be a lowercase hyphenated slug of at most 64 characters",
      );
    }
    if (name !== directoryName) {
      errors.push(
        `frontmatter field 'name' (${name}) must match its parent directory (${directoryName})`,
      );
    }
  }
  if (!description) {
    errors.push("frontmatter field 'description' is required");
  } else if (description.length > 1024) {
    errors.push(
      "frontmatter field 'description' must not exceed 1024 characters",
    );
  }
  if (
    frontmatter.enabled !== undefined &&
    readBoolean(frontmatter.enabled) === undefined
  ) {
    errors.push("frontmatter field 'enabled' must be a boolean");
  }
  return errors;
}

function pathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function sourceIdentitySegment(
  source: SkillSource,
  skillDirectory: string,
): string {
  return (
    toPosix(path.relative(source.identityRoot ?? source.dir, skillDirectory)) ||
    "."
  );
}

function buildSkillId(source: SkillSource, skillDirectory: string): string {
  const mode = source.modeSlug ? `:${source.modeSlug}` : "";
  const identityScope = source.scope === "ancestor" ? "project" : source.scope;
  return `${identityScope}:${source.namespace}${mode}:${sourceIdentitySegment(source, skillDirectory)}`;
}

async function scanSkillsDir(
  source: SkillSource,
  cwd: string | undefined,
  options: { includeBody?: boolean },
): Promise<{ entries: RawSkill[]; diagnostics: SkillDiagnostic[] }> {
  const entries: RawSkill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  let realSourceRoot: string;
  let dirEntries: Dirent<string>[];
  try {
    realSourceRoot = await fs.realpath(source.dir);
    dirEntries = await fs.readdir(source.dir, { withFileTypes: true });
  } catch {
    return { entries, diagnostics };
  }

  for (const entry of [...dirEntries].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const candidateDirectory = path.join(source.dir, entry.name);
    let realSkillDirectory: string;
    try {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      realSkillDirectory = await fs.realpath(candidateDirectory);
      if (!pathWithin(realSkillDirectory, realSourceRoot)) {
        diagnostics.push({
          code: "unsafe-symlink",
          severity: "error",
          message: "Skill directory symlink escapes its declared source root",
          sourcePath: candidateDirectory,
        });
        continue;
      }
      const stat = await fs.stat(realSkillDirectory);
      if (!stat.isDirectory()) continue;
    } catch {
      diagnostics.push({
        code: "unreadable-skill",
        severity: "warning",
        message: "Skill directory is unreadable or points to a missing target",
        sourcePath: candidateDirectory,
      });
      continue;
    }

    const skillPath = path.join(candidateDirectory, "SKILL.md");
    let realSkillPath: string;
    let raw: string;
    try {
      realSkillPath = await fs.realpath(skillPath);
      if (!pathWithin(realSkillPath, realSourceRoot)) {
        diagnostics.push({
          code: "unsafe-symlink",
          severity: "error",
          message: "SKILL.md symlink escapes its declared source root",
          sourcePath: skillPath,
        });
        continue;
      }
      raw = await fs.readFile(realSkillPath, "utf-8");
    } catch {
      continue;
    }

    let frontmatter: FrontmatterRecord;
    try {
      frontmatter = parseFrontmatter(raw);
    } catch (error) {
      diagnostics.push({
        code: "invalid-frontmatter",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
        sourcePath: skillPath,
      });
      continue;
    }

    const metadataErrors = validateSkillMetadata(frontmatter, entry.name);
    if (metadataErrors.length > 0) {
      diagnostics.push({
        code: "invalid-metadata",
        severity: "error",
        message: metadataErrors.join("; "),
        sourcePath: skillPath,
      });
      continue;
    }

    const restrictions = readMapping(frontmatter.restrictions);
    const permissions = readMapping(frontmatter.permissions);
    const declaredAllowedToolsValue =
      restrictions &&
      (Object.hasOwn(restrictions, "allowed-tools") ||
        Object.hasOwn(restrictions, "allowedTools"))
        ? readStringArray(
            restrictions["allowed-tools"] ?? restrictions.allowedTools,
          )
        : Object.hasOwn(frontmatter, "allowed-tools") ||
            Object.hasOwn(frontmatter, "allowedTools")
          ? readStringArray(
              frontmatter["allowed-tools"] ?? frontmatter.allowedTools,
            )
          : undefined;
    const declaredAllowedTools = declaredAllowedToolsValue?.length
      ? declaredAllowedToolsValue
      : undefined;
    const requestedTools =
      readStringArray(
        permissions?.tools ??
          permissions?.["requested-tools"] ??
          permissions?.requestedTools,
      ) ?? [];
    const name = readString(frontmatter.name)!;
    const description = readString(frontmatter.description)!;
    const id = buildSkillId(source, candidateDirectory);
    const revision = createHash("sha256").update(raw).digest("hex");

    entries.push({
      id,
      name,
      description,
      revision,
      sourceChars: raw.length,
      provenance: {
        scope: source.scope,
        namespace: source.namespace,
        modeSlug: source.modeSlug,
        sourceRoot: source.dir,
        skillDirectory: candidateDirectory,
        realSkillPath,
        priority: source.priority,
      },
      skillPath,
      ...(options.includeBody ? { body: stripFrontmatterBody(raw) } : {}),
      allowedTools: declaredAllowedTools,
      restrictions: { allowedTools: declaredAllowedTools },
      permissions: { requestedTools },
      dependencies: readStringArray(frontmatter.dependencies) ?? [],
      recommendations:
        readStringArray(
          frontmatter.recommendations ?? frontmatter.recommends,
        ) ?? [],
      resolvedDependencies: [],
      invocation: parseInvocation(
        frontmatter.invocation ?? frontmatter.activation,
      ),
      enabled: readBoolean(frontmatter.enabled) ?? true,
      ...(readBoolean(frontmatter.enabled) === false
        ? { disabledReason: "declared" as const }
        : {}),
      modeSlugs:
        readStringArray(frontmatter.modeSlugs ?? frontmatter["mode-slugs"]) ??
        undefined,
    });
  }

  return { entries, diagnostics };
}

export function getSkillDiscoveryRoots(cwd: string): string[] {
  const resolvedCwd = path.resolve(cwd);
  let repositoryRoot: string | undefined;
  let current = resolvedCwd;
  while (true) {
    if (existsSync(path.join(current, ".git"))) {
      repositoryRoot = current;
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const boundary = repositoryRoot ?? resolvedCwd;
  const roots: string[] = [];
  current = resolvedCwd;
  while (true) {
    roots.push(current);
    if (current === boundary) break;
    const parent = path.dirname(current);
    if (parent === current || !pathWithin(parent, boundary)) break;
    current = parent;
  }
  return roots.reverse();
}

function addSourcePair(
  sources: SkillSource[],
  scope: SkillSourceScope,
  namespace: SkillSourceNamespace,
  root: string,
  modeSlug: string,
  identityRoot?: string,
): void {
  sources.push({
    scope,
    namespace,
    dir: path.join(root, `skills`),
    identityRoot,
    priority: sources.length,
  });
  sources.push({
    scope,
    namespace,
    modeSlug,
    dir: path.join(root, `skills-${modeSlug}`),
    identityRoot,
    priority: sources.length,
  });
}

function buildSkillSources(
  cwd: string | undefined,
  modeSlug: string,
  projectless: boolean,
): SkillSource[] {
  const sources: SkillSource[] = [];
  for (const dir of BUNDLED_SKILLS_DIRS) {
    sources.push({
      scope: "builtin",
      namespace: "agentlink",
      dir,
      priority: sources.length,
    });
  }

  const home = os.homedir();
  addSourcePair(
    sources,
    "global",
    "agents",
    path.join(home, ".agents"),
    modeSlug,
  );
  addSourcePair(
    sources,
    "global",
    "claude",
    path.join(home, ".claude"),
    modeSlug,
  );
  addSourcePair(
    sources,
    "global",
    "agentlink",
    path.join(home, ".agentlink"),
    modeSlug,
  );

  if (!projectless && cwd) {
    const roots = getSkillDiscoveryRoots(cwd);
    const identityRoot = roots[0] ?? path.resolve(cwd);
    for (const root of roots) {
      const scope: SkillSourceScope =
        path.resolve(root) === path.resolve(cwd) ? "project" : "ancestor";
      addSourcePair(
        sources,
        scope,
        "agents",
        path.join(root, ".agents"),
        modeSlug,
        identityRoot,
      );
      addSourcePair(
        sources,
        scope,
        "claude",
        path.join(root, ".claude"),
        modeSlug,
        identityRoot,
      );
      addSourcePair(
        sources,
        scope,
        "agentlink",
        path.join(root, ".agentlink"),
        modeSlug,
        identityRoot,
      );
    }
  }

  const byPath = new Map<string, SkillSource>();
  for (const source of sources) {
    const key = path.resolve(source.dir);
    byPath.set(key, { ...source, priority: source.priority });
  }
  return [...byPath.values()].map((source, priority) => ({
    ...source,
    priority,
  }));
}

function resolveDependencies(
  entries: RawSkill[],
  diagnostics: SkillDiagnostic[],
): void {
  const enabled = entries.filter((entry) => entry.enabled);
  const byId = new Map(enabled.map((entry) => [entry.id, entry]));
  const byName = new Map<string, RawSkill[]>();
  for (const entry of enabled) {
    const named = byName.get(entry.name) ?? [];
    named.push(entry);
    byName.set(entry.name, named);
  }

  for (const entry of enabled) {
    const resolved: string[] = [];
    for (const selector of entry.dependencies) {
      const exact = byId.get(selector);
      const matches = exact ? [exact] : (byName.get(selector) ?? []);
      if (matches.length === 0) {
        entry.enabled = false;
        entry.disabledReason = "missing-dependency";
        diagnostics.push({
          code: "missing-dependency",
          severity: "error",
          message: `Required skill dependency '${selector}' is missing or disabled`,
          sourcePath: entry.skillPath,
          skillId: entry.id,
        });
      } else if (matches.length > 1) {
        entry.enabled = false;
        entry.disabledReason = "ambiguous-dependency";
        diagnostics.push({
          code: "ambiguous-dependency",
          severity: "error",
          message: `Required skill dependency '${selector}' is ambiguous; use a canonical skill ID`,
          sourcePath: entry.skillPath,
          skillId: entry.id,
          relatedSkillIds: matches.map((match) => match.id).sort(),
        });
      } else {
        resolved.push(matches[0]!.id);
      }
    }
    entry.resolvedDependencies = [...new Set(resolved)].sort();
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = new Set<string>();
  const visit = (skillId: string, stack: string[]): void => {
    if (visiting.has(skillId)) {
      for (const id of stack.slice(stack.indexOf(skillId))) cyclic.add(id);
      cyclic.add(skillId);
      return;
    }
    if (visited.has(skillId)) return;
    visiting.add(skillId);
    const skill = byId.get(skillId);
    for (const dependency of skill?.resolvedDependencies ?? []) {
      visit(dependency, [...stack, skillId]);
    }
    visiting.delete(skillId);
    visited.add(skillId);
  };
  for (const entry of enabled) visit(entry.id, []);
  for (const id of [...cyclic].sort()) {
    const entry = byId.get(id);
    if (!entry) continue;
    entry.enabled = false;
    entry.disabledReason = "dependency-cycle";
    diagnostics.push({
      code: "dependency-cycle",
      severity: "error",
      message: "Skill dependency cycle detected",
      sourcePath: entry.skillPath,
      skillId: entry.id,
      relatedSkillIds: [...cyclic].sort(),
    });
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of enabled) {
      if (!entry.enabled) continue;
      const unavailable = entry.resolvedDependencies.find(
        (dependencyId) => !byId.get(dependencyId)?.enabled,
      );
      if (!unavailable) continue;
      entry.enabled = false;
      entry.disabledReason = "missing-dependency";
      diagnostics.push({
        code: "missing-dependency",
        severity: "error",
        message: `Required skill dependency '${unavailable}' is missing or disabled`,
        sourcePath: entry.skillPath,
        skillId: entry.id,
        relatedSkillIds: [unavailable],
      });
      changed = true;
    }
  }
}

async function loadSkillCatalogFromSources(
  sources: readonly SkillSource[],
  cwd: string | undefined,
  modeSlug: string,
  options: SkillCatalogOptions,
): Promise<SkillCatalogSnapshot> {
  const entries: RawSkill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  for (const source of sources) {
    const scanned = await scanSkillsDir(source, cwd, options);
    for (const entry of scanned.entries) {
      if (entry.modeSlugs && !entry.modeSlugs.includes(modeSlug)) continue;
      entries.push(entry);
    }
    diagnostics.push(...scanned.diagnostics);
  }

  const uniqueById = new Map<string, RawSkill>();
  for (const entry of entries) {
    const existing = uniqueById.get(entry.id);
    if (!existing || existing.provenance.priority < entry.provenance.priority) {
      uniqueById.set(entry.id, entry);
    }
  }
  const canonicalEntries = [...uniqueById.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const disabledSkillIds = new Set(options.disabledSkillIds ?? []);
  for (const entry of canonicalEntries) {
    if (disabledSkillIds.has(entry.id)) {
      entry.enabled = false;
      entry.disabledReason = "configuration";
    }
  }

  const byName = new Map<string, RawSkill[]>();
  for (const entry of canonicalEntries) {
    const named = byName.get(entry.name) ?? [];
    named.push(entry);
    byName.set(entry.name, named);
  }
  const collisions: SkillCollision[] = [];
  for (const [name, named] of [...byName.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (named.length < 2) continue;
    const skillIds = named.map((entry) => entry.id).sort();
    collisions.push({ name, skillIds });
    for (const entry of named) {
      diagnostics.push({
        code: "name-collision",
        severity: "warning",
        message: `Skill name '${name}' is ambiguous; activate it by canonical ID`,
        sourcePath: entry.skillPath,
        skillId: entry.id,
        relatedSkillIds: skillIds,
      });
    }
  }

  resolveDependencies(canonicalEntries, diagnostics);
  diagnostics.sort((left, right) =>
    `${left.sourcePath}:${left.code}:${left.message}`.localeCompare(
      `${right.sourcePath}:${right.code}:${right.message}`,
    ),
  );
  const revision = stableHash({
    schemaVersion: 1,
    modeSlug,
    entries: canonicalEntries.map((entry) => ({
      id: entry.id,
      revision: entry.revision,
      enabled: entry.enabled,
      disabledReason: entry.disabledReason,
      resolvedDependencies: entry.resolvedDependencies,
    })),
    diagnostics: diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      skillId: diagnostic.skillId,
      relatedSkillIds: diagnostic.relatedSkillIds,
    })),
  });

  return {
    schemaVersion: 1,
    revision,
    cwd,
    modeSlug,
    entries: canonicalEntries.map(
      ({ modeSlugs: _modeSlugs, ...entry }) => entry,
    ),
    diagnostics,
    collisions,
  };
}

export async function loadSkillCatalog(
  cwd: string,
  modeSlug: string,
  options: SkillCatalogOptions = {},
): Promise<SkillCatalogSnapshot> {
  return loadSkillCatalogFromSources(
    buildSkillSources(cwd, modeSlug, false),
    path.resolve(cwd),
    modeSlug,
    options,
  );
}

export async function loadProjectlessSkillCatalog(
  modeSlug: string,
  options: SkillCatalogOptions = {},
): Promise<SkillCatalogSnapshot> {
  return loadSkillCatalogFromSources(
    buildSkillSources(undefined, modeSlug, true),
    undefined,
    modeSlug,
    options,
  );
}

function selectLegacyVisibleEntries(
  snapshot: SkillCatalogSnapshot,
): SkillEntry[] {
  const byName = new Map<string, SkillEntry>();
  for (const entry of [...snapshot.entries].sort(
    (left, right) => left.provenance.priority - right.provenance.priority,
  )) {
    if (entry.enabled) byName.set(entry.name, entry);
  }
  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

/** Discover bundled/global skills visible to a projectless surface. */
export async function loadProjectlessSkills(
  modeSlug: string,
): Promise<SkillEntry[]> {
  return selectLegacyVisibleEntries(
    await loadProjectlessSkillCatalog(modeSlug, { includeBody: true }),
  );
}

/** Compatibility view over the canonical catalog for existing consumers. */
export async function loadSkills(
  cwd: string,
  modeSlug: string,
  options: SkillCatalogOptions = {},
): Promise<SkillEntry[]> {
  return selectLegacyVisibleEntries(
    await loadSkillCatalog(cwd, modeSlug, options),
  );
}

/** Union of enabled canonical skills across modes without collapsing names. */
export async function loadCanonicalSkillsForModes(
  cwd: string,
  modeSlugs: readonly string[],
  options: SkillCatalogOptions = {},
): Promise<SkillEntry[]> {
  const merged = new Map<string, SkillEntry>();
  for (const slug of modeSlugs) {
    const catalog = await loadSkillCatalog(cwd, slug, options);
    for (const skill of catalog.entries) {
      if (skill.enabled && !merged.has(skill.id)) merged.set(skill.id, skill);
    }
  }
  return [...merged.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

/** Compatibility union across modes with legacy short-name precedence. */
export async function loadSkillsForModes(
  cwd: string,
  modeSlugs: readonly string[],
  options: SkillCatalogOptions = {},
): Promise<SkillEntry[]> {
  const merged = new Map<string, SkillEntry>();
  for (const slug of modeSlugs) {
    for (const skill of await loadSkills(cwd, slug, options)) {
      if (!merged.has(skill.id)) merged.set(skill.id, skill);
    }
  }
  return [...merged.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

export function composeSkillCapabilityPolicy(
  skills: readonly SkillEntry[],
): SkillCapabilityPolicySnapshot {
  const ordered = [...skills].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const dependencies = new Set<string>();
  const recommendations = new Set<string>();
  const requestedTools = new Set<string>();
  let allowedTools: Set<string> | undefined;

  for (const skill of ordered) {
    for (const dependency of skill.resolvedDependencies)
      dependencies.add(dependency);
    for (const recommendation of skill.recommendations) {
      recommendations.add(recommendation);
    }
    for (const requested of skill.permissions.requestedTools) {
      requestedTools.add(requested);
    }
    const restriction = skill.restrictions.allowedTools;
    if (restriction === undefined) continue;
    const next = new Set(restriction);
    allowedTools = allowedTools
      ? new Set([...allowedTools].filter((tool) => next.has(tool)))
      : next;
  }

  const snapshot = {
    schemaVersion: 1 as const,
    skillIds: ordered.map((skill) => skill.id),
    dependencies: [...dependencies].sort(),
    recommendations: [...recommendations].sort(),
    requestedTools: [...requestedTools].sort(),
    allowedTools: allowedTools ? [...allowedTools].sort() : undefined,
  };
  return {
    ...snapshot,
    revision: stableHash(snapshot),
  };
}
