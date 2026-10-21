import * as os from "os";

import {
  loadAllInstructionBlocks as loadSharedInstructionBlocks,
  type InstructionBlock,
} from "@agentlink/node-host";

/**
 * VS Code's instruction discovery. The implementation is shared with every
 * other agent surface in `@agentlink/node-host` (`instructionDiscovery.ts`);
 * VS Code only supplies its home folder.
 */
export {
  loadModeRules,
  resolveProjectActiveFilePath,
  type InstructionBlock,
  type ProjectActiveFileResolution,
} from "@agentlink/node-host";

/** See `loadAllInstructionBlocks` in `@agentlink/node-host`. */
export async function loadAllInstructionBlocks(
  cwd: string,
  opts?: { activeFilePath?: string },
): Promise<InstructionBlock[]> {
  return loadSharedInstructionBlocks(cwd, {
    ...opts,
    homeDir: os.homedir(),
  });
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
