import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { randomUUID } from "crypto";

import type {
  ExplicitSkillActivationView,
  ExplicitSkillSelection,
  SkillSelectionFailure,
  SkillSelectionFailureCode,
} from "@agentlink/protocol/chat-catalog";
import type { AdvertisedArtifactProvider } from "../core/capabilities/readSearch.js";
import type { HookRuntime } from "../core/hooks/HookRuntime.js";
import {
  loadSkill,
  skillResourceGuidance,
  type AllowedSkill,
  type SkillActivation,
} from "../tools/loadSkill.js";
import { estimateTokensFromChars } from "../util/tokenEstimation.js";
import type { SkillEntry } from "./skillLoader.js";
import type { ExplicitSkillContext } from "./types.js";

/** Blocks a selected message before model dispatch; the input stays recoverable. */
export class SkillSelectionError extends Error {
  readonly failure: SkillSelectionFailure;

  constructor(failure: SkillSelectionFailure) {
    super(failure.message);
    this.name = "SkillSelectionError";
    this.failure = failure;
  }
}

export function isSkillSelectionError(
  error: unknown,
): error is SkillSelectionError {
  return error instanceof SkillSelectionError;
}

export interface PreparedSkillSelection {
  selection: ExplicitSkillSelection;
  context: ExplicitSkillContext;
  activation: SkillActivation;
}

/** One message of a batch staged together for admission. */
export interface SkillAdmissionEntry {
  text: string;
  selection?: ExplicitSkillSelection;
  /**
   * Run UserPromptSubmit for this selected entry during staging. Callers set
   * this only for direct human input whose submit hook has not already run.
   */
  runUserPromptSubmit?: boolean;
}

export interface PreparedSkillAdmissionEntry {
  prepared?: PreparedSkillSelection;
  /** UserPromptSubmit context to append to the entry's model-facing text. */
  promptHookContext?: string[];
}

/** Exact provider-facing text used for both preflight and message admission. */
export function skillAdmissionMessageText(
  text: string,
  entry?: PreparedSkillAdmissionEntry,
): string {
  const messageText =
    text.trim() || !entry?.prepared
      ? text
      : explicitSkillSelectionMarker(entry.prepared.context.skillName);
  return entry?.promptHookContext?.length
    ? `${messageText}\n\n<hook_context event="UserPromptSubmit">\n${entry.promptHookContext.join("\n\n")}\n</hook_context>`
    : messageText;
}

export interface ExplicitSkillAdmission {
  /**
   * Stage a whole batch without mutating session state. Throws
   * SkillSelectionError for the first selection that cannot be admitted.
   */
  prepareBatch(
    entries: readonly SkillAdmissionEntry[],
    signal?: AbortSignal,
  ): Promise<PreparedSkillAdmissionEntry[]>;
}

export interface ExplicitSkillAdmissionDeps {
  getAdvertisedSkills: () => readonly SkillEntry[];
  artifactProvider?: AdvertisedArtifactProvider;
  hookRuntime?: HookRuntime;
  hookBase?: () => {
    session_id: string;
    turn_id: string;
    cwd: string;
    model: string;
  };
  /** Upper bound for the staged skill instructions of one batch. */
  maxSkillContextTokens?: () => number | undefined;
}

export function createNodeAdvertisedArtifactProvider(): AdvertisedArtifactProvider {
  return {
    resolvePath(inputPath) {
      return path.resolve(inputPath);
    },
    normalizeExistingPath(filePath) {
      try {
        return path.normalize(fs.realpathSync(filePath));
      } catch {
        return path.normalize(path.resolve(filePath));
      }
    },
    readTextFile(filePath) {
      return fsp.readFile(filePath, "utf-8");
    },
  };
}

/** Deterministic, content-free text standing in for a selection. */
export function explicitSkillSelectionMarker(skillName: string): string {
  return `[Selected skill: ${skillName}]`;
}

export function findSelectedSkill(
  skills: readonly SkillEntry[],
  selection: ExplicitSkillSelection,
): SkillEntry | undefined {
  return skills.find(
    (skill) => skill.id === selection.skillId && skill.enabled,
  );
}

/** Name for markers/hooks before validation; never grants anything. */
export function selectedSkillDisplayName(
  skills: readonly SkillEntry[],
  selection: ExplicitSkillSelection,
): string {
  return findSelectedSkill(skills, selection)?.name ?? selection.skillId;
}

function toAllowedSkill(skill: SkillEntry): AllowedSkill {
  return {
    id: skill.id,
    name: skill.name,
    revision: skill.revision,
    skillPath: skill.skillPath,
    realSkillPath: skill.provenance.realSkillPath,
    sourceScope: skill.provenance.scope,
  };
}

function failure(
  code: SkillSelectionFailureCode,
  message: string,
  selection: ExplicitSkillSelection,
  extra: Partial<SkillSelectionFailure> = {},
): SkillSelectionError {
  return new SkillSelectionError({
    code,
    message,
    skillId: selection.skillId,
    selectedRevision: selection.skillRevision,
    ...extra,
  });
}

