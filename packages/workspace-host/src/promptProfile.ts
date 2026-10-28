import {
  buildBasePrompt,
  buildSessionHistoryRecallGuidance,
  deriveSystemPromptCapabilities,
} from "@agentlink/core/system-prompt";

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

export function resolveWorkspacePromptProfile(model: CoreResolvedModel) {
  return resolvePromptProfile({
    providerId: model.reference.providerId,
    modelId: model.reference.modelId,
    configuredProfile: model.provider.getPromptProfile?.(model.modelId),
  }).profile;
}

const SHARED_COMPATIBILITY_IDENTITY =
  "You are AgentLink, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices. You work in the user's local project through AgentLink's standalone workspace host.";
const SHARED_REASONING_IDENTITY =
  "You are AgentLink, a software engineering agent working in the user's local project through AgentLink's standalone workspace host.";

/**
 * VS Code's shared guidance for the tools this session registers, led by the
 * identity line. Mode and provider sections are not included yet: they name
 * VS Code-only tools (`switch_mode`, `get_repo_map`, terminal reuse).
 */
export function composeSharedWorkspaceGuidance(options: {
  readonly model: CoreResolvedModel;
  readonly projectRoot: string;
  readonly toolNames: Iterable<string>;
  readonly identity?: WorkspacePromptIdentity;
}): string {
  const profile = resolveWorkspacePromptProfile(options.model);
  const capabilities = {
    ...deriveSystemPromptCapabilities(options.toolNames),
    // workspace-host's background tools do not take VS Code's taskClass,
    // ownedPaths or image handoff yet (parity gap 7); the host describes
    // its own delegation rules instead.
    backgroundAgents: false,
  };
  const identity = options.identity
    ? composeWorkspaceIdentity(options.identity)
    : profile === "reasoning"
      ? SHARED_REASONING_IDENTITY
      : SHARED_COMPATIBILITY_IDENTITY;
  return [
    buildBasePrompt(profile, {
      identity,
      cwd: options.projectRoot,
      capabilities,
    }),
    buildSessionHistoryRecallGuidance(capabilities),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function composeWorkspacePromptProfile(
  model: CoreResolvedModel,
): string {
  return resolveWorkspacePromptProfile(model) === "reasoning"
    ? "Clarify real ambiguity; otherwise act on the goal, make focused changes, validate proportionally, and report the result and any gaps."
    : "Confirm the goal when requirements are unclear. Inspect relevant project context, make focused changes, and validate them with available checks. Report what changed, what was verified, and anything still blocked.";
}
