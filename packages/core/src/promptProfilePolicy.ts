import {
  PROMPT_PROFILE_POLICY_REVISION,
  isPromptProfile,
  type PromptProfile,
  type PromptProfileResolution,
} from "@agentlink/protocol/prompt-profile";

/** Deliberate defaults for the maintained Codex roster, independent of auth transport. */
export const CODEX_MODEL_PROMPT_PROFILES: Readonly<
  Record<string, PromptProfile>
> = Object.freeze({
  "gpt-6-astra": "reasoning",
  "gpt-6.1-sol": "reasoning",
  "gpt-6-luna": "compatibility",
  "gpt-5.6-sol": "reasoning",
  "gpt-5.6-terra": "reasoning",
  "gpt-5.6-luna": "compatibility",
  "gpt-5.5": "reasoning",
  "gpt-5.3-codex-spark": "compatibility",
});

const EVALUATED_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"]);

export interface PromptProfileSelection {
  providerId?: string;
  modelId: string;
  configuredProfile?: PromptProfile;
  overrides?: Readonly<Record<string, PromptProfile>>;
}

/** Resolve current host configuration, not persisted profile evidence. */
export function resolvePromptProfile(
  args: PromptProfileSelection,
): Readonly<PromptProfileResolution> {
  const modelId = args.modelId.trim();
  const providerId = args.providerId?.trim() || undefined;
  const override = args.overrides?.[modelId];
  const configured = args.configuredProfile;
  const codex =
    providerId === "codex" ||
    providerId === "openai-codex" ||
    providerId === "openai";
  const automatic = codex ? CODEX_MODEL_PROMPT_PROFILES[modelId] : undefined;
  const profile = isPromptProfile(override)
    ? override
    : isPromptProfile(configured)
      ? configured
      : (automatic ?? "compatibility");
  const source = isPromptProfile(override)
    ? "exact-model-override"
    : isPromptProfile(configured)
      ? "configured-model"
      : automatic === "reasoning"
        ? EVALUATED_MODELS.has(modelId)
          ? "evaluated-model"
          : "automatic-model"
        : "compatibility-default";
  return Object.freeze({
    profile,
    source,
    policyRevision: PROMPT_PROFILE_POLICY_REVISION,
    ...(providerId ? { providerId } : {}),
    modelId,
  });
}
