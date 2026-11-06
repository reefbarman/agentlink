import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { createHash } from "node:crypto";

import type { MemoryTier } from "@agentlink/protocol/inline-approval";
import {
  validateMemoryProposalName,
  type MemoryProposalParams,
  validateMemoryProposalDirectory,
} from "../shared/memoryProposalEngine.js";

export interface MemoryProposalTarget {
  filePath: string;
  displayPath: string;
  /** Existing global skills are bound to the exact source shown for review. */
  globalSkillSource?: {
    homeDir: string;
    name: string;
    fingerprint: string;
  };
}

export interface MemoryProposalTargetOptions {
  homeDir?: string;
  projectRoot?: string;
  allowProjectScope?: boolean;
  /** Update/remove an existing command from any supported command source. */
  preferExistingCommandTarget?: boolean;
  resolveProjectInstructionsTarget?: (
    projectRoot: string,
  ) => Promise<MemoryProposalTarget>;
}

export async function readMemoryProposalFileIfExists(
  filePath: string,
): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

async function resolveExistingAncestor(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  while (true) {
    try {
      await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
      continue;
    }
    return await fs.realpath(current);
  }
}

export async function assertMemoryProposalTargetInsideProject(
  target: MemoryProposalTarget,
  projectRoot: string,
): Promise<void> {
  const [realRoot, realAncestor] = await Promise.all([
    fs.realpath(projectRoot),
    resolveExistingAncestor(path.dirname(target.filePath)),
  ]);
  const relative = path.relative(realRoot, realAncestor);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      "Project skill target resolves outside the approved workspace",
    );
  }
  let targetExists = true;
  try {
    await fs.lstat(target.filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    targetExists = false;
  }
  if (targetExists) {
    const realTarget = await fs.realpath(target.filePath);
    const targetRelative = path.relative(realRoot, realTarget);
    if (
      targetRelative === ".." ||
      targetRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(targetRelative)
    ) {
      throw new Error(
        "Project skill target resolves outside the approved workspace",
      );
    }
  }
}

const GLOBAL_SKILL_DIRECTORIES = [".agentlink", ".agents", ".claude"] as const;

async function globalSkillFingerprint(
  homeDir: string,
  directory: string,
  name: string,
): Promise<{
  realFile: string;
  physicalIdentity: string;
  fingerprint: string;
}> {
  const realHome = await fs.realpath(homeDir);
  const root = path.join(homeDir, directory, "skills");
  const realRoot = await fs.realpath(root);
  const filePath = path.join(root, name, "SKILL.md");
  const realFile = await fs.realpath(filePath);
  // Aliases may cross compatible skill roots, never leave their union.
  const allowedRoots = GLOBAL_SKILL_DIRECTORIES.map((source) =>
    path.join(realHome, source, "skills"),
  );
  if (
    !allowedRoots.some(
      (allowed) =>
        realRoot === allowed || realRoot.startsWith(`${allowed}${path.sep}`),
    ) ||
    !allowedRoots.some((allowed) =>
      realFile.startsWith(`${allowed}${path.sep}`),
    )
  ) {
    throw new Error(
      "Global skill target resolves outside its allowed directory",
    );
  }
  const identities = await Promise.all(
    [
      homeDir,
      path.join(homeDir, directory),
      root,
      path.dirname(filePath),
      filePath,
    ].map(async (entry) => {
      const stat = await fs.lstat(entry);
      return [await fs.realpath(entry), stat.dev, stat.ino];
    }),
  );
  const physical = await fs.stat(filePath);
  return {
    realFile,
    physicalIdentity: `${physical.dev}:${physical.ino}`,
    fingerprint: JSON.stringify([
      identities,
      createHash("sha256")
        .update(await fs.readFile(filePath))
        .digest("hex"),
    ]),
  };
}

export async function assertGlobalSkillTargetUnchanged(
  target: MemoryProposalTarget,
): Promise<void> {
  const source = target.globalSkillSource;
  if (!source) return;
  const current = await resolveMemoryProposalTarget(
    { tier: "skill", scope: "global", operation: "update", name: source.name },
    { homeDir: source.homeDir },
  );
  if (
    current.filePath !== target.filePath ||
    current.globalSkillSource?.fingerprint !== source.fingerprint
  ) {
    throw new Error(
      "Global skill target changed since review; propose it again",
    );
  }
}

