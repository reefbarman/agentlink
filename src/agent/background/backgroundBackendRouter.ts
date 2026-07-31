import type {
  AcpBackgroundAgentConfig,
  BackgroundAgentSettings,
} from "./acpAgentConfig.js";
import {
  NATIVE_BACKGROUND_AGENT,
  isAcpBackgroundAgentReference,
  resolveAcpBackgroundAgent,
} from "./acpAgentConfig.js";

import type { SpawnBackgroundRequest } from "../backgroundTypes.js";

export type BackgroundBackendRoute =
  | {
      backend: "native";
      fallback?: {
        reason: "unavailable_reference";
        reference: string;
      };
    }
  | {
      backend: "acp";
      reference: string;
      agent: AcpBackgroundAgentConfig;
      reason: "explicit_provider" | "review_agent" | "default_agent";
    };

export function resolveBackgroundBackendRoute(
  settings: BackgroundAgentSettings,
  request: Pick<SpawnBackgroundRequest, "model" | "provider" | "taskClass">,
  context: {
    foregroundProvider?: string;
    /**
     * ACP references (e.g. `acp:claude`) that recently failed to start.
     * Automatic routing skips them and falls back to the native backend;
     * an explicit provider override still wins.
     */
    unavailableReferences?: ReadonlySet<string>;
  } = {},
): BackgroundBackendRoute {
  const requestedProvider = request.provider?.trim();
  if (isAcpBackgroundAgentReference(requestedProvider)) {
    return {
      backend: "acp",
      reference: requestedProvider,
      agent: resolveAcpBackgroundAgent(settings, requestedProvider),
      reason: "explicit_provider",
    };
  }

  // Any explicit native provider or model is authoritative and bypasses
  // configured ACP preferences, including the review-only preference.
  if (requestedProvider || request.model?.trim()) {
    return { backend: "native" };
  }

  const taskClass = request.taskClass?.trim().toLowerCase();
  if (
    taskClass?.startsWith("review_") &&
    isAcpBackgroundAgentReference(settings.reviewAgent) &&
    context.unavailableReferences?.has(settings.reviewAgent)
  ) {
    return {
      backend: "native",
      fallback: {
        reason: "unavailable_reference",
        reference: settings.reviewAgent,
      },
    };
  }
  if (
    taskClass?.startsWith("review_") &&
    isAcpBackgroundAgentReference(settings.reviewAgent)
  ) {
    const reviewAgent = resolveAcpBackgroundAgent(
      settings,
      settings.reviewAgent,
    );
    if (!reviewAgent.provider) {
      throw new Error(
        `ACP review agent "${reviewAgent.id}" requires a provider so adversarial routing can avoid same-provider reviews.`,
      );
    }
    // Preserve adversarial review routing. A provider-tagged ACP reviewer only
    // replaces the opposite-provider lane; same-provider foreground work falls
    // through to AgentLink's native cross-provider model router.
    if (
      reviewAgent.provider &&
      context.foregroundProvider?.toLowerCase() === reviewAgent.provider
    ) {
      return { backend: "native" };
    }
    return {
      backend: "acp",
      reference: settings.reviewAgent,
      agent: reviewAgent,
      reason: "review_agent",
    };
  }

  if (settings.defaultAgent === NATIVE_BACKGROUND_AGENT) {
    return { backend: "native" };
  }

  if (
    isAcpBackgroundAgentReference(settings.defaultAgent) &&
    context.unavailableReferences?.has(settings.defaultAgent)
  ) {
    return {
      backend: "native",
      fallback: {
        reason: "unavailable_reference",
        reference: settings.defaultAgent,
      },
    };
  }

  if (isAcpBackgroundAgentReference(settings.defaultAgent)) {
    return {
      backend: "acp",
      reference: settings.defaultAgent,
      agent: resolveAcpBackgroundAgent(settings, settings.defaultAgent),
      reason: "default_agent",
    };
  }

  return { backend: "native" };
}
