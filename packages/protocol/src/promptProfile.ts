export const PROMPT_PROFILES = ["compatibility", "reasoning"] as const;

export type PromptProfile = (typeof PROMPT_PROFILES)[number];

export const PROMPT_PROFILE_POLICY_REVISION = "prompt-profile-policy-v1";

export type PromptProfileResolutionSource =
  | "exact-model-override"
  | "evaluated-model"
  | "compatibility-default";

/** Serializable evidence describing the prompt profile selected for one model. */
export interface PromptProfileResolution {
  profile: PromptProfile;
  source: PromptProfileResolutionSource;
  policyRevision: typeof PROMPT_PROFILE_POLICY_REVISION;
  providerId?: string;
  modelId: string;
}

export function isPromptProfile(value: unknown): value is PromptProfile {
  return (
    typeof value === "string" &&
    (PROMPT_PROFILES as readonly string[]).includes(value)
  );
}

export function isCurrentPromptProfileResolution(
  value: unknown,
): value is PromptProfileResolution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PromptProfileResolution>;
  const coherentProfileSource =
    candidate.source === "exact-model-override" ||
    (candidate.source === "evaluated-model" &&
      candidate.profile === "reasoning") ||
    (candidate.source === "compatibility-default" &&
      candidate.profile === "compatibility");
  return Boolean(
    isPromptProfile(candidate.profile) &&
    coherentProfileSource &&
    candidate.policyRevision === PROMPT_PROFILE_POLICY_REVISION &&
    typeof candidate.modelId === "string" &&
    candidate.modelId.trim().length > 0 &&
    (candidate.providerId === undefined ||
      (typeof candidate.providerId === "string" &&
        candidate.providerId.trim().length > 0)),
  );
}

export function promptProfileResolutionsEqual(
  left: unknown,
  right: PromptProfileResolution,
): left is PromptProfileResolution {
  return (
    isCurrentPromptProfileResolution(left) &&
    left.profile === right.profile &&
    left.source === right.source &&
    left.policyRevision === right.policyRevision &&
    left.providerId === right.providerId &&
    left.modelId === right.modelId
  );
}

export function normalizePromptProfileOverrides(
  value: unknown,
): Readonly<Record<string, PromptProfile>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({});
  }

  const entries = Object.entries(value).filter(
    (entry): entry is [string, PromptProfile] =>
      entry[0].trim().length > 0 && isPromptProfile(entry[1]),
  );
  return Object.freeze(
    Object.fromEntries(
      entries.map(([modelId, profile]) => [modelId.trim(), profile]),
    ),
  );
}
