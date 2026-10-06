import type {
  CoreModelCatalogAuthAction,
  CoreModelCatalogEntry,
  CoreModelCatalogReadiness,
  CoreModelCatalogSnapshot,
  CoreModelServiceTier,
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
  serviceTiers?: CoreModelServiceTier[];
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
    ...(model.serviceTiers?.length
      ? { serviceTiers: [...model.serviceTiers] }
      : {}),
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
  /**
   * The host activates this skill itself when selected. Composers send an
   * ExplicitSkillSelection plus the literal user text instead of `body`.
   * Absent on hosts that only support the prompt-only body.
   */
  directActivation?: boolean;
  /** Codicon name to show next to the command. */
  icon?: string;
  /** Value shown right-aligned, such as the current model name. */
  rightLabel?: string;
  /** Show a checkmark for the current selection. */
  isCurrent?: boolean;
}

/**
 * A user's explicit choice of a catalogue skill for one message. Intent only:
 * the host resolves path and content from its own current catalogue and
 * rejects a changed revision instead of substituting another one.
 */
export interface ExplicitSkillSelection {
  skillId: string;
  skillRevision: string;
}

export type SkillSelectionFailureCode =
  | "skill_selection_unavailable"
  | "skill_selection_stale"
  | "skill_selection_unreadable"
  | "skill_selection_hook_denied"
  | "skill_selection_too_large"
  | "skill_selection_conflict";

/** Recoverable failure that blocked a selected message before model dispatch. */
export interface SkillSelectionFailure {
  code: SkillSelectionFailureCode;
  message: string;
  skillId: string;
  selectedRevision: string;
  skillName?: string;
  /** Current enabled revision, when the selected one is stale. */
  currentRevision?: string;
}

/** Display record for a host-committed explicit skill activation. */
export interface ExplicitSkillActivationView {
  /** Stable activation record ID; also the transcript card ID. */
  activationId: string;
  skillId: string;
  skillName: string;
  revision: string;
  skillPath: string;
  content: string;
}

const MAX_SKILL_SELECTION_FIELD_CHARS = 512;

/**
 * Parse untrusted transport input. Returns undefined when absent and null
 * when present but malformed, so callers can reject instead of ignoring it.
 */
export function parseExplicitSkillSelection(
  value: unknown,
): ExplicitSkillSelection | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const { skillId, skillRevision } = value as Record<string, unknown>;
  if (
    typeof skillId !== "string" ||
    typeof skillRevision !== "string" ||
    !skillId.trim() ||
    !skillRevision.trim() ||
    skillId.length > MAX_SKILL_SELECTION_FIELD_CHARS ||
    skillRevision.length > MAX_SKILL_SELECTION_FIELD_CHARS
  ) {
    return null;
  }
  return { skillId, skillRevision };
}