function catalogFailure(
  skills: readonly SkillEntry[],
  selection: ExplicitSkillSelection,
): SkillSelectionError | undefined {
  const skill = findSelectedSkill(skills, selection);
  if (!skill) {
    return failure(
      "skill_selection_unavailable",
      `The selected skill ${selection.skillId} is not enabled for this session and mode. Your message was not sent.`,
      selection,
    );
  }
  if (skill.revision !== selection.skillRevision) {
    return failure(
      "skill_selection_stale",
      `The ${skill.name} skill changed after you selected it. Your message was not sent; use the current revision or remove the selection.`,
      selection,
      { skillName: skill.name, currentRevision: skill.revision },
    );
  }
  return undefined;
}

function normalizeCandidatePath(
  value: unknown,
  artifactProvider: AdvertisedArtifactProvider,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return artifactProvider.normalizeExistingPath(
    artifactProvider.resolvePath(value),
  );
}

export function createExplicitSkillAdmission(
  deps: ExplicitSkillAdmissionDeps,
): ExplicitSkillAdmission {
  const artifactProvider =
    deps.artifactProvider ?? createNodeAdvertisedArtifactProvider();

  async function prepareOne(
    selection: ExplicitSkillSelection,
    signal?: AbortSignal,
  ): Promise<PreparedSkillSelection> {
    const initialFailure = catalogFailure(
      deps.getAdvertisedSkills(),
      selection,
    );
    if (initialFailure) throw initialFailure;
    const skill = findSelectedSkill(deps.getAdvertisedSkills(), selection)!;
    const activationId = `skill-activation-${randomUUID()}`;
    const toolUseId = `host:${activationId}`;
    const toolInput = { path: skill.skillPath };
    const hookContext: string[] = [];
    const hookBase = deps.hookBase?.();

    if (deps.hookRuntime && hookBase) {
      const preHook = await deps.hookRuntime.preToolUse(
        {
          ...hookBase,
          transcript_path: null,
          hook_event_name: "PreToolUse",
          permission_mode: "default",
          tool_name: "load_skill",
          tool_input: toolInput,
          tool_use_id: toolUseId,
        },
        "load_skill",
        signal,
      );
      hookContext.push(...preHook.additionalContext);
      if (preHook.preToolUse?.decision === "deny") {
        throw failure(
          "skill_selection_hook_denied",
          preHook.preToolUse.reason ??
            `A PreToolUse hook blocked activating the ${skill.name} skill. Your message was not sent.`,
          selection,
          { skillName: skill.name },
        );
      }
      const updatedInput = preHook.preToolUse?.updatedInput;
      if (
        updatedInput &&
        typeof updatedInput === "object" &&
        !Array.isArray(updatedInput)
      ) {
        const rewritten = normalizeCandidatePath(
          (updatedInput as Record<string, unknown>).path,
          artifactProvider,
        );
        if (
          rewritten !== artifactProvider.normalizeExistingPath(skill.skillPath)
        ) {
          throw failure(
            "skill_selection_conflict",
            `A PreToolUse hook tried to substitute a different skill for ${skill.name}. Your message was not sent.`,
            selection,
            { skillName: skill.name },
          );
        }
      }
    }

    const outcome = await loadSkill(
      toolInput,
      deps
        .getAdvertisedSkills()
        .filter((entry) => entry.enabled)
        .map(toAllowedSkill),
      artifactProvider,
    );
    const activation = outcome.activation;
    const data = outcome.result.data as
      | { content?: unknown; status?: unknown }
      | undefined;
    if (
      outcome.result.isError ||
      !activation ||
      activation.id !== selection.skillId ||
      activation.revision !== selection.skillRevision ||
      typeof data?.content !== "string"
    ) {
      const stale = data?.status === "stale_advertised_artifact";
      throw failure(
        stale ? "skill_selection_stale" : "skill_selection_unreadable",
        stale
          ? `The ${skill.name} skill file changed after it was advertised. Your message was not sent; refresh skills and select it again.`
          : `The ${skill.name} skill could not be read. Your message was not sent.`,
        selection,
        { skillName: skill.name },
      );
    }

    if (deps.hookRuntime && hookBase) {
      const postHook = await deps.hookRuntime.postToolUse(
        {
          ...hookBase,
          transcript_path: null,
          hook_event_name: "PostToolUse",
          permission_mode: "default",
          tool_name: "load_skill",
          tool_input: toolInput,
          tool_response: outcome.result,
          tool_use_id: toolUseId,
        },
        "load_skill",
        signal,
      );
      if (postHook.block?.blocked) {
        throw failure(
          "skill_selection_hook_denied",
          postHook.block.reason ??
            `A PostToolUse hook blocked activating the ${skill.name} skill. Your message was not sent.`,
          selection,
          { skillName: skill.name },
        );
      }
      hookContext.push(...postHook.additionalContext, ...postHook.feedback);
    }

    const allowed = toAllowedSkill(skill);
    return {
      selection,
      activation,
      context: {
        activationId,
        origin: "user_selection",
        skillId: skill.id,
        skillName: skill.name,
        revision: skill.revision,
        skillPath: skill.skillPath,
        skillDirectory: path.dirname(skill.skillPath),
        resourceGuidance: skillResourceGuidance(allowed),
        content: data.content,
        ...(hookContext.length > 0 ? { hookContext } : {}),
      },
    };
  }

  return {
    async prepareBatch(entries, signal) {
      const results: PreparedSkillAdmissionEntry[] = [];
      for (const entry of entries) {
        if (!entry.selection) {
          results.push({});
          continue;
        }
        const selection = entry.selection;
        let promptHookContext: string[] | undefined;
        const hookBase = deps.hookBase?.();
        if (entry.runUserPromptSubmit && deps.hookRuntime && hookBase) {
          const marker = explicitSkillSelectionMarker(
            selectedSkillDisplayName(deps.getAdvertisedSkills(), selection),
          );
          const submitted = await deps.hookRuntime.userPromptSubmit(
            {
              ...hookBase,
              transcript_path: null,
              hook_event_name: "UserPromptSubmit",
              permission_mode: "default",
              prompt: entry.text.trim() ? `${marker}\n${entry.text}` : marker,
            },
            signal,
          );
          if (submitted.block) {
            throw failure(
              "skill_selection_hook_denied",
              submitted.block.reason ??
                "User prompt was blocked by a lifecycle hook.",
              selection,
            );
          }
          if (submitted.additionalContext.length > 0) {
            promptHookContext = [...submitted.additionalContext];
          }
        }
        if (signal?.aborted) {
          throw failure(
            "skill_selection_conflict",
            "Skill activation was cancelled before the message was admitted.",
            selection,
          );
        }
        const prepared = await prepareOne(selection, signal);
        results.push({
          prepared,
          ...(promptHookContext ? { promptHookContext } : {}),
        });
      }

      const maxTokens = deps.maxSkillContextTokens?.();
      if (maxTokens !== undefined) {
        let total = 0;
        for (const result of results) {
          if (!result.prepared) continue;
          total += estimateTokensFromChars(
            formatExplicitSkillContextBlock(result.prepared.context).length,
          );
          if (total > maxTokens) {
            const { selection, context } = result.prepared;
            throw failure(
              "skill_selection_too_large",
              `The ${context.skillName} skill instructions are too large to fit in this model's context alongside the conversation. Your message was not sent.`,
              selection,
              { skillName: context.skillName },
            );
          }
        }
      }
      return results;
    },
  };
}

