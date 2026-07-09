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
  | { backend: "native" }
  | {
      backend: "acp";
      reference: string;
      agent: AcpBackgroundAgentConfig;
      reason: "explicit_provider" | "default_agent";
    };

export function resolveBackgroundBackendRoute(
  settings: BackgroundAgentSettings,
  request: Pick<SpawnBackgroundRequest, "provider">,
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

  if (settings.defaultAgent === NATIVE_BACKGROUND_AGENT) {
    return { backend: "native" };
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
