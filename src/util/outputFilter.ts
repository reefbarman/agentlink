import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const DEFAULT_OUTPUT_LINES = 200;
const MAX_TEMP_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface FilterOptions {
  output_head?: number;
  output_tail?: number;
  output_offset?: number;
  output_grep?: string;
  output_grep_context?: number;
}

export interface FilterResult {
  filtered: string;
  totalLines: number;
  linesShown: number;
}

/**
 * Filter command output by grep pattern and/or head/tail line limits.
 * Order: grep first → then head/tail on the filtered result.
 * If no explicit filter is given, defaults to last DEFAULT_OUTPUT_LINES lines.
 */
export function filterOutput(
  fullOutput: string,
  options: FilterOptions,
): FilterResult {
  // Strip trailing newline before splitting to avoid off-by-one
  const trimmed = fullOutput.endsWith("\n")
    ? fullOutput.slice(0, -1)
    : fullOutput;
  const allLines = trimmed.length === 0 ? [] : trimmed.split("\n");
  const totalLines = allLines.length;

  const hasExplicitFilter =
    options.output_head !== undefined ||
    options.output_tail !== undefined ||
    options.output_offset !== undefined ||
    options.output_grep !== undefined;

  let lines = allLines;

  // Step 1: grep filter
  if (options.output_grep !== undefined) {
    const context = options.output_grep_context ?? 0;
    lines = grepLines(lines, options.output_grep, context);
  }

  // Step 2: offset (skip first N lines/matches)
  if (options.output_offset !== undefined && options.output_offset > 0) {
    lines = lines.slice(options.output_offset);
  }

  // Step 3: head/tail (head wins if both specified)
  if (options.output_head !== undefined) {
    lines = lines.slice(0, options.output_head);
  } else if (options.output_tail !== undefined) {
    lines = lines.slice(-options.output_tail);
  } else if (!hasExplicitFilter && totalLines > DEFAULT_OUTPUT_LINES) {
    // Default cap: last N lines when no explicit filter
    lines = lines.slice(-DEFAULT_OUTPUT_LINES);
  }

  return {
    filtered: lines.join("\n"),
    totalLines,
    linesShown: lines.length,
  };
}

/**
 * Filter lines matching a regex pattern, with optional context lines (like grep -C).
 */
function grepLines(
  lines: string[],
  pattern: string,
  context: number,
): string[] {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    // If the pattern is invalid regex, treat it as a literal string
    regex = new RegExp(escapeRegex(pattern), "i");
  }

  // Collect matching line indices, expanding with context ranges
  const matchIndices = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      for (
        let j = Math.max(0, i - context);
        j <= Math.min(lines.length - 1, i + context);
        j++
      ) {
        matchIndices.add(j);
      }
    }
  }

  const sorted = Array.from(matchIndices).sort((a, b) => a - b);

  // No context → no separators needed
  if (context === 0) {
    return sorted.map((i) => lines[i]);
  }

  // Insert "--" separators between non-contiguous groups
  const result: string[] = [];
  for (let k = 0; k < sorted.length; k++) {
    if (k > 0 && sorted[k] !== sorted[k - 1] + 1) {
      result.push("--");
    }
    result.push(lines[sorted[k]]);
  }
  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Save full output to a temp file. Returns the file path, or null if the
 * output exceeds MAX_TEMP_FILE_BYTES.
 */
export function saveOutputTempFile(output: string): string | null {
  const bytes = Buffer.byteLength(output, "utf-8");
  if (bytes > MAX_TEMP_FILE_BYTES) {
    return null;
  }

  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-output-"));
    const filePath = path.join(tmpDir, "output.txt");
    fs.writeFileSync(filePath, output, "utf-8");
    return filePath;
  } catch {
    return null;
  }
}