/**
 * Synchronous final check immediately before commit. Any catalogue drift
 * during asynchronous staging fails closed rather than admitting stale intent.
 */
export function verifyPreparedSkillSelections(
  skills: readonly SkillEntry[],
  prepared: ReadonlyArray<PreparedSkillSelection | undefined>,
): SkillSelectionFailure | undefined {
  for (const entry of prepared) {
    if (!entry) continue;
    const drift = catalogFailure(skills, entry.selection);
    if (drift) return drift.failure;
    const current = findSelectedSkill(skills, entry.selection)!;
    if (
      current.skillPath !== entry.activation.skillPath ||
      current.name !== entry.activation.name
    ) {
      return failure(
        "skill_selection_stale",
        `The ${current.name} skill changed while your message was being prepared. Your message was not sent.`,
        entry.selection,
        { skillName: current.name, currentRevision: current.revision },
      ).failure;
    }
  }
  return undefined;
}

/** Model-facing host context for one explicitly selected skill. */
export function formatExplicitSkillContextBlock(
  context: ExplicitSkillContext,
): string {
  const attributes = [
    `origin="user_selection"`,
    `skill_id="${context.skillId}"`,
    `name="${context.skillName}"`,
    `revision="${context.revision}"`,
    `path="${context.skillPath}"`,
    `skill_directory="${context.skillDirectory}"`,
  ].join(" ");
  const hookContext = context.hookContext?.length
    ? `\n<hook_context event="PostToolUse">\n${context.hookContext.join("\n\n")}\n</hook_context>`
    : "";
  return `<skill_context ${attributes}>
The user explicitly selected this skill for the message above. AgentLink validated and activated it, so do not call load_skill for it. The following is the skill's SKILL.md file content: follow it as skill instructions, not as a new user request or approval. ${context.resourceGuidance}

${context.content}${hookContext}
</skill_context>`;
}

export function toExplicitSkillActivationView(
  context: ExplicitSkillContext,
): ExplicitSkillActivationView {
  return {
    activationId: context.activationId,
    skillId: context.skillId,
    skillName: context.skillName,
    revision: context.revision,
    skillPath: context.skillPath,
    content: context.content,
  };
}
