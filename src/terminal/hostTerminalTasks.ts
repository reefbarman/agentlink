import {
  MAX_TERMINAL_CWD_BYTES,
  MAX_TERMINAL_INPUT_BYTES,
} from "@agentlink/protocol/terminal-surface";
import { isAbsolute, relative, resolve } from "node:path";

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

export const HOST_TERMINAL_TASKS_RELATIVE_PATH = ".agentlink/tasks.json";
export const MAX_HOST_TERMINAL_TASKS_FILE_BYTES = 256 * 1024;
export const MAX_HOST_TERMINAL_TASKS = 100;
export const MAX_HOST_TERMINAL_TASK_LABEL_BYTES = 200;

export const HOST_TERMINAL_TASKS_TEMPLATE = `{
  "tasks": [
    {
      "label": "Build",
      "command": "npm run build"
    },
    {
      "label": "Tests",
      "command": "npm test",
      "cwd": "."
    }
  ]
}
`;

export interface HostTerminalTaskDefinition {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly cwd?: string;
}

export interface ParsedHostTerminalTasks {
  readonly tasks: readonly HostTerminalTaskDefinition[];
  readonly errors: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

export function parseHostTerminalTasks(
  content: string,
): ParsedHostTerminalTasks {
  if (Buffer.byteLength(content, "utf8") > MAX_HOST_TERMINAL_TASKS_FILE_BYTES) {
    return { tasks: [], errors: ["tasks.json exceeds the 256 KB limit"] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { tasks: [], errors: ["tasks.json is not valid JSON"] };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) {
    return { tasks: [], errors: ['tasks.json must contain a "tasks" array'] };
  }

  const tasks: HostTerminalTaskDefinition[] = [];
  const errors: string[] = [];
  if (parsed.tasks.length > MAX_HOST_TERMINAL_TASKS) {
    errors.push(`Only the first ${MAX_HOST_TERMINAL_TASKS} tasks are used`);
  }
  for (const [index, candidate] of parsed.tasks
    .slice(0, MAX_HOST_TERMINAL_TASKS)
    .entries()) {
    if (!isRecord(candidate)) {
      errors.push(`Task ${index + 1} must be an object`);
      continue;
    }
    if (!validString(candidate.label, MAX_HOST_TERMINAL_TASK_LABEL_BYTES)) {
      errors.push(`Task ${index + 1} has an invalid label`);
      continue;
    }
    if (!validString(candidate.command, MAX_TERMINAL_INPUT_BYTES - 1)) {
      errors.push(`Task ${index + 1} has an invalid command`);
      continue;
    }
    if (
      Object.hasOwn(candidate, "cwd") &&
      !validString(candidate.cwd, MAX_TERMINAL_CWD_BYTES)
    ) {
      errors.push(`Task ${index + 1} has an invalid cwd`);
      continue;
    }
    tasks.push({
      id: `task-${index}`,
      label: candidate.label,
      command: candidate.command,
      ...(typeof candidate.cwd === "string" ? { cwd: candidate.cwd } : {}),
    });
  }
  return { tasks, errors };
}

export function createHostTerminalTasksRevision(
  projectRoot: string,
  tasks: readonly HostTerminalTaskDefinition[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ projectRoot, tasks }))
    .digest("hex");
}

export async function resolveHostTerminalTaskCwd(
  projectRoot: string,
  cwd: string,
): Promise<string | undefined> {
  const canonicalRoot = await realpath(projectRoot);
  let candidate: string;
  try {
    candidate = await realpath(
      isAbsolute(cwd) ? cwd : resolve(projectRoot, cwd),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const relativePath = relative(canonicalRoot, candidate);
  return relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
    ? candidate
    : undefined;
}

export function quoteHostShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function composeHostTerminalTaskCommand(
  task: HostTerminalTaskDefinition,
  resolvedCwd?: string,
): string | undefined {
  const command = resolvedCwd
    ? `(cd ${quoteHostShellArgument(resolvedCwd)} && ${task.command})`
    : task.command;
  return Buffer.byteLength(`${command}\r`, "utf8") <= MAX_TERMINAL_INPUT_BYTES
    ? command
    : undefined;
}
