import {
  PROMPT_PROFILE_POLICY_REVISION,
  isPromptProfile,
  type PromptProfile,
  type PromptProfileResolution,
} from "@agentlink/protocol/prompt-profile";

interface EvaluatedPromptModel {
  providerId: string;
  modelId: string;
}

// Frontier cohort promoted to the compact reasoning profile (2026-08): these
// models self-manage process reliably and do not need the verbose
// compatibility scaffolding, which measurably slowed time-to-first-value.
// Behavioral impact is tracked with `npm run telemetry:sessions` and
// `npm run telemetry:tools -- --compare` across the rollout versions.
// Transport reasoning support alone is still not evidence that a compact
// prompt is safe — keep small/cheap tiers (Luna, Spark) on compatibility until
// they earn promotion.
const EVALUATED_REASONING_PROMPT_MODELS: readonly EvaluatedPromptModel[] = [
  { providerId: "codex", modelId: "gpt-5.6-sol" },
  { providerId: "codex", modelId: "gpt-5.6-terra" },
  { providerId: "codex", modelId: "gpt-5.5" },
];

/** Core-owned rollout policy that resolves protocol evidence for one model. */
export function resolvePromptProfile(args: {
  providerId?: string;
  modelId: string;
  overrides?: Readonly<Record<string, PromptProfile>>;
}): PromptProfileResolution {
  const modelId = args.modelId.trim();
  const providerId = args.providerId?.trim() || undefined;
  const override = args.overrides?.[modelId];
  if (isPromptProfile(override)) {
    return Object.freeze({
      profile: override,
      source: "exact-model-override",
      policyRevision: PROMPT_PROFILE_POLICY_REVISION,
      ...(providerId ? { providerId } : {}),
      modelId,
    });
  }

  const evaluated = EVALUATED_REASONING_PROMPT_MODELS.some(
    (candidate) =>
      candidate.providerId === providerId && candidate.modelId === modelId,
  );
  return Object.freeze({
    profile: evaluated ? "reasoning" : "compatibility",
    source: evaluated ? "evaluated-model" : "compatibility-default",
    policyRevision: PROMPT_PROFILE_POLICY_REVISION,
    ...(providerId ? { providerId } : {}),
    modelId,
  });
}
