import type { CustomTerminalHost } from "./customTerminalSupport.js";
import type { ResolvedHostShellProfile } from "./shellProfileResolver.js";
import type { ShellIntegrationKind } from "./shellIntegration.js";
import { isCustomTerminalSupported } from "./customTerminalSupport.js";
import path from "node:path";

const RAW_COMPATIBLE_SHELLS = new Set(["sh", "dash", "ksh", "mksh"]);
const NATIVE_FALLBACK_SHELLS = new Set([
  "fish",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);

export type HostShellLaunchReason =
  | "host-unsupported"
  | "shell-integration-supported"
  | "raw-shell-compatible"
  | "native-shell-required"
  | "shell-unsupported";

export interface HostShellLaunchPolicyInput {
  readonly host: CustomTerminalHost;
  readonly profile: ResolvedHostShellProfile;
}

export type HostShellLaunchDecision =
  | {
      readonly mode: "custom-integrated";
      readonly reason: "shell-integration-supported";
      readonly message: string;
      readonly executable: string;
      readonly integrationKind: ShellIntegrationKind;
      readonly profile: ResolvedHostShellProfile;
    }
  | {
      readonly mode: "custom-raw";
      readonly reason: "raw-shell-compatible";
      readonly message: string;
      readonly executable: string;
      readonly profile: ResolvedHostShellProfile;
    }
  | {
      readonly mode: "native-fallback";
      readonly reason: Exclude<
        HostShellLaunchReason,
        "shell-integration-supported" | "raw-shell-compatible"
      >;
      readonly message: string;
      readonly executable: string;
      readonly profile: ResolvedHostShellProfile;
    };

function shellExecutable(shellPath: string): string {
  const normalizedPath = shellPath.replaceAll("\\", "/");
  if (normalizedPath.endsWith("/")) return "";
  return path.posix.basename(normalizedPath);
}

export function decideHostShellLaunch(
  input: HostShellLaunchPolicyInput,
): HostShellLaunchDecision {
  const executable = shellExecutable(input.profile.shellPath);
  // Hook and raw-mode allowlists are case-sensitive because a differently cased
  // executable may be a distinct binary. Native-fallback aliases are matched
  // case-insensitively because either classification still selects the safer path.
  const normalizedExecutable = executable.toLowerCase();
  if (!isCustomTerminalSupported(input.host)) {
    return {
      mode: "native-fallback",
      reason: "host-unsupported",
      message:
        "The custom terminal is unavailable on this extension host; use the native VS Code terminal.",
      executable,
      profile: input.profile,
    };
  }

  if (executable === "bash" || executable === "zsh") {
    return {
      mode: "custom-integrated",
      reason: "shell-integration-supported",
      message: `Use the custom terminal with ${executable} shell integration.`,
      executable,
      integrationKind: executable,
      profile: input.profile,
    };
  }

  if (RAW_COMPATIBLE_SHELLS.has(executable)) {
    return {
      mode: "custom-raw",
      reason: "raw-shell-compatible",
      message: `Use the custom terminal with ${executable} in raw degraded mode.`,
      executable,
      profile: input.profile,
    };
  }

  if (NATIVE_FALLBACK_SHELLS.has(normalizedExecutable)) {
    return {
      mode: "native-fallback",
      reason: "native-shell-required",
      message: `${executable} requires the native VS Code terminal in this release.`,
      executable,
      profile: input.profile,
    };
  }

  return {
    mode: "native-fallback",
    reason: "shell-unsupported",
    message: `Shell executable "${executable || input.profile.shellPath}" is not supported by the custom terminal; use the native VS Code terminal.`,
    executable,
    profile: input.profile,
  };
}
