import type { WorktreeAgentLaunchRequest } from "../core/capabilities/worktree.js";

export type WorktreeSlashDraft = Partial<
  Omit<WorktreeAgentLaunchRequest, "fleetExchangeId" | "commandApprovalPolicy">
>;

export interface ParsedWorktreeSlashCommand {
  draft: WorktreeSlashDraft;
  needsConfiguration: boolean;
}

const VALUE_FLAGS: Record<string, keyof WorktreeSlashDraft> = {
  "--task": "task",
  "--prompt": "prompt",
  "--branch": "branch",
  "--base": "baseRef",
  "--base-ref": "baseRef",
  "--path": "worktreePath",
  "--worktree-path": "worktreePath",
  "--mode": "mode",
};

export function parseWorktreeSlashCommand(
  input: string,
): ParsedWorktreeSlashCommand {
  const tokens = tokenizeSlashArgs(input);
  const draft: Partial<WorktreeSlashDraft> = {};
  const positional: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--prefill" || token === "--no-autosubmit") {
      draft.autoSubmit = false;
      continue;
    }
    if (token === "--autosubmit") {
      draft.autoSubmit = true;
      continue;
    }

    const equals = token.indexOf("=");
    const flag = equals >= 0 ? token.slice(0, equals) : token;
    const field = VALUE_FLAGS[flag];
    if (field) {
      const value =
        equals >= 0 ? token.slice(equals + 1) : tokens[(index += 1)];
      if (!value?.trim() || value.startsWith("--")) {
        throw new Error(`${flag} requires a value.`);
      }
      (draft as Record<string, unknown>)[field] = value.trim();
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown /worktree option: ${token}`);
    }
    positional.push(token);
  }

  const description = positional.join(" ").trim();
  if (description) {
    draft.prompt ??= description;
    draft.task ??= deriveTask(description);
  }
  if (draft.prompt && !draft.task) draft.task = deriveTask(draft.prompt);
  if (draft.task && !draft.prompt) draft.prompt = draft.task;

  return {
    draft,
    needsConfiguration: !draft.task?.trim() || !draft.prompt?.trim(),
  };
}

export function extractWorktreeSetupConfig(answer: string): {
  displayText: string;
  draft?: WorktreeSlashDraft;
  error?: string;
} {
  const match = answer.match(
    /<worktree-config>\s*([\s\S]*?)\s*<\/worktree-config>/i,
  );
  const displayText = answer
    .replace(/<worktree-config>[\s\S]*?<\/worktree-config>/gi, "")
    .trim();
  if (!match) return { displayText };

  try {
    const value = JSON.parse(match[1]!) as Record<string, unknown>;
    const task = stringValue(value.task);
    const prompt = stringValue(value.prompt);
    if (!task || !prompt) {
      return {
        displayText,
        error: "The setup agent returned an incomplete worktree configuration.",
      };
    }
    const draft: WorktreeSlashDraft = { task, prompt };
    copyString(value, draft, "branch");
    copyString(value, draft, "baseRef");
    copyString(value, draft, "worktreePath");
    copyString(value, draft, "mode");
    if (typeof value.autoSubmit === "boolean") {
      draft.autoSubmit = value.autoSubmit;
    }
    return { displayText, draft };
  } catch (error) {
    return {
      displayText,
      error: `The setup agent returned invalid configuration JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function copyString(
  source: Record<string, unknown>,
  target: WorktreeSlashDraft,
  field: "branch" | "baseRef" | "worktreePath" | "mode",
): void {
  const value = stringValue(source[field]);
  if (value) target[field] = value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function deriveTask(description: string): string {
  const compact = description.replace(/\s+/g, " ").trim();
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trim()}…`;
}

function tokenizeSlashArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  const trimmed = input.trim();

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (char === "\\" && quote !== "'") {
      const next = trimmed[index + 1];
      const escapable =
        next === "\\" ||
        next === '"' ||
        (!quote && (next === "'" || Boolean(next && /\s/.test(next))));
      if (escapable) {
        current += next;
        index += 1;
        continue;
      }
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  if (quote) throw new Error("Unterminated quote in /worktree arguments.");
  if (current) tokens.push(current);
  return tokens;
}
