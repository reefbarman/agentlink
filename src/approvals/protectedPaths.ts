import * as os from "os";
import * as path from "path";

const ROOT_INSTRUCTION_FILES = new Set([
  "AGENT.md",
  "AGENTS.md",
  "AGENTS.local.md",
  "CLAUDE.md",
]);
const READABLE_AGENT_INSTRUCTION_FILES = new Set([
  ...ROOT_INSTRUCTION_FILES,
  "SKILL.md",
]);

const PROTECTED_DOT_DIRS = new Set([".agentlink", ".agents", ".claude"]);
const CREDENTIAL_DIRS = new Set([".ssh", ".aws", ".gnupg"]);
const AUTHENTICATED_CLI_DIRS = [
  [".config", "gh"],
  [".config", "glab"],
  [".config", "gcloud"],
  [".azure"],
  [".kube"],
] as const;

function normalize(filePath: string): string {
  return path.resolve(filePath);
}

/**
 * Exact agent instruction artifacts are safe to read without a path approval.
 * This is intentionally filename-only: it does not trust sibling memory,
 * command, rule, credential, or environment files in the same directory.
 */
export function isAgentInstructionReadPath(filePath: string): boolean {
  const normalized = normalize(filePath);
  if (!READABLE_AGENT_INSTRUCTION_FILES.has(path.basename(normalized))) {
    return false;
  }

  const parts = normalized
    .split(path.sep)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  if (parts.some((part) => CREDENTIAL_DIRS.has(part))) return false;
  return !AUTHENTICATED_CLI_DIRS.some((directory) =>
    partsContainSequence(parts, directory),
  );
}

function partsContainSequence(
  parts: readonly string[],
  sequence: readonly string[],
): boolean {
  if (sequence.length === 0 || sequence.length > parts.length) return false;
  for (let index = 0; index <= parts.length - sequence.length; index++) {
    if (sequence.every((part, offset) => parts[index + offset] === part)) {
      return true;
    }
  }
  return false;
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return (
    rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel))
  );
}

function isDotConfigProtected(relParts: string[]): boolean {
  const [dir, ...rest] = relParts;
  if (!dir || !PROTECTED_DOT_DIRS.has(dir) || rest.length === 0) return false;

  const filename = rest[rest.length - 1];
  if (ROOT_INSTRUCTION_FILES.has(filename)) return true;
  if (filename === "memory.md" || filename === "modes.json") return true;

  const section = rest[0];
  return (
    section === "commands" ||
    section === "skills" ||
    section === "rules" ||
    section.startsWith("rules-")
  );
}

function hasProtectedDotConfigSegment(parts: string[]): boolean {
  for (let i = 0; i < parts.length; i++) {
    if (
      PROTECTED_DOT_DIRS.has(parts[i]) &&
      isDotConfigProtected(parts.slice(i))
    ) {
      return true;
    }
  }
  return false;
}

function pathParts(base: string, filePath: string): string[] | undefined {
  if (!isWithin(base, filePath)) return undefined;
  const rel = path.relative(base, filePath);
  if (!rel) return [];
  return rel.split(path.sep);
}

/**
 * Files that persist agent instructions, skills, commands, or memory must never
 * be silently auto-approved. This guard is intentionally broad: it protects both
 * AgentLink-owned locations and common AGENTS/CLAUDE instruction files.
 */
export function isMemoryProtectedPath(
  filePath: string,
  opts?: { cwd?: string; home?: string },
): boolean {
  const absPath = normalize(filePath);
  const home = normalize(opts?.home ?? os.homedir());
  const cwd = opts?.cwd ? normalize(opts.cwd) : undefined;

  const cwdParts = cwd ? pathParts(cwd, absPath) : undefined;
  if (cwdParts) {
    if (cwdParts.length > 0) {
      const filename = cwdParts[cwdParts.length - 1];
      if (ROOT_INSTRUCTION_FILES.has(filename)) return true;
    }
    if (isDotConfigProtected(cwdParts)) return true;
  }

  const homeParts = pathParts(home, absPath);
  if (homeParts) {
    if (homeParts.length > 0) {
      const filename = homeParts[homeParts.length - 1];
      if (ROOT_INSTRUCTION_FILES.has(filename)) return true;
    }
    if (isDotConfigProtected(homeParts)) return true;
  }

  // Production callers do not always know the owning workspace root (multi-root,
  // outside-workspace, approval-panel relative paths). Conservatively protect
  // recognized agent config directories anywhere in the absolute path.
  const absoluteParts = absPath.split(path.sep).filter(Boolean);
  if (hasProtectedDotConfigSegment(absoluteParts)) return true;

  // Outside the current workspace/home, protect common instruction filenames as
  // a conservative fallback for multi-root or absolute-path writes.
  return ROOT_INSTRUCTION_FILES.has(path.basename(absPath));
}

export function anyMemoryProtectedPath(
  filePaths: string[],
  opts?: { cwd?: string; home?: string },
): boolean {
  return filePaths.some((filePath) => isMemoryProtectedPath(filePath, opts));
}
