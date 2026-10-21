/**
 * Instruction and rule discovery shared by every AgentLink agent surface.
 *
 * Moved verbatim from VS Code's `src/agent/configLoader.ts`, which now
 * re-exports this module. VS Code behaviour is the spec: keep the source
 * order, precedence and file handling identical here.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** A loaded instruction block with its source for display/debugging. */
export interface InstructionBlock {
  source: string;
  content: string;
  /** Whether this block came from a rules directory and can be disclosed lazily. */
  kind?: "instruction" | "rule";
  /** Absolute file path when the source can be loaded on demand via read_file. */
  filePath?: string;
  /** Whether the file included a leading YAML frontmatter block. */
  hasFrontmatter?: boolean;
  /** Rule-directory files with alwaysApply frontmatter remain inline. */
  alwaysApply?: boolean;
  /** Optional frontmatter description used in deferred rule catalogs. */
  description?: string;
  /** Optional frontmatter glob hints describing when a rule applies. */
  globs?: string[];
  /** Workspace root that owns this project instruction or rule. */
  projectRoot?: string;
}

export type ProjectActiveFileResolution =
  | { status: "accepted"; activeFilePath: string }
  | {
      status: "ignored";
      reason: "outside_project" | "symlink_escape" | "project_root_unavailable";
    };

export interface InstructionDiscoveryOptions {
  activeFilePath?: string;
  /**
   * Home folder for global sources (`~/.agents`, `~/.claude`,
   * `~/.agentlink`). Defaults to `os.homedir()`. `null` skips global
   * sources, for hosts whose home folder is not the user's (a server).
   */
  homeDir?: string | null;
}

// --- Root instruction file resolution (was src/util/workspaceInstructionFile.ts) ---

export const WORKSPACE_INSTRUCTION_FILENAMES: ReadonlySet<string> = new Set([
  "AGENT.md",
  "AGENTS.md",
  "AGENTS.local.md",
  "CLAUDE.md",
]);

export type WorkspaceInstructionFileResolution =
  | { status: "missing" }
  | { status: "accepted"; canonicalPath: string }
  | {
      status: "ignored";
      reason:
        | "invalid_alias_target"
        | "missing_alias_target"
        | "non_regular_alias_target"
        | "indirect_alias_target"
        | "non_regular_file";
    };

export async function resolveWorkspaceInstructionFile(
  candidate: string,
  workspaceRoot: string,
): Promise<WorkspaceInstructionFileResolution> {
  let metadata;
  try {
    metadata = await fs.lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    throw error;
  }

  if (!metadata.isSymbolicLink()) {
    return metadata.isFile()
      ? { status: "accepted", canonicalPath: await fs.realpath(candidate) }
      : { status: "ignored", reason: "non_regular_file" };
  }

  const target = await fs.readlink(candidate);
  if (
    path.basename(target) !== target ||
    !WORKSPACE_INSTRUCTION_FILENAMES.has(target)
  ) {
    return { status: "ignored", reason: "invalid_alias_target" };
  }

  const canonicalWorkspaceRoot = await fs.realpath(workspaceRoot);
  const resolvedTarget = path.join(canonicalWorkspaceRoot, target);
  let targetMetadata;
  try {
    targetMetadata = await fs.lstat(resolvedTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "ignored", reason: "missing_alias_target" };
    }
    throw error;
  }
  if (targetMetadata.isSymbolicLink() || !targetMetadata.isFile()) {
    return { status: "ignored", reason: "non_regular_alias_target" };
  }

  const canonicalTarget = await fs.realpath(resolvedTarget);
  if (canonicalTarget !== resolvedTarget) {
    return { status: "ignored", reason: "indirect_alias_target" };
  }
  return { status: "accepted", canonicalPath: canonicalTarget };
}

