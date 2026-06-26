import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { MemoryTier } from "../approvals/webview/types.js";
import {
  validateMemoryProposalName,
  type MemoryProposalParams,
} from "../shared/memoryProposalEngine.js";

export interface MemoryProposalTarget {
  filePath: string;
  displayPath: string;
}

export interface MemoryProposalTargetOptions {
  homeDir?: string;
  projectRoot?: string;
  allowProjectScope?: boolean;
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

export async function resolveMemoryProposalTarget(
  params: Pick<MemoryProposalParams, "tier" | "scope" | "name">,
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
      const name = validateMemoryProposalName(params);
      const filePath = path.join(
        base,
        ".agentlink",
        "skills",
        name,
        "SKILL.md",
      );
      return {
        filePath,
        displayPath:
          params.scope === "global"
            ? `~/.agentlink/skills/${name}/SKILL.md`
            : `.agentlink/skills/${name}/SKILL.md`,
      };
    }
    case "command": {
      const name = validateMemoryProposalName(params);
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
