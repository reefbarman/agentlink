import type {
  CoreModelCatalogAuthAction,
  CoreModelCatalogEntry,
  CoreModelCatalogReadiness,
  CoreModelCatalogSnapshot,
  CoreReasoningEffort,
} from "./modelCatalog.js";

import { resolveCoreModelCatalogReadiness } from "./modelCatalog.js";

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
  readiness?: CoreModelCatalogReadiness;
  authAction?: CoreModelCatalogAuthAction;
  unavailableReason?: string;
  condenseThreshold?: number;
}

/** Project the shared catalog snapshot into the model DTO used by chat surfaces. */
export function projectCoreModelCatalogToChatModels(
  snapshot: Pick<CoreModelCatalogSnapshot, "models">,
): ChatModelInfo[] {
  return snapshot.models.map(projectCoreModelCatalogEntryToChatModel);
}

export function projectCoreModelCatalogEntryToChatModel(
  model: CoreModelCatalogEntry,
): ChatModelInfo {
  const readiness = resolveCoreModelCatalogReadiness(model);
  const blocked =
    readiness.status === "credentials_required" ||
    readiness.status === "configuration_required";
  return {
    id: model.id,
    displayName: model.displayName,
    provider: model.providerId,
    providerDisplayName: model.providerDisplayName,
    supportsToolUse: model.supportsToolUse,
    supportsImages: model.supportsImages,
    contextWindow: model.contextWindow,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    reasoningEfforts: model.reasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
    authenticated: readiness.status === "ready",
    readiness,
    authAction: blocked ? readiness.action : undefined,
    unavailableReason:
      readiness.status === "ready" || readiness.status === "checking"
        ? undefined
        : readiness.reason,
    condenseThreshold: model.condenseThreshold,
  };
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
