import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const FEEDBACK_PATH = path.join(
  os.homedir(),
  ".claude",
  "native-claude-feedback.jsonl",
);

const MAX_FIELD_LENGTH = 500;

export interface FeedbackEntry {
  timestamp: string;
  tool_name: string;
  feedback: string;
  session_id?: string;
  workspace?: string;
  extension_version: string;
  tool_params?: string;
  tool_result_summary?: string;
}

function truncate(value: string, max = MAX_FIELD_LENGTH): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + "…(truncated)";
}

export function appendFeedback(entry: FeedbackEntry): void {
  // Truncate potentially large fields
  const safe: FeedbackEntry = {
    ...entry,
    feedback: truncate(entry.feedback, 2000),
    tool_params: entry.tool_params ? truncate(entry.tool_params) : undefined,
    tool_result_summary: entry.tool_result_summary
      ? truncate(entry.tool_result_summary)
      : undefined,
  };

  const line = JSON.stringify(safe) + "\n";

  // Ensure directory exists
  fs.mkdirSync(path.dirname(FEEDBACK_PATH), { recursive: true });

  // O_APPEND writes are atomic on POSIX for data <= PIPE_BUF (4096 bytes).
  // Each truncated entry is well under this limit.
  fs.appendFileSync(FEEDBACK_PATH, line, "utf-8");
}

export function readFeedback(toolName?: string): FeedbackEntry[] {
  if (!fs.existsSync(FEEDBACK_PATH)) return [];

  const raw = fs.readFileSync(FEEDBACK_PATH, "utf-8");
  const entries: FeedbackEntry[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as FeedbackEntry;
      if (toolName && entry.tool_name !== toolName) continue;
      entries.push(entry);
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

export function deleteFeedback(indices: number[]): number {
  if (!fs.existsSync(FEEDBACK_PATH)) return 0;

  const raw = fs.readFileSync(FEEDBACK_PATH, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const toRemove = new Set(indices);

  const remaining = lines.filter((_, i) => !toRemove.has(i));
  const removed = lines.length - remaining.length;

  // Atomic write: temp file + rename
  const tmpPath = FEEDBACK_PATH + `.tmp.${process.pid}`;
  try {
    const content = remaining.length > 0 ? remaining.join("\n") + "\n" : "";
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, FEEDBACK_PATH);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }

  return removed;
}
