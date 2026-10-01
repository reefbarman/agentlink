import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { MemoryTier } from "@agentlink/protocol/inline-approval";
import {
  validateMemoryProposalName,
  type MemoryProposalParams,
  validateMemoryProposalDirectory,
} from "../shared/memoryProposalEngine.js";

export interface MemoryProposalTarget {
  filePath: string;
  displayPath: string;
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
