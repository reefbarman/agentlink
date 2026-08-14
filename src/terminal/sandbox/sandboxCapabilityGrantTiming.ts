import type { SandboxCapabilityLaunchFailure } from "../../core/capabilities/SandboxCapabilityLaunchError.js";

export type SandboxCapabilityGrantTiming = "preparation" | "launch";

export type SandboxCapabilityKind =
  | "public_network"
  | "local_binding"
  | "public_network_and_local_binding";

export type SandboxCapabilityPreparationAgeBucket =
  | "lt_1s"
  | "1s_to_10s"
  | "10s_to_30s"
  | "gte_30s";

export interface SandboxCapabilityGrantTimingEvent {
  type: "activated" | "activation_failed" | "revoked";
  timing: SandboxCapabilityGrantTiming;
  capability: SandboxCapabilityKind;
  preparationAgeBucket: SandboxCapabilityPreparationAgeBucket;
  exceededLegacyTtl: boolean;
  reason?: SandboxCapabilityLaunchFailure;
}

export interface ResolvedSandboxCapabilityGrantTiming {
  timing: SandboxCapabilityGrantTiming;
  invalidValue?: string;
}

export function resolveSandboxCapabilityGrantTiming(
  value: string | undefined,
): ResolvedSandboxCapabilityGrantTiming {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "launch") return { timing: "launch" };
  if (normalized === "preparation") return { timing: "preparation" };
  return { timing: "launch", invalidValue: value };
}

export function sandboxCapabilityPreparationAgeBucket(
  ageMs: number,
): SandboxCapabilityPreparationAgeBucket {
  if (ageMs < 1_000) return "lt_1s";
  if (ageMs < 10_000) return "1s_to_10s";
  if (ageMs < 30_000) return "10s_to_30s";
  return "gte_30s";
}

export function sandboxCapabilityKind(input: {
  publicNetwork: boolean;
  localBinding: boolean;
}): SandboxCapabilityKind {
  if (input.publicNetwork && input.localBinding) {
    return "public_network_and_local_binding";
  }
  return input.publicNetwork ? "public_network" : "local_binding";
}