export function describeIgnoredWorkspaceInstructionFile(
  candidate: string,
  reason: Extract<
    WorkspaceInstructionFileResolution,
    { status: "ignored" }
  >["reason"],
): string {
  const explanation =
    reason === "invalid_alias_target"
      ? "alias must name another declared root instruction file"
      : reason === "missing_alias_target"
        ? "alias target does not exist"
        : reason === "non_regular_alias_target"
          ? "alias target must be a regular non-symlink file"
          : reason === "indirect_alias_target"
            ? "alias target must resolve directly within the workspace root"
            : "instruction path must be a regular file";
  return `Ignored invalid workspace instruction file ${candidate}: ${explanation}.`;
}

// --- Instruction loading (was src/agent/configLoader.ts) ---

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

function splitOutsideBraces(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let braceDepth = 0;

  for (const char of value) {
    if (char === "{") braceDepth += 1;
    if (char === "}" && braceDepth > 0) braceDepth -= 1;

    if (char === "," && braceDepth === 0) {
      parts.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  parts.push(current);
  return parts;
}

function parseRuleFrontmatter(content: string): {
  frontmatter: Record<string, string | string[]>;
  body: string;
  hasFrontmatter: boolean;
} {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content, hasFrontmatter: false };
  }

  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: content, hasFrontmatter: false };
  }

  const frontmatter: Record<string, string | string[]> = {};
  const lines = content.slice(3, end).trim().split("\n");
  let currentListKey: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (currentListKey && trimmed.startsWith("- ")) {
      const list = frontmatter[currentListKey];
      const item = stripMatchingQuotes(trimmed.slice(2));
      if (item) {
        frontmatter[currentListKey] = Array.isArray(list)
          ? [...list, item]
          : [item];
      }
      continue;
    }

    currentListKey = undefined;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (!key) continue;

    if (!value) {
      currentListKey = key;
      frontmatter[key] = [];
      continue;
    }

    frontmatter[key] = stripMatchingQuotes(value);
  }

  return {
    frontmatter,
    body: content.slice(end + 4).trim(),
    hasFrontmatter: true,
  };
}

function frontmatterString(
  frontmatter: Record<string, string | string[]>,
  key: string,
): string | undefined {
  const value = frontmatter[key];
  return typeof value === "string" ? value : undefined;
}

function parseBoolean(value: string | undefined): boolean {
  return value?.toLowerCase() === "true";
}

function parseGlobList(
  value: string | string[] | undefined,
): string[] | undefined {
  const rawGlobs = Array.isArray(value)
    ? value
    : splitOutsideBraces(value ?? "");
  const globs = rawGlobs
    .map((glob) => stripMatchingQuotes(glob))
    .filter(Boolean);
  return globs.length > 0 ? globs : undefined;
}

/** Strip agentlink-injected instruction blocks from CLAUDE.md / AGENTS.md content. */
function stripAgentlinkBlock(content: string): string {
  return content
    .replace(
      /<!--\s*BEGIN agentlink\s*-->[\s\S]*?<!--\s*END agentlink\s*-->/g,
      "",
    )
    .trim();
}

async function safeReadFile(filePath: string): Promise<string> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return stripAgentlinkBlock(raw);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return "";
    throw err;
  }
}

async function safeReadWorkspaceInstruction(
  workspaceRoot: string,
  filename: string,
): Promise<string> {
  const candidate = path.join(workspaceRoot, filename);
  const resolution = await resolveWorkspaceInstructionFile(
    candidate,
    workspaceRoot,
  );
  return resolution.status === "accepted"
    ? safeReadFile(resolution.canonicalPath)
    : "";
}

/** Read all *.md files in a directory, sorted alphabetically. Returns InstructionBlocks. */
async function readMdDirectory(dirPath: string): Promise<InstructionBlock[]> {
  try {
    const entries = await fs.readdir(dirPath);
    const mdFiles = entries.filter((e) => e.endsWith(".md")).sort();
    const blocks: InstructionBlock[] = [];
    for (const file of mdFiles) {
      const filePath = path.join(dirPath, file);
      const rawContent = await safeReadFile(filePath);
      const { frontmatter, body, hasFrontmatter } =
        parseRuleFrontmatter(rawContent);
      const content = body.trim();
      if (content)
        blocks.push({
          source: filePath,
          content,
          kind: "rule",
          filePath,
          hasFrontmatter,
          alwaysApply:
            !hasFrontmatter ||
            parseBoolean(frontmatterString(frontmatter, "alwaysApply")),
          description: frontmatterString(frontmatter, "description"),
          globs: parseGlobList(frontmatter.globs),
        });
    }
    return blocks;
  } catch {
    return [];
  }
}

