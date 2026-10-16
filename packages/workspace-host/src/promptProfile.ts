import type { CoreResolvedModel } from "@agentlink/core";
import { resolvePromptProfile } from "@agentlink/core/prompt-profile";

const DEFAULT_WORKSPACE_IDENTITY =
  "You are AgentLink's standalone local coding assistant.";
const MAX_IDENTITY_ROLE_LENGTH = 200;

/**
 * Host-configured assistant identity. When supplied, the system prompt starts
 * with `You are AgentLink, <role>.`, the leading identity recognised by the
 * Meridian companion plugin. The role is owner configuration, not model input.
 */
export interface WorkspacePromptIdentity {
  readonly role: string;
}

export function validateWorkspacePromptIdentity(
  identity: WorkspacePromptIdentity,
): string {
  if (typeof identity?.role !== "string") {
    throw new Error("Workspace prompt identity role must be a string");
  }
  const role = identity.role.trim().replace(/\.+$/u, "").trimEnd();
  if (!role) {
    throw new Error("Workspace prompt identity role must not be empty");
  }
  if (/[\r\n\u2028\u2029]/u.test(role)) {
    throw new Error("Workspace prompt identity role must be a single line");
  }
  if (role.length > MAX_IDENTITY_ROLE_LENGTH) {
    throw new Error(
      `Workspace prompt identity role must be at most ${MAX_IDENTITY_ROLE_LENGTH} characters`,
    );
  }
  return role;
}

export function composeWorkspaceIdentity(
  identity?: WorkspacePromptIdentity,
): string {
  if (!identity) return DEFAULT_WORKSPACE_IDENTITY;
  return `You are AgentLink, ${validateWorkspacePromptIdentity(identity)}.`;
}

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
