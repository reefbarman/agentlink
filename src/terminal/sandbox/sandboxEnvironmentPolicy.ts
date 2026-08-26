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

export type SandboxEnvironmentProvenance =
  | "host-inherited"
  | "policy-set"
  | "agent-reserved"
  | "per-command";

export interface SandboxEnvironmentBudgetEntry {
  name: string;
  bytes: number;
}

export interface SandboxEnvironmentBudgetResult {
  environment: Record<string, string>;
  estimatedBytes: number;
  protectedBytes: number;
  dropped: SandboxEnvironmentBudgetEntry[];
}

export const SANDBOX_AUTHORIZER_EXEC_BUDGET_BYTES = 768 * 1024;
const EXEC_POINTER_BYTES = 8;

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
  provenance: Record<string, SandboxEnvironmentProvenance>;
  policy: ResolvedSandboxShellEnvironmentPolicy;
} {
  const policy = resolveSandboxShellEnvironmentPolicy(value);
  const coreNames =
    platform === "win32"
      ? WINDOWS_CORE_ENVIRONMENT_NAMES
      : UNIX_CORE_ENVIRONMENT_NAMES;
  const environment: Record<string, string> = {};
  const provenance: Record<string, SandboxEnvironmentProvenance> = {};

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
      provenance[name] = "host-inherited";
    }
  }

  const remove = (name: string) => {
    delete environment[name];
    delete provenance[name];
  };
  if (!policy.ignoreDefaultExcludes) {
    for (const name of Object.keys(environment)) {
      if (matchesAny(name, DEFAULT_EXCLUDES)) remove(name);
    }
  }
  for (const name of Object.keys(environment)) {
    if (matchesAny(name, policy.exclude)) remove(name);
  }
  for (const [name, entry] of Object.entries(policy.set)) {
    environment[name] = entry;
    provenance[name] = "policy-set";
  }
  if (policy.includeOnly.length > 0) {
    for (const name of Object.keys(environment)) {
      if (!matchesAny(name, policy.includeOnly)) remove(name);
    }
  }

  return { environment, provenance, policy };
}

function environmentEntryBytes(name: string, value: string): number {
  return Buffer.byteLength(`${name}=${value}`, "utf8") + 1;
}

export function budgetSandboxEnvironment(
  environment: Readonly<Record<string, string>>,
  provenance: Readonly<Record<string, SandboxEnvironmentProvenance>>,
  command: string,
  limitBytes = SANDBOX_AUTHORIZER_EXEC_BUDGET_BYTES,
): SandboxEnvironmentBudgetResult {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
    throw new Error("Sandbox environment budget must be a positive integer");
  }
  const entries = Object.entries(environment).map(([name, value]) => ({
    name,
    bytes: environmentEntryBytes(name, value),
    provenance: provenance[name],
  }));
  for (const entry of entries) {
    if (!entry.provenance) {
      throw new Error(
        `Sandbox environment provenance is missing for ${entry.name}`,
      );
    }
  }
  const commandBytes = Buffer.byteLength(command, "utf8") + 1;
  const commandCost = commandBytes + EXEC_POINTER_BYTES;
  const protectedEntries = entries.filter(
    (entry) => entry.provenance !== "host-inherited",
  );
  const protectedBytes =
    commandCost +
    protectedEntries.reduce(
      (total, entry) => total + entry.bytes + EXEC_POINTER_BYTES,
      0,
    );
  if (protectedBytes > limitBytes) {
    const contributors = [
      { name: "<command>", bytes: commandBytes },
      ...protectedEntries.map(({ name, bytes }) => ({ name, bytes })),
    ]
      .sort((left, right) =>
        right.bytes !== left.bytes
          ? right.bytes - left.bytes
          : left.name.localeCompare(right.name),
      )
      .slice(0, 8)
      .map(({ name, bytes }) => `${name} (${bytes} bytes)`)
      .join(", ");
    throw new Error(
      `Sandbox protected environment contributors exceed the ${limitBytes}-byte conservative launch budget (${protectedBytes} bytes): ${contributors}`,
    );
  }

  let estimatedBytes =
    commandCost +
    entries.reduce(
      (total, entry) => total + entry.bytes + EXEC_POINTER_BYTES,
      0,
    );
  const retained = { ...environment };
  const dropped: SandboxEnvironmentBudgetEntry[] = [];
  const candidates = entries
    .filter((entry) => entry.provenance === "host-inherited")
    .sort((left, right) =>
      right.bytes !== left.bytes
        ? right.bytes - left.bytes
        : left.name.localeCompare(right.name),
    );
  for (const entry of candidates) {
    if (estimatedBytes <= limitBytes) break;
    delete retained[entry.name];
    estimatedBytes -= entry.bytes + EXEC_POINTER_BYTES;
    dropped.push({ name: entry.name, bytes: entry.bytes });
  }
  if (estimatedBytes > limitBytes) {
    throw new Error(
      `Sandbox environment exceeds the ${limitBytes}-byte conservative launch budget after all host-inherited entries were removed`,
    );
  }
  return { environment: retained, estimatedBytes, protectedBytes, dropped };
}
