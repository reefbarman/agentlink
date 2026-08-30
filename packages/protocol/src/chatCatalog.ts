import type { CoreReasoningEffort } from "./modelCatalog.js";

export interface ChatProjectInfo {
  projectId: string;
  displayName: string;
  availability: "available" | "unavailable";
}

/** A mode available for selection by a chat surface. */
export interface ChatModeInfo {
  slug: string;
  name: string;
  icon: string;
}

export type ChatReasoningEffort = CoreReasoningEffort;

/** Presentation-ready model info sent to chat surfaces. */
export interface ChatModelInfo {
  id: string;
  displayName: string;
  provider: string;
  providerDisplayName?: string;
  supportsToolUse?: boolean;
  supportsImages?: boolean;
  contextWindow: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  reasoningEfforts?: ChatReasoningEffort[];
  defaultReasoningEffort?: ChatReasoningEffort;
  authenticated: boolean;
  condenseThreshold?: number;
}

export type ChatSlashCommandSource =
  | "builtin"
  | "project"
  | "global"
  | "agentlink"
  | "skill";

/** A slash command available for autocomplete and selection. */
export interface ChatSlashCommandInfo {
  name: string;
  /** Optional presentation/search alias. `name` remains the canonical command id. */
  displayName?: string;
  description: string;
  source: ChatSlashCommandSource;
  /** True if this is a built-in command that executes immediately. */
  builtin: boolean;
  /** Body to inject into input for file-based commands. */
  body?: string;
  /** Absolute SKILL.md path for generated skill commands. */
  skillPath?: string;
  /** Exact canonical identity for generated skill commands. */
  skillId?: string;
  /** SHA-256 content revision advertised with the generated skill command. */
  skillRevision?: string;
  /** Codicon name to show next to the command. */
  icon?: string;
  /** Value shown right-aligned, such as the current model name. */
  rightLabel?: string;
  /** Show a checkmark for the current selection. */
  isCurrent?: boolean;
}
