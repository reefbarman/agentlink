import path from "node:path";

import {
  CURRENT_SANDBOX_POLICY_VERSION,
  validateCheckpointBSandboxCapabilityRequest,
  type SandboxLaunchAuthorization,
} from "../../core/sandboxPolicy.js";
import type { TerminalDimensions } from "../../core/terminalProtocol.js";
import {
  isSandboxHelperControlFrame,
  SANDBOX_HELPER_PROTOCOL_VERSION,
  type SandboxCommandIdentity,
  type SandboxHelperLaunchRequest,
} from "./sandboxHelperProtocol.js";

const FORBIDDEN_ENVIRONMENT_NAMES = new Set([
  "ALL_PROXY",
  "all_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_OPTIONS",
  "SSH_AUTH_SOCK",
  "GIT_ASKPASS",
  "VSCODE_IPC_HOOK",
  "VSCODE_IPC_HOOK_CLI",
]);
const FORBIDDEN_ENVIRONMENT_PREFIXES = ["DYLD_", "LD_"];

export interface SandboxPolicyCompileRequest extends SandboxCommandIdentity {
  command: string;
  cwd: string;
  shell: string;
  dimensions: TerminalDimensions;
  authorization: SandboxLaunchAuthorization;
}

function canonicalAbsolutePath(value: string, label: string): string {
  if (!value || value.includes("\0") || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path without NUL`);
  }
  return path.normalize(value);
}

function canonicalRoots(values: readonly string[], label: string): string[] {
  return [
    ...new Set(values.map((value) => canonicalAbsolutePath(value, label))),
  ].sort((left, right) => left.localeCompare(right));
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function validateEnvironment(
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(values).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(
        `Sandbox environment contains invalid variable name: ${name}`,
      );
    }
    if (
      FORBIDDEN_ENVIRONMENT_NAMES.has(name) ||
      FORBIDDEN_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      throw new Error(
        `Sandbox environment contains forbidden variable: ${name}`,
      );
    }
    if (typeof value !== "string" || value.includes("\0")) {
      throw new Error(`Sandbox environment contains invalid value for ${name}`);
    }
    environment[name] = value;
  }
  for (const name of ["HOME", "TMPDIR"] as const) {
    environment[name] = canonicalAbsolutePath(
      environment[name],
      `Sandbox environment ${name}`,
    );
  }
  if (environment.XDG_CACHE_HOME !== undefined) {
    environment.XDG_CACHE_HOME = canonicalAbsolutePath(
      environment.XDG_CACHE_HOME,
      "Sandbox environment XDG_CACHE_HOME",
    );
  }
  return environment;
}

export function compileSandboxHelperLaunchRequest(
  request: SandboxPolicyCompileRequest,
): SandboxHelperLaunchRequest {
  const { policy } = request.authorization;
  if (policy.version !== CURRENT_SANDBOX_POLICY_VERSION) {
    throw new Error(
      `Unsupported sandbox policy version: ${policy.version || "missing"}`,
    );
  }
  if (!policy.profileId.trim()) {
    throw new Error("Sandbox policy profileId must be non-empty");
  }
  if (policy.environment.inheritHost !== false) {
    throw new Error("Sandbox policy must not inherit the host environment");
  }
  if (policy.allowedUnixSockets.length > 0) {
    throw new Error("Checkpoint B does not allow sandbox Unix sockets");
  }
  if (policy.network.mode === "domain-proxy") {
    throw new Error(
      "Checkpoint B does not support domain-specific network grants",
    );
  }
  if (
    policy.network.mode === "public-proxy" &&
    policy.network.allowedPrivateTargets?.length
  ) {
    throw new Error("Checkpoint B does not allow private network targets");
  }

  const capability = validateCheckpointBSandboxCapabilityRequest(
    request.authorization.capabilityRequest,
  );
  if (!capability.ok) {
    throw new Error(
      `Unsupported sandbox capabilities: ${capability.fields.join(", ")}`,
    );
  }
  const networkIsPublic = policy.network.mode === "public-proxy";
  if (capability.publicNetwork !== networkIsPublic) {
    throw new Error(
      "Sandbox public-network capability does not match the compiled network policy",
    );
  }
  if (networkIsPublic) {
    if (!request.authorization.grant) {
      throw new Error(
        "Public-network sandbox policy requires an approved grant",
      );
    }
    if (
      request.authorization.grant.bindingDigest !==
        request.authorization.bindingDigest ||
      request.authorization.grant.policyVersion !== policy.version
    ) {
      throw new Error("Sandbox grant does not match the launch authorization");
    }
    if (request.authorization.grant.consumedAt === undefined) {
      throw new Error(
        "Public-network sandbox grant must be atomically consumed before launch",
      );
    }
  } else if (request.authorization.grant) {
    throw new Error("Blocked-network sandbox policy must not carry a grant");
  }

  const readableRoots = canonicalRoots(
    policy.readableRoots,
    "Sandbox readable root",
  );
  const writableRoots = canonicalRoots(
    policy.writableRoots,
    "Sandbox writable root",
  );
  const deniedRoots = canonicalRoots(policy.deniedRoots, "Sandbox denied root");
  const deniedWriteRoots = canonicalRoots(
    policy.deniedWriteRoots ?? policy.protectedReadOnlyRoots,
    "Sandbox denied-write root",
  );
  const protectedRoots = canonicalRoots(
    policy.protectedReadOnlyRoots,
    "Sandbox protected root",
  );
  const structurallyProtectedRoots = canonicalRoots(
    policy.structurallyProtectedRoots ?? [],
    "Sandbox structurally protected root",
  );
  for (const [label, roots] of [
    ["protected", protectedRoots],
    ["structurally protected", structurallyProtectedRoots],
  ] as const) {
    for (const protectedRoot of roots) {
      if (!readableRoots.some((root) => isWithin(protectedRoot, root))) {
        throw new Error(
          `Sandbox ${label} root is not covered by readable roots: ${protectedRoot}`,
        );
      }
      if (!deniedWriteRoots.some((root) => isWithin(protectedRoot, root))) {
        throw new Error(
          `Sandbox ${label} root is not covered by denied-write roots: ${protectedRoot}`,
        );
      }
    }
  }

  const environment = validateEnvironment(policy.environment.values);
  if (!readableRoots.some((root) => isWithin(environment.HOME, root))) {
    throw new Error("Sandbox environment HOME must be within a readable root");
  }
  for (const name of ["TMPDIR", "XDG_CACHE_HOME"] as const) {
    const value = environment[name];
    if (
      value !== undefined &&
      !writableRoots.some((root) => isWithin(value, root))
    ) {
      throw new Error(
        `Sandbox environment ${name} must be within a writable root`,
      );
    }
  }

  const cwd = canonicalAbsolutePath(request.cwd, "Sandbox cwd");
  if (!readableRoots.some((root) => isWithin(cwd, root))) {
    throw new Error("Sandbox cwd must be within a readable root");
  }
  const shell = canonicalAbsolutePath(request.shell, "Sandbox shell");

  const launch: SandboxHelperLaunchRequest = {
    version: SANDBOX_HELPER_PROTOCOL_VERSION,
    type: "launch",
    channelId: request.channelId,
    commandId: request.commandId,
    generation: request.generation,
    command: request.command,
    cwd,
    shell,
    environment,
    filesystem: {
      denyRead: deniedRoots,
      allowRead: readableRoots,
      allowWrite: writableRoots,
      denyWrite: deniedWriteRoots,
    },
    network: networkIsPublic ? { mode: "public-proxy" } : { mode: "blocked" },
    protectedRoots,
    structurallyProtectedRoots,
    dimensions: request.dimensions,
  };
  if (!isSandboxHelperControlFrame(launch)) {
    throw new Error("Compiled sandbox helper launch request is invalid");
  }
  return launch;
}
