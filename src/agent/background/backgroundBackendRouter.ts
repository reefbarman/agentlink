import type {
  AcpBackgroundAgentConfig,
  BackgroundAgentSettings,
} from "./acpAgentConfig.js";
import {
  NATIVE_BACKGROUND_AGENT,
  isAcpBackgroundAgentReference,
  isModelBackgroundTargetReference,
  parseBackgroundReviewTarget,
  resolveAcpBackgroundAgent,
} from "./acpAgentConfig.js";

import type { CoreReasoningEffort } from "@agentlink/protocol/model-catalog";
import type { SpawnBackgroundRequest } from "../backgroundTypes.js";
import { isReviewTaskClass } from "./reviewTaskClass.js";

export type BackgroundBackendRoute =
  | {
      backend: "native";
      fallback?: {
        reason: "unavailable_reference" | "images_unsupported";
        reference: string;
      };
      /**
       * Local model ID pinned by agentlink.background.reviewTarget. The spawn
       * path resolves and validates it before applying it as an implicit model
       * override, so a settings-pinned reviewer stays distinguishable from a
       * caller-supplied explicit model.
       */
      configuredReviewModel?: string;
      /** Reasoning effort pinned alongside the configured review target. */
      configuredReviewEffort?: CoreReasoningEffort;
    }
  | {
      backend: "acp";
      reference: string;
      agent: AcpBackgroundAgentConfig;
      reason: "explicit_provider" | "review_agent" | "default_agent";
    };

export function resolveBackgroundBackendRoute(
  settings: BackgroundAgentSettings,
  request: Pick<
    SpawnBackgroundRequest,
    "images" | "model" | "provider" | "taskClass"
  >,
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
  if (isModelBackgroundTargetReference(requestedProvider)) {
    throw new Error(
      `Background provider "${requestedProvider}" is not a provider reference. Use provider for a provider ID or acp:<agent-id>, and model for a specific model.`,
    );
  }

  // Any explicit native provider or model is authoritative and bypasses
  // configured ACP preferences, including the review-only preference.
  if (requestedProvider || request.model?.trim()) {
    return { backend: "native" };
  }

  if (isReviewTaskClass(request.taskClass)) {
    const target = parseBackgroundReviewTarget(
      settings,
      context.foregroundProvider,
    );
    if (target.kind === "invalid") {
      throw new Error(
        target.reason
          ? `Invalid agentlink.background.reviewTarget entry "${target.value}". ${target.reason}`
          : `Unsupported agentlink.background.reviewTarget "${target.value}". Use "native:auto", "acp:<agent-id>", or "model:<model-id>".`,
      );
    }
    if (target.kind === "model") {
      return {
        backend: "native",
        configuredReviewModel: target.modelId,
        ...(target.effort ? { configuredReviewEffort: target.effort } : {}),
      };
    }
    if (target.kind === "native" && target.effort) {
      return { backend: "native", configuredReviewEffort: target.effort };
    }
    if (target.kind === "acp") {
      const reviewAgent = resolveAcpBackgroundAgent(settings, target.reference);
      if (!reviewAgent.provider) {
        throw new Error(
          `ACP review agent "${reviewAgent.id}" requires a provider so adversarial routing can avoid same-provider reviews.`,
        );
      }
      // Preserve adversarial review routing. A provider-tagged ACP reviewer only
      // replaces the opposite-provider lane; same-provider foreground work falls
      // through to AgentLink's native cross-provider model router.
      if (context.foregroundProvider?.toLowerCase() === reviewAgent.provider) {
        return { backend: "native" };
      }
      if (context.unavailableReferences?.has(target.reference)) {
        return {
          backend: "native",
          fallback: {
            reason: "unavailable_reference",
            reference: target.reference,
          },
        };
      }
      if (request.images?.length) {
        return {
          backend: "native",
          fallback: {
            reason: "images_unsupported",
            reference: target.reference,
          },
        };
      }
      return {
        backend: "acp",
        reference: target.reference,
        agent: reviewAgent,
        reason: "review_agent",
      };
    }
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
    const defaultAgent = resolveAcpBackgroundAgent(
      settings,
      settings.defaultAgent,
    );
    if (request.images?.length) {
      return {
        backend: "native",
        fallback: {
          reason: "images_unsupported",
          reference: settings.defaultAgent,
        },
      };
    }
    return {
      backend: "acp",
      reference: settings.defaultAgent,
      agent: defaultAgent,
      reason: "default_agent",
    };
  }

  return { backend: "native" };
}