export async function resolveMemoryProposalTarget(
  params: Pick<
    MemoryProposalParams,
    "tier" | "scope" | "name" | "operation" | "skill_directory"
  >,
  options: MemoryProposalTargetOptions = {},
): Promise<MemoryProposalTarget> {
  const home = options.homeDir ?? os.homedir();
  const allowProjectScope = options.allowProjectScope ?? true;
  if (params.scope === "project" && !allowProjectScope) {
    throw new Error("Project-scoped durable memory is unavailable here");
  }
  const cwd = options.projectRoot ?? process.cwd();
  const base = params.scope === "global" ? home : cwd;

  switch (params.tier) {
    case "memory": {
      const filePath = path.join(base, ".agentlink", "memory.md");
      return {
        filePath,
        displayPath:
          params.scope === "global"
            ? "~/.agentlink/memory.md"
            : ".agentlink/memory.md",
      };
    }
    case "instructions": {
      if (params.scope === "global") {
        const filePath = path.join(home, ".agentlink", "CLAUDE.md");
        return { filePath, displayPath: "~/.agentlink/CLAUDE.md" };
      }
      if (options.resolveProjectInstructionsTarget) {
        return await options.resolveProjectInstructionsTarget(cwd);
      }
      for (const filename of ["AGENTS.md", "AGENT.md", "CLAUDE.md"]) {
        const filePath = path.join(cwd, filename);
        try {
          await fs.access(filePath);
          return { filePath, displayPath: filename };
        } catch {
          // Try next convention.
        }
      }
      return {
        filePath: path.join(cwd, "AGENTS.md"),
        displayPath: "AGENTS.md",
      };
    }
    case "skill": {
      validateMemoryProposalDirectory(params);
      const name = validateMemoryProposalName(params);
      if (params.scope === "global" && params.operation !== "add") {
        const candidates: Array<{
          filePath: string;
          realFile: string;
          physicalIdentity: string;
          fingerprint: string;
        }> = [];
        for (const directory of GLOBAL_SKILL_DIRECTORIES) {
          const filePath = path.join(
            home,
            directory,
            "skills",
            name,
            "SKILL.md",
          );
          try {
            await fs.lstat(filePath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          candidates.push({
            filePath,
            ...(await globalSkillFingerprint(home, directory, name)),
          });
        }
        if (
          new Set(candidates.map((candidate) => candidate.physicalIdentity))
            .size > 1
        ) {
          throw new Error(
            `Ambiguous global skill target: ${name} exists in multiple supported directories`,
          );
        }
        if (candidates.length === 0) {
          throw new Error(
            `Skill target not found: ~/.agentlink/skills/${name}/SKILL.md`,
          );
        }
        // Use the real source, not a symlink spelling. Hardlinks have no unique
        // canonical spelling, so retain supported-root order for that one inode.
        const relativeSource = path.relative(
          await fs.realpath(home),
          candidates[0].realFile,
        );
        return {
          filePath: path.join(home, relativeSource),
          displayPath: `~/${relativeSource.split(path.sep).join("/")}`,
          globalSkillSource: {
            homeDir: home,
            name,
            // Bind every alias too, so an alias/root switch after review fails.
            fingerprint: JSON.stringify(candidates),
          },
        };
      }
      const directory =
        params.scope === "project"
          ? (params.skill_directory ?? ".agentlink/skills")
          : ".agentlink/skills";
      const filePath = path.join(base, directory, name, "SKILL.md");
      const target = {
        filePath,
        displayPath:
          params.scope === "global"
            ? `~/.agentlink/skills/${name}/SKILL.md`
            : `${directory}/${name}/SKILL.md`,
      };
      if (params.scope === "project" && params.skill_directory !== undefined) {
        await assertMemoryProposalTargetInsideProject(target, cwd);
      }
      return target;
    }
    case "command": {
      const name = validateMemoryProposalName(params);
      if (options.preferExistingCommandTarget && params.operation !== "add") {
        // Match SlashCommandRegistry precedence within the selected scope so
        // updating a loaded .agents/.claude command edits that source instead
        // of opening a blank .agentlink command as a new file.
        for (const directory of [".agentlink", ".claude", ".agents"]) {
          const filePath = path.join(base, directory, "commands", `${name}.md`);
          try {
            await fs.access(filePath);
            return {
              filePath,
              displayPath:
                params.scope === "global"
                  ? `~/${directory}/commands/${name}.md`
                  : `${directory}/commands/${name}.md`,
            };
          } catch {
            // Try the next lower-precedence compatible command source.
          }
        }
      }
      const filePath = path.join(base, ".agentlink", "commands", `${name}.md`);
      return {
        filePath,
        displayPath:
          params.scope === "global"
            ? `~/.agentlink/commands/${name}.md`
            : `.agentlink/commands/${name}.md`,
      };
    }
  }
}

export async function deleteMemoryProposalTarget(
  filePath: string,
  tier: MemoryTier,
): Promise<void> {
  await fs.rm(filePath, { force: true });
  if (tier === "skill") {
    await fs.rmdir(path.dirname(filePath)).catch(() => undefined);
  }
}
