import * as os from "os";
import * as path from "path";

import {
  loadCanonicalSkillCatalogForModes as loadSharedCanonicalSkillCatalogForModes,
  loadCanonicalSkillsForModes as loadSharedCanonicalSkillsForModes,
  loadProjectlessSkillCatalog as loadSharedProjectlessSkillCatalog,
  loadProjectlessSkills as loadSharedProjectlessSkills,
  loadSkillCatalog as loadSharedSkillCatalog,
  loadSkills as loadSharedSkills,
  loadSkillsForModes as loadSharedSkillsForModes,
  type SkillCatalogOptions as SharedSkillCatalogOptions,
  type SkillCatalogSnapshot,
  type SkillEntry,
} from "@agentlink/node-host";

/**
 * VS Code's skill discovery. The implementation is shared with every other
 * agent surface in `@agentlink/node-host` (`skillDiscovery.ts`); VS Code
 * supplies its bundled skill folders and home folder.
 */
export {
  SkillFrontmatterError,
  composeSkillCapabilityPolicy,
  getSkillDiscoveryRoots,
  isVerifiedSkillCapabilityPolicy,
  parseFrontmatter,
  type PluginSkillProvenance,
  type SkillCapabilityPolicySnapshot,
  type SkillCatalogSnapshot,
  type SkillCollision,
  type SkillDiagnostic,
  type SkillDiagnosticSeverity,
  type SkillEntry,
  type SkillPermissions,
  type SkillProvenance,
  type SkillRestrictions,
  type SkillSourceNamespace,
  type SkillSourceScope,
} from "@agentlink/node-host";

const BUNDLED_SKILLS_DIRS = [
  path.resolve(__dirname, "..", "resources", "builtin-skills"),
  path.resolve(__dirname, "..", "..", "resources", "builtin-skills"),
];

/** Built-in skill folders next to this bundle, for other agents in it (Ask Agent). */
export function getBundledSkillDirs(): readonly string[] {
  return BUNDLED_SKILLS_DIRS;
}

export type SkillCatalogOptions = Omit<
  SharedSkillCatalogOptions,
  "builtinSkillDirs" | "homeDir"
>;

function withVscodeSources(
  options: SkillCatalogOptions = {},
): SharedSkillCatalogOptions {
  return {
    ...options,
    builtinSkillDirs: BUNDLED_SKILLS_DIRS,
    homeDir: os.homedir(),
  };
}

export async function loadSkillCatalog(
  cwd: string,
  modeSlug: string,
  options: SkillCatalogOptions = {},
): Promise<SkillCatalogSnapshot> {
  return loadSharedSkillCatalog(cwd, modeSlug, withVscodeSources(options));
}

export async function loadProjectlessSkillCatalog(
  modeSlug: string,
  options: SkillCatalogOptions = {},
): Promise<SkillCatalogSnapshot> {
  return loadSharedProjectlessSkillCatalog(
    modeSlug,
    withVscodeSources(options),
  );
}

/** Discover bundled/global skills visible to a projectless surface. */
export async function loadProjectlessSkills(
  modeSlug: string,
): Promise<SkillEntry[]> {
  return loadSharedProjectlessSkills(modeSlug, withVscodeSources());
}

/** Compatibility view over the canonical catalog for existing consumers. */
export async function loadSkills(
  cwd: string,
  modeSlug: string,
  options: SkillCatalogOptions = {},
): Promise<SkillEntry[]> {
  return loadSharedSkills(cwd, modeSlug, withVscodeSources(options));
}

/** Union of enabled canonical skills across modes without collapsing names. */
export async function loadCanonicalSkillsForModes(
  cwd: string,
  modeSlugs: readonly string[],
  options: SkillCatalogOptions = {},
): Promise<SkillEntry[]> {
  return loadSharedCanonicalSkillsForModes(
    cwd,
    modeSlugs,
    withVscodeSources(options),
  );
}

/** Keep diagnostics paired with the same discovered catalogue, not a later filesystem scan. */
export async function loadCanonicalSkillCatalogForModes(
  cwd: string,
  modeSlugs: readonly string[],
  options: SkillCatalogOptions = {},
): Promise<Pick<SkillCatalogSnapshot, "entries" | "diagnostics">> {
  return loadSharedCanonicalSkillCatalogForModes(
    cwd,
    modeSlugs,
    withVscodeSources(options),
  );
}

/** Compatibility union across modes with legacy short-name precedence. */
export async function loadSkillsForModes(
  cwd: string,
  modeSlugs: readonly string[],
  options: SkillCatalogOptions = {},
): Promise<SkillEntry[]> {
  return loadSharedSkillsForModes(cwd, modeSlugs, withVscodeSources(options));
}
