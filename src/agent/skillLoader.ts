import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const BUNDLED_SKILLS_DIRS = [
  // Runtime bundle layout: dist/extension.js -> <extension>/resources/...
  path.resolve(__dirname, "..", "resources", "builtin-skills"),
  // Source/test layout: src/agent/skillLoader.ts -> <repo>/resources/...
  path.resolve(__dirname, "..", "..", "resources", "builtin-skills"),
];

export interface SkillEntry {
  name: string;
  description: string;
  /** Absolute path to the SKILL.md file — passed to the model so it can load_skill it */
  skillPath: string;
  /** Optional tool allowlist declared by SKILL.md frontmatter. */
  allowedTools?: string[];
  /** Optional invocation mode declared by SKILL.md frontmatter. */
  invocation?: "auto" | "manual";
}

interface RawSkill extends SkillEntry {
  /** Mode slugs this skill is restricted to. Undefined = available in all modes. */
  modeSlugs?: string[];
}

type FrontmatterValue = string | string[];

/**
 * Parse the small YAML frontmatter subset used by skills.
 * Supports scalar `key: value`, comma/JSON-ish inline lists, and block lists:
 *
 * allowed-tools:
 *   - read_file
 *   - search_files
 */
export function parseFrontmatter(
  content: string,
): Record<string, FrontmatterValue> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end === -1) return {};

  const fm: Record<string, FrontmatterValue> = {};
  let currentListKey: string | undefined;

  for (const rawLine of content.slice(3, end).split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (currentListKey && line.startsWith("-")) {
      const value = stripYamlScalar(line.slice(1).trim());
      if (value) {
        const existing = fm[currentListKey];
        fm[currentListKey] = [
          ...(Array.isArray(existing) ? existing : []),
          value,
        ];
      }
      continue;
    }

    currentListKey = undefined;
    const colon = line.indexOf(":");
    if (colon === -1) continue;

    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!key) continue;

    if (!value) {
      fm[key] = [];
      currentListKey = key;
      continue;
    }

    fm[key] = parseFrontmatterValue(value);
  }
  return fm;
}

function stripYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatterValue(value: string): FrontmatterValue {
  const trimmed = stripYamlScalar(value);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map(stripYamlScalar).filter(Boolean);
  }
  return trimmed;
}

function asString(value: FrontmatterValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(
  value: FrontmatterValue | undefined,
): string[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(/[\s,]+/).filter(Boolean);
  return undefined;
}

function parseModeSlugs(
  value: FrontmatterValue | undefined,
): string[] | undefined {
  const slugs = asStringArray(value);
  return slugs && slugs.length > 0 ? slugs : undefined;
}

function parseAllowedTools(
  value: FrontmatterValue | undefined,
): string[] | undefined {
  const tools = asStringArray(value)
    ?.map((tool) => tool.trim())
    .filter(Boolean);
  return tools && tools.length > 0 ? tools : undefined;
}

function parseInvocation(
  value: FrontmatterValue | undefined,
): "auto" | "manual" | undefined {
  const raw = asString(value)?.trim().toLowerCase();
  if (raw === "auto" || raw === "automatic") return "auto";
  if (raw === "manual" || raw === "manual-only") return "manual";
  return undefined;
}

/**
 * Scan a skills directory for sub-directories containing a SKILL.md.
 * Returns a map of skill name → RawSkill. Only the frontmatter is read, not the body.
 */
async function scanSkillsDir(dir: string): Promise<Map<string, RawSkill>> {
  const result = new Map<string, RawSkill>();
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(dir, entry.name, "SKILL.md");
      try {
        const raw = await fs.readFile(skillMd, "utf-8");
        const fm = parseFrontmatter(raw);
        const name = asString(fm.name) ?? entry.name;
        const description = asString(fm.description) ?? "";
        const modeSlugs = parseModeSlugs(fm.modeSlugs);
        const allowedTools = parseAllowedTools(
          fm["allowed-tools"] ?? fm.allowedTools,
        );
        const invocation = parseInvocation(fm.invocation ?? fm["activation"]);
        result.set(name, {
          name,
          description,
          skillPath: skillMd,
          modeSlugs,
          allowedTools,
          invocation,
        });
      } catch {
        // SKILL.md missing or unreadable — skip
      }
    }
  } catch {
    // Directory doesn't exist — skip
  }
  return result;
}

/**
 * Discover and load all skills visible to the current mode.
 *
 * Sources in ascending priority (later entries win on name collision):
 *   1. <extension>/resources/builtin-skills/ — bundled AgentLink skills (lowest)
 *   2. ~/.agents/skills/                    — global cross-agent
 *   3. ~/.agents/skills-{mode}/             — global cross-agent, mode-specific
 *   4. ~/.claude/skills/                    — global Claude Code
 *   5. ~/.claude/skills-{mode}/             — global Claude Code, mode-specific
 *   6. ~/.agentlink/skills/                 — global agentlink
 *   7. ~/.agentlink/skills-{mode}/          — global agentlink, mode-specific
 *   8. <cwd>/.agents/skills/                — project cross-agent
 *   9. <cwd>/.agents/skills-{mode}/         — project cross-agent, mode-specific
 *  10. <cwd>/.claude/skills/                — project Claude Code
 *  11. <cwd>/.claude/skills-{mode}/         — project Claude Code, mode-specific
 *  12. <cwd>/.agentlink/skills/             — project agentlink
 *  13. <cwd>/.agentlink/skills-{mode}/      — project agentlink, mode-specific (highest)
 *
 * Skills that declare `modeSlugs` in their SKILL.md frontmatter are only included
 * when the current mode slug appears in that list.
 */
export async function loadSkills(
  cwd: string,
  modeSlug: string,
): Promise<SkillEntry[]> {
  const home = os.homedir();

  const sources = [
    ...BUNDLED_SKILLS_DIRS,
    path.join(home, ".agents", "skills"),
    path.join(home, ".agents", `skills-${modeSlug}`),
    path.join(home, ".claude", "skills"),
    path.join(home, ".claude", `skills-${modeSlug}`),
    path.join(home, ".agentlink", "skills"),
    path.join(home, ".agentlink", `skills-${modeSlug}`),
    path.join(cwd, ".agents", "skills"),
    path.join(cwd, ".agents", `skills-${modeSlug}`),
    path.join(cwd, ".claude", "skills"),
    path.join(cwd, ".claude", `skills-${modeSlug}`),
    path.join(cwd, ".agentlink", "skills"),
    path.join(cwd, ".agentlink", `skills-${modeSlug}`),
  ];

  // Merge visible skills in priority order — later sources win on name collision.
  // Mode-incompatible skills should not mask lower-priority skills that are visible.
  const merged = new Map<string, RawSkill>();
  for (const dir of sources) {
    const entries = await scanSkillsDir(dir);
    for (const [name, skill] of entries) {
      if (skill.modeSlugs && !skill.modeSlugs.includes(modeSlug)) continue;
      merged.set(name, skill);
    }
  }

  return Array.from(merged.values()).map(
    ({ name, description, skillPath, allowedTools, invocation }) => ({
      name,
      description,
      skillPath,
      allowedTools,
      invocation,
    }),
  );
}
