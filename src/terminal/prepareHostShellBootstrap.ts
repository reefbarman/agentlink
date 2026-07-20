import type { CustomTerminalHost } from "./customTerminalSupport.js";
import {
  planHostShellBootstrap,
  type HostShellBootstrapInput,
  type HostShellBootstrapPlan,
} from "./hostShellBootstrap.js";
import { decideHostShellLaunch } from "./hostShellLaunchPolicy.js";
import {
  adaptVscodeTerminalConfiguration,
  type AdaptedVscodeTerminalConfiguration,
  type VscodeTerminalConfigurationSnapshot,
} from "./vscodeTerminalProfileAdapter.js";

export interface PrepareHostShellBootstrapInput {
  configuration: VscodeTerminalConfigurationSnapshot;
  host: CustomTerminalHost;
  runtimeRoot: string;
  artifactId: string;
  nonce: string;
  originalZdotdir?: string;
}

export interface PreparedHostShellBootstrap {
  configuration: AdaptedVscodeTerminalConfiguration;
  plan: HostShellBootstrapPlan;
}

export function prepareHostShellBootstrap(
  input: PrepareHostShellBootstrapInput,
): PreparedHostShellBootstrap {
  const configuration = adaptVscodeTerminalConfiguration(input.configuration);
  if (configuration.nativeFallbackReason) {
    return {
      configuration,
      plan: {
        mode: "native-fallback",
        reason: "terminal-configuration-unsafe",
        message: configuration.nativeFallbackReason,
        profile: configuration.profile,
      },
    };
  }

  const decision = decideHostShellLaunch({
    host: input.host,
    profile: configuration.profile,
  });
  const bootstrapInput: HostShellBootstrapInput = {
    decision,
    runtimeRoot: input.runtimeRoot,
    artifactId: input.artifactId,
    nonce: input.nonce,
    homeDirectory: input.configuration.homeDirectory,
    ...(input.originalZdotdir
      ? { originalZdotdir: input.originalZdotdir }
      : {}),
  };
  return {
    configuration,
    plan: planHostShellBootstrap(bootstrapInput),
  };
}
