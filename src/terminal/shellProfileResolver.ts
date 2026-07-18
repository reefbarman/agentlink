export interface HostShellProfileConfiguration {
  path?: string | string[];
  args?: string | string[];
  env?: Record<string, string | null>;
  source?: string;
  overrideName?: boolean;
}

export interface HostShellProfileResolutionInput {
  platform: NodeJS.Platform;
  defaultProfileName?: string | null;
  profiles?: Record<string, HostShellProfileConfiguration | null>;
  platformEnvironment?: Record<string, string | null>;
  baseEnvironment: Record<string, string | undefined>;
  fallbackShellPath: string;
  fallbackShellArgs?: string[];
  cwd: string;
}

export interface ResolvedHostShellProfile {
  profileName: string;
  provenance: "configured" | "fallback";
  shellPath: string;
  shellArgs: string[];
  environment: Record<string, string>;
  cwd: string;
  warning?: string;
}

function firstConcretePath(
  value: string | string[] | undefined,
): string | undefined {
  const candidates = Array.isArray(value) ? value : value ? [value] : [];
  const candidate = candidates.find((entry) => entry.trim().length > 0);
  return candidate?.trim();
}

function normalizeArgs(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return [...value];
  return value === undefined ? [] : [value];
}

function mergeEnvironment(
  ...layers: Array<Record<string, string | null | undefined> | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer ?? {})) {
      if (value === null || value === undefined) {
        delete result[name];
      } else {
        result[name] = value;
      }
    }
  }
  return result;
}

export function resolveHostShellProfile(
  input: HostShellProfileResolutionInput,
): ResolvedHostShellProfile {
  const selectedName = input.defaultProfileName?.trim();
  const selectedProfile = selectedName
    ? input.profiles?.[selectedName]
    : undefined;
  const configuredPath = firstConcretePath(selectedProfile?.path);
  const environment = mergeEnvironment(
    input.baseEnvironment,
    input.platformEnvironment,
    configuredPath ? selectedProfile?.env : undefined,
  );

  if (selectedName && selectedProfile && configuredPath) {
    return {
      profileName: selectedName,
      provenance: "configured",
      shellPath: configuredPath,
      shellArgs: normalizeArgs(selectedProfile.args),
      environment,
      cwd: input.cwd,
    };
  }

  let warning: string | undefined;
  if (selectedName && !selectedProfile) {
    warning = `Configured terminal profile "${selectedName}" is unavailable; using the extension-host shell.`;
  } else if (selectedName && selectedProfile?.source && !configuredPath) {
    warning = `Terminal profile "${selectedName}" is contributed by "${selectedProfile.source}" without a resolvable executable path; using the extension-host shell.`;
  } else if (selectedName && selectedProfile && !configuredPath) {
    warning = `Terminal profile "${selectedName}" has no executable path; using the extension-host shell.`;
  }

  return {
    profileName: selectedName || "Extension Host Shell",
    provenance: "fallback",
    shellPath: input.fallbackShellPath,
    shellArgs: [...(input.fallbackShellArgs ?? [])],
    environment,
    cwd: input.cwd,
    ...(warning ? { warning } : {}),
  };
}
