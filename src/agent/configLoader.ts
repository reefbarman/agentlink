import * as os from "os";
import * as fs from "fs/promises";
import * as path from "path";

/** A loaded instruction block with its source for display/debugging. */
export interface InstructionBlock {
  source: string;
  content: string;
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

/** Read all *.md files in a directory, sorted alphabetically. Returns InstructionBlocks. */
async function readMdDirectory(dirPath: string): Promise<InstructionBlock[]> {
  try {
    const entries = await fs.readdir(dirPath);
    const mdFiles = entries.filter((e) => e.endsWith(".md")).sort();
    const blocks: InstructionBlock[] = [];
    for (const file of mdFiles) {
      const filePath = path.join(dirPath, file);
      const content = await safeReadFile(filePath);
      if (content) blocks.push({ source: filePath, content });
    }
    return blocks;
  } catch {
    return [];
  }
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
 * Load all instruction sources in priority order (later entries take precedence).
 *
 * 1. ~/.agents/AGENTS.md — global agents instructions
 * 2. ~/.agents/rules/*.md — global agents rules
 * 3. ~/.claude/CLAUDE.md — global user instructions
 * 4. AGENTS.md / AGENT.md / CLAUDE.md in workspace root (first found wins)
 * 5. .claude/CLAUDE.md in workspace root
 * 6. .agents/rules/*.md in workspace root
 * 7. .agentlink/CLAUDE.md in workspace root
 * 8. Subfolder AGENTS.md files (from root child down to activeFilePath's dir)
 * 9. Subfolder AGENTS.local.md files (from root child down to activeFilePath's dir)
 * 10. AGENTS.local.md in workspace root (personal overrides, gitignored by convention)
 *
 * Returns an array of InstructionBlocks for display and concatenation.
 */
export async function loadAllInstructionBlocks(
  cwd: string,
  opts?: { activeFilePath?: string },
): Promise<InstructionBlock[]> {
  const blocks: InstructionBlock[] = [];

  // 1. ~/.agents/AGENTS.md (global agents dir)
  const globalAgents = await safeReadFile(
    path.join(os.homedir(), ".agents", "AGENTS.md"),
  );
  if (globalAgents) {
    blocks.push({ source: "~/.agents/AGENTS.md", content: globalAgents });
  }

  // 2. ~/.agents/rules/*.md (global agents rules)
  const globalAgentRules = await readMdDirectory(
    path.join(os.homedir(), ".agents", "rules"),
  );
  for (const b of globalAgentRules) {
    blocks.push({
      source: `~/.agents/rules/${path.basename(b.source)}`,
      content: b.content,
    });
  }

  // 3. ~/.claude/CLAUDE.md (global user instructions)
  const globalClaude = await safeReadFile(
    path.join(os.homedir(), ".claude", "CLAUDE.md"),
  );
  if (globalClaude) {
    blocks.push({ source: "~/.claude/CLAUDE.md", content: globalClaude });
  }

  // 4. Workspace root — first of AGENTS.md / AGENT.md / CLAUDE.md wins
  for (const filename of ["AGENTS.md", "AGENT.md", "CLAUDE.md"]) {
    const content = await safeReadFile(path.join(cwd, filename));
    if (content) {
      blocks.push({ source: filename, content });
      break;
    }
  }

  // 5. .claude/CLAUDE.md (Claude Code subdirectory convention)
  const dotClaudeClaude = await safeReadFile(
    path.join(cwd, ".claude", "CLAUDE.md"),
  );
  if (dotClaudeClaude) {
    blocks.push({ source: ".claude/CLAUDE.md", content: dotClaudeClaude });
  }

  // 6. .agents/rules/*.md (project-level agents convention)
  const agentRules = await readMdDirectory(path.join(cwd, ".agents", "rules"));
  for (const b of agentRules) {
    blocks.push({
      source: `.agents/rules/${path.basename(b.source)}`,
      content: b.content,
    });
  }

  // 7. .agentlink/CLAUDE.md (agentlink-specific overrides)
  const agentlinkClaude = await safeReadFile(
    path.join(cwd, ".agentlink", "CLAUDE.md"),
  );
  if (agentlinkClaude) {
    blocks.push({ source: ".agentlink/CLAUDE.md", content: agentlinkClaude });
  }

  // 8 & 9. Subfolder instruction files (when activeFilePath is within cwd)
  const activeFilePath = opts?.activeFilePath;
  if (activeFilePath) {
    const activeDir = path.dirname(activeFilePath);
    const subdirs = getSubdirChain(cwd, activeDir);

    // 8. First matching AGENTS.md / AGENT.md / CLAUDE.md per subdirectory
    for (const subdir of subdirs) {
      const relDir = path.relative(cwd, subdir);
      for (const filename of ["AGENTS.md", "AGENT.md", "CLAUDE.md"]) {
        const content = await safeReadFile(path.join(subdir, filename));
        if (content) {
          blocks.push({ source: `${relDir}/${filename}`, content });
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
  const localContent = await safeReadFile(path.join(cwd, "AGENTS.local.md"));
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
  opts?: { activeFilePath?: string },
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
 * Loads from:
 * - .agentlink/rules/*.md         (all modes, agentlink convention)
 * - .agentlink/rules-{slug}/*.md  (mode-specific, agentlink convention)
 * - .agents/rules-{slug}/*.md     (mode-specific, .agents convention)
 *
 * Files within each directory are loaded alphabetically and concatenated.
 */
export async function loadModeRules(
  cwd: string,
  modeSlug: string,
): Promise<string> {
  const sections: string[] = [];

  // .agentlink/rules/ (all modes)
  const agentlinkGlobal = await readMdDirectory(
    path.join(cwd, ".agentlink", "rules"),
  );
  sections.push(...agentlinkGlobal.map((b) => b.content));

  // .agentlink/rules-{slug}/ (mode-specific)
  const agentlinkMode = await readMdDirectory(
    path.join(cwd, ".agentlink", `rules-${modeSlug}`),
  );
  sections.push(...agentlinkMode.map((b) => b.content));

  // .agents/rules-{slug}/ (mode-specific, .agents convention)
  const agentsMode = await readMdDirectory(
    path.join(cwd, ".agents", `rules-${modeSlug}`),
  );
  sections.push(...agentsMode.map((b) => b.content));

  return sections.join("\n\n");
}
