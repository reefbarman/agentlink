import picomatch from "picomatch";

export type SandboxEnvironmentInheritance = "all" | "core" | "none";

export interface SandboxShellEnvironmentPolicy {
  inherit?: SandboxEnvironmentInheritance;
  ignoreDefaultExcludes?: boolean;
  exclude?: string[];
  set?: Record<string, string>;
  includeOnly?: string[];
  useProfile?: boolean;
}

export interface ResolvedSandboxShellEnvironmentPolicy {
  inherit: SandboxEnvironmentInheritance;
  ignoreDefaultExcludes: boolean;
  exclude: string[];
  set: Record<string, string>;
  includeOnly: string[];
  useProfile: boolean;
}

const DEFAULT_EXCLUDES = ["*KEY*", "*SECRET*", "*TOKEN*"] as const;
const UNIX_CORE_ENVIRONMENT_NAMES = new Set([
  "HOME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "USER",
]);
const WINDOWS_CORE_ENVIRONMENT_NAMES = new Set([
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "PATH",
  "PATHEXT",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

function validatedPatterns(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Sandbox environment ${label} must be an array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !entry || entry.includes("\0")) {
      throw new Error(
        `Sandbox environment ${label}[${index}] must be a non-empty pattern without NUL`,
      );
    }
    try {
      picomatch(entry, { nocase: true });
    } catch (error) {
      throw new Error(
        `Sandbox environment ${label}[${index}] is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return entry;
  });
}

export function resolveSandboxShellEnvironmentPolicy(
  value: SandboxShellEnvironmentPolicy | undefined,
): ResolvedSandboxShellEnvironmentPolicy {
  const inherit = value?.inherit ?? "all";
  if (inherit !== "all" && inherit !== "core" && inherit !== "none") {
    throw new Error(`Unsupported sandbox environment inheritance: ${inherit}`);
  }
  const set: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value?.set ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(
        `Sandbox environment set contains invalid variable: ${name}`,
      );
    }
    if (typeof entry !== "string" || entry.includes("\0")) {
      throw new Error(
        `Sandbox environment set contains invalid value for ${name}`,
      );
    }
    set[name] = entry;
  }
  return {
    inherit,
    ignoreDefaultExcludes: value?.ignoreDefaultExcludes ?? true,
    exclude: validatedPatterns(value?.exclude, "exclude"),
    set,
    includeOnly: validatedPatterns(value?.includeOnly, "includeOnly"),
    useProfile: value?.useProfile ?? false,
  };
}

function matchesAny(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    picomatch.isMatch(name, pattern, { nocase: true }),
  );
}

export function buildSandboxPolicyEnvironment(
  hostEnvironment: Readonly<Record<string, string | undefined>>,
  value?: SandboxShellEnvironmentPolicy,
  platform: NodeJS.Platform = process.platform,
): {
  environment: Record<string, string>;
  policy: ResolvedSandboxShellEnvironmentPolicy;
} {
  const policy = resolveSandboxShellEnvironmentPolicy(value);
  const coreNames =
    platform === "win32"
      ? WINDOWS_CORE_ENVIRONMENT_NAMES
      : UNIX_CORE_ENVIRONMENT_NAMES;
  const environment: Record<string, string> = {};

  if (policy.inherit !== "none") {
    for (const [name, entry] of Object.entries(hostEnvironment)) {
      if (
        entry === undefined ||
        entry.includes("\0") ||
        (policy.inherit === "core" && !coreNames.has(name.toUpperCase()))
      ) {
        continue;
      }
      environment[name] = entry;
    }
  }

  if (!policy.ignoreDefaultExcludes) {
    for (const name of Object.keys(environment)) {
      if (matchesAny(name, DEFAULT_EXCLUDES)) delete environment[name];
    }
  }
  for (const name of Object.keys(environment)) {
    if (matchesAny(name, policy.exclude)) delete environment[name];
  }
  Object.assign(environment, policy.set);
  if (policy.includeOnly.length > 0) {
    for (const name of Object.keys(environment)) {
      if (!matchesAny(name, policy.includeOnly)) delete environment[name];
    }
  }

  return { environment, policy };
}
