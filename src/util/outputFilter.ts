import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  filterCommandOutput,
  redactCommandOutput,
  type CommandOutputFilterOptions,
  type CommandOutputFilterResult,
} from "@agentlink/core/command-output";

const MAX_TEMP_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

export type FilterOptions = CommandOutputFilterOptions;
export type FilterResult = CommandOutputFilterResult;

/**
 * Filter command output by grep pattern and/or head/tail line limits.
 * Shared with the standalone hosts through `@agentlink/core/command-output`.
 */
export function filterOutput(
  fullOutput: string,
  options: FilterOptions,
): FilterResult {
  return filterCommandOutput(fullOutput, options);
}

/**
 * Save full output to a temp file. Returns the file path, or null if the
 * output exceeds MAX_TEMP_FILE_BYTES.
 */
export function saveOutputTempFile(output: string): string | null {
  const safeOutput = redactCommandOutput(output);
  const bytes = Buffer.byteLength(safeOutput, "utf-8");
  if (bytes > MAX_TEMP_FILE_BYTES) {
    return null;
  }

  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-output-"));
    const filePath = path.join(tmpDir, "output.txt");
    fs.writeFileSync(filePath, safeOutput, "utf-8");
    return filePath;
  } catch {
    return null;
  }
}