function ruleBlock(source: string, b: InstructionBlock): InstructionBlock {
  return {
    source,
    content: b.content,
    kind: "rule",
    filePath: b.filePath,
    hasFrontmatter: b.hasFrontmatter,
    alwaysApply: b.alwaysApply,
    description: b.description,
    globs: b.globs,
  };
}

function isPathWithinOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function canonicalizeParentAware(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  let current = resolved;
  const suffix: string[] = [];

  while (true) {
    try {
      const canonical = await fs.realpath(current);
      return path.join(canonical, ...suffix.reverse());
    } catch {
      const parent = path.dirname(current);
      // If no ancestor exists, there is no live symlink to escape through; the
      // earlier lexical containment check remains authoritative for this path.
      if (parent === current) return resolved;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Validates active editor context against one project root. Lexical containment
 * rejects sibling/prefix paths before filesystem access; canonical containment
 * then rejects paths that escape through a symlinked ancestor.
 */
export async function resolveProjectActiveFilePath(
  cwd: string,
  activeFilePath: string | undefined,
): Promise<ProjectActiveFileResolution | undefined> {
  if (!activeFilePath) return undefined;

  const resolvedRoot = path.resolve(cwd);
  const resolvedActiveFile = path.resolve(activeFilePath);
  if (!isPathWithinOrEqual(resolvedRoot, resolvedActiveFile)) {
    return { status: "ignored", reason: "outside_project" };
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(resolvedRoot);
  } catch {
    return { status: "ignored", reason: "project_root_unavailable" };
  }

  const canonicalActiveFile = await canonicalizeParentAware(resolvedActiveFile);
  if (!isPathWithinOrEqual(canonicalRoot, canonicalActiveFile)) {
    return { status: "ignored", reason: "symlink_escape" };
  }

  return { status: "accepted", activeFilePath: resolvedActiveFile };
}

/**
 * Get intermediate subdirectory paths from cwd down to targetDir.
 * Returns directories from the first child of cwd down to targetDir (inclusive).
 * For example: cwd=/workspace, targetDir=/workspace/packages/foo
 * → [/workspace/packages, /workspace/packages/foo]
 */
function getSubdirChain(cwd: string, targetDir: string): string[] {
  const normalCwd = path.resolve(cwd);
  const normalTarget = path.resolve(targetDir);
  if (
    !normalTarget.startsWith(normalCwd + path.sep) &&
    normalTarget !== normalCwd
  ) {
    return [];
  }
  const rel = path.relative(normalCwd, normalTarget);
  if (!rel || rel === ".") return [];
  const segments = rel.split(path.sep);
  const result: string[] = [];
  let current = normalCwd;
  for (const seg of segments) {
    current = path.join(current, seg);
    result.push(current);
  }
  return result;
}

/**
 * Global instructions in priority order (.agents → .claude → .agentlink):
 *   1. ~/.agents/AGENTS.md
 *   2. ~/.agents/rules/*.md
 *   3. ~/.claude/CLAUDE.md
 *   4. ~/.claude/rules/*.md
 *   5. ~/.agentlink/CLAUDE.md
 *   6. ~/.agentlink/rules/*.md
 *
 * Used directly by projectless hosts; project hosts get these first from
 * {@link loadAllInstructionBlocks}.
 */
export async function loadGlobalInstructionBlocks(
  opts?: Pick<InstructionDiscoveryOptions, "homeDir">,
): Promise<InstructionBlock[]> {
  const home = opts?.homeDir === undefined ? os.homedir() : opts.homeDir;
  if (home === null) return [];
  const blocks: InstructionBlock[] = [];

  // ~/.agents/AGENTS.md
  const globalAgents = await safeReadFile(
    path.join(home, ".agents", "AGENTS.md"),
  );
  if (globalAgents) {
    blocks.push({ source: "~/.agents/AGENTS.md", content: globalAgents });
  }

  // ~/.agents/rules/*.md
  for (const b of await readMdDirectory(path.join(home, ".agents", "rules"))) {
    blocks.push(ruleBlock(`~/.agents/rules/${path.basename(b.source)}`, b));
  }

  // ~/.claude/CLAUDE.md
  const globalClaude = await safeReadFile(
    path.join(home, ".claude", "CLAUDE.md"),
  );
  if (globalClaude) {
    blocks.push({ source: "~/.claude/CLAUDE.md", content: globalClaude });
  }

  // ~/.claude/rules/*.md
  for (const b of await readMdDirectory(path.join(home, ".claude", "rules"))) {
    blocks.push(ruleBlock(`~/.claude/rules/${path.basename(b.source)}`, b));
  }

  // ~/.agentlink/CLAUDE.md
  const globalAgentlink = await safeReadFile(
    path.join(home, ".agentlink", "CLAUDE.md"),
  );
  if (globalAgentlink) {
    blocks.push({
      source: "~/.agentlink/CLAUDE.md",
      content: globalAgentlink,
    });
  }

  // ~/.agentlink/rules/*.md
  for (const b of await readMdDirectory(
    path.join(home, ".agentlink", "rules"),
  )) {
    blocks.push(ruleBlock(`~/.agentlink/rules/${path.basename(b.source)}`, b));
  }

  return blocks;
}

/**
 * Load all instruction sources in priority order (later entries take precedence).
 *
 * Global instructions: see {@link loadGlobalInstructionBlocks}.
 *
 * Project-level:
 *   7. AGENTS.md / AGENT.md / CLAUDE.md in workspace root (first found wins)
 *   8. .agents/AGENTS.md & .agents/rules/*.md
 *   9. .claude/CLAUDE.md & .claude/rules/*.md
 *  10. .agentlink/AGENTS.md (falling back to .agentlink/CLAUDE.md) & .agentlink/rules/*.md
 *
 * Subfolder & local:
 *  11. Subfolder AGENTS.md files (from root child down to activeFilePath's dir)
 *  12. Subfolder AGENTS.local.md files (from root child down to activeFilePath's dir)
 *  13. AGENTS.local.md in workspace root (personal overrides, gitignored by convention)
 *
 * Returns an array of InstructionBlocks for display and concatenation.
 */
export async function loadAllInstructionBlocks(
  cwd: string,
  opts?: InstructionDiscoveryOptions,
): Promise<InstructionBlock[]> {
  const blocks: InstructionBlock[] = await loadGlobalInstructionBlocks(opts);

  // --- Project-level instructions ---

  // Workspace root — first of AGENTS.md / AGENT.md / CLAUDE.md wins
  for (const filename of ["AGENTS.md", "AGENT.md", "CLAUDE.md"]) {
    const content = await safeReadWorkspaceInstruction(cwd, filename);
    if (content) {
      blocks.push({ source: filename, content });
      break;
    }
  }

  // .agents/AGENTS.md & .agents/rules/*.md
  const dotAgentsFile = await safeReadFile(
    path.join(cwd, ".agents", "AGENTS.md"),
  );
  if (dotAgentsFile) {
    blocks.push({ source: ".agents/AGENTS.md", content: dotAgentsFile });
  }
  for (const b of await readMdDirectory(path.join(cwd, ".agents", "rules"))) {
    blocks.push(ruleBlock(`.agents/rules/${path.basename(b.source)}`, b));
  }

  // .claude/CLAUDE.md & .claude/rules/*.md
  const dotClaudeClaude = await safeReadFile(
    path.join(cwd, ".claude", "CLAUDE.md"),
  );
  if (dotClaudeClaude) {
    blocks.push({ source: ".claude/CLAUDE.md", content: dotClaudeClaude });
  }
  for (const b of await readMdDirectory(path.join(cwd, ".claude", "rules"))) {
    blocks.push(ruleBlock(`.claude/rules/${path.basename(b.source)}`, b));
  }

  // .agentlink/AGENTS.md, falling back to .agentlink/CLAUDE.md
  for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
    const content = await safeReadFile(path.join(cwd, ".agentlink", filename));
    if (content) {
      blocks.push({ source: `.agentlink/${filename}`, content });
      break;
    }
  }
  for (const b of await readMdDirectory(
    path.join(cwd, ".agentlink", "rules"),
  )) {
    blocks.push(ruleBlock(`.agentlink/rules/${path.basename(b.source)}`, b));
  }

  // 8 & 9. Subfolder instruction files (when activeFilePath is within cwd)
  const activeFileResolution = await resolveProjectActiveFilePath(
    cwd,
    opts?.activeFilePath,
  );
  const activeFilePath =
    activeFileResolution?.status === "accepted"
      ? activeFileResolution.activeFilePath
      : undefined;
  if (activeFilePath) {
    const activeDir = path.dirname(activeFilePath);
    const subdirs = getSubdirChain(cwd, activeDir);

    // 8. First matching AGENTS.md / AGENT.md / CLAUDE.md per subdirectory
    for (const subdir of subdirs) {
      const relDir = path.relative(cwd, subdir);
      for (const filename of ["AGENTS.md", "AGENT.md", "CLAUDE.md"]) {
        const source = `${relDir}/${filename}`;
        const content = await safeReadFile(path.join(subdir, filename));
        if (content) {
          if (!blocks.some((block) => block.source === source)) {
            blocks.push({ source, content });
          }
          break;
        }
      }
    }

    // 9. AGENTS.local.md in each subdirectory
    for (const subdir of subdirs) {
      const relDir = path.relative(cwd, subdir);
      const content = await safeReadFile(path.join(subdir, "AGENTS.local.md"));
      if (content) {
        blocks.push({ source: `${relDir}/AGENTS.local.md`, content });
      }
    }
  }

  // 10. Root AGENTS.local.md (personal overrides, gitignored by convention)
  const localContent = await safeReadWorkspaceInstruction(
    cwd,
    "AGENTS.local.md",
  );
  if (localContent) {
    blocks.push({ source: "AGENTS.local.md", content: localContent });
  }

  return blocks;
}

/**
 * Load all instructions and return as a formatted string.
 * Thin wrapper around loadAllInstructionBlocks for backward compatibility.
 */
export async function loadAllInstructions(
  cwd: string,
  opts?: InstructionDiscoveryOptions,
): Promise<string> {
  const blocks = await loadAllInstructionBlocks(cwd, opts);
  if (blocks.length === 0) return "";
  return blocks
    .map((b) => `# Instructions (${b.source}):\n${b.content}`)
    .join("\n\n");
}

/**
 * Load per-mode rule files for a given mode slug.
 *
 * Loads from (.agents → .claude → .agentlink priority):
 * - .agents/rules-{slug}/*.md     (mode-specific, .agents convention)
 * - .claude/rules-{slug}/*.md     (mode-specific, .claude convention)
 * - .agentlink/rules-{slug}/*.md  (mode-specific, agentlink convention)
 *
 * Files within each directory are loaded alphabetically and concatenated.
 */
export async function loadModeRules(
  cwd: string,
  modeSlug: string,
): Promise<string> {
  const sections: string[] = [];

  // .agents/rules-{slug}/ (lowest priority)
  const agentsMode = await readMdDirectory(
    path.join(cwd, ".agents", `rules-${modeSlug}`),
  );
  sections.push(...agentsMode.map((b) => b.content));

  // .claude/rules-{slug}/
  const claudeMode = await readMdDirectory(
    path.join(cwd, ".claude", `rules-${modeSlug}`),
  );
  sections.push(...claudeMode.map((b) => b.content));

  // .agentlink/rules-{slug}/ (highest priority)
  const agentlinkMode = await readMdDirectory(
    path.join(cwd, ".agentlink", `rules-${modeSlug}`),
  );
  sections.push(...agentlinkMode.map((b) => b.content));

  return sections.join("\n\n");
}
