import * as fs from "fs/promises";
import * as path from "path";

import {
  CUSTOM_MODE_FILE_PATHS,
  mergeCustomModeSources,
  type AgentMode,
} from "@agentlink/core/agent-modes";

// The mode catalogue and resolution rules are shared with every agent surface.
export {
  BUILT_IN_MODES,
  buildUnionAgentMode,
  getAllModes,
  resolveMode,
  type AgentMode,
} from "@agentlink/core/agent-modes";

/**
 * Load custom mode definitions from modes.json files (project-level only).
 *
 * Priority (.agents → .claude → .agentlink): later sources override
 * earlier for the same slug.
 */
export async function loadCustomModes(cwd: string): Promise<AgentMode[]> {
  const sources = await Promise.all(
    CUSTOM_MODE_FILE_PATHS.map(async (segments) => {
      try {
        return await fs.readFile(path.join(cwd, ...segments), "utf-8");
      } catch {
        // File doesn't exist or is unreadable — skip
        return undefined;
      }
    }),
  );
  return mergeCustomModeSources(sources);
}
