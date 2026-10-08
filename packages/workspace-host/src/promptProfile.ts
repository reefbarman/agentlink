import type { CoreResolvedModel } from "@agentlink/core";
import { resolvePromptProfile } from "@agentlink/core/prompt-profile";

export function composeWorkspacePromptProfile(
  model: CoreResolvedModel,
): string {
  const resolution = resolvePromptProfile({
    providerId: model.reference.providerId,
    modelId: model.reference.modelId,
    configuredProfile: model.provider.getPromptProfile?.(model.modelId),
  });
  return resolution.profile === "reasoning"
    ? "Clarify real ambiguity; otherwise act on the goal, make focused changes, validate proportionally, and report the result and any gaps."
    : "Confirm the goal when requirements are unclear. Inspect relevant project context, make focused changes, and validate them with available checks. Report what changed, what was verified, and anything still blocked.";
}
