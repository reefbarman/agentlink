import { rmSync, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  describeIgnoredWorkspaceInstructionFile,
  resolveWorkspaceInstructionFile,
  WORKSPACE_INSTRUCTION_FILENAMES,
} from "@agentlink/node-host";
import type { SandboxExecutionMetadata } from "@agentlink/protocol/terminal-security";

import { createSandboxLaunchBindingDigest } from "./SandboxCapabilityAuthority.js";
import {
  budgetSandboxEnvironment,
  buildSandboxPolicyEnvironment,
  type SandboxEnvironmentProvenance,
  type SandboxShellEnvironmentPolicy,
} from "./sandboxEnvironmentPolicy.js";
import { resolveWorkspaceGitProtection } from "./gitMetadataProtection.js";
import {
  SandboxPreparationError,
  sandboxEnvironmentKeyDiagnostic,
  sandboxPreparationFailure,
  type SandboxPreparationPhase,
} from "./SandboxPreparationError.js";
import { SandboxStructuralProtectionError } from "./SandboxRuntimeProvider.js";
import {
  CURRENT_SANDBOX_POLICY_VERSION,
  type SandboxLaunchAuthorization,
  type SandboxLaunchBindingInput,
} from "./sandboxPolicy.js";

/**
 * Builds the workspace-write sandbox policy for one command: writable
 * workspace roots, protected Git and agent-policy metadata, a private
 * per-command HOME/TMP/cache, a budgeted private environment, and the launch
 * binding that capability grants are tied to. Hosts add grant activation and
 * helper launch on top (see `BaselineSandboxLaunchAuthorizer` in the VS Code
 * extension and `launchSandboxedProcess`).
 */

export const WORKSPACE_SANDBOX_PROFILE_ID = "workspace-write";
export const DEFAULT_SANDBOX_PRIVATE_DIRECTORY_PREFIX = "/tmp/al-sbx-";

const DEFAULT_PATH =
  "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const MACOS_TEMPORARY_ROOTS = ["/tmp", "/private/tmp"] as const;
// Linux has no /private alias; listing a missing path would only add a
// bind the backend cannot create.
const LINUX_TEMPORARY_ROOTS = ["/tmp"] as const;
const PROTECTED_WORKSPACE_ENTRIES = [
  ".agents",
  ".claude",
  ".codex",
  "AGENT.md",
  "AGENTS.md",
  "AGENTS.local.md",
  "CLAUDE.md",
] as const;
const PROTECTED_INSTRUCTION_FILENAMES = WORKSPACE_INSTRUCTION_FILENAMES;
const AGENTLINK_RUNTIME_ENTRIES = new Set([
  "history",
  "transcripts",
  "debug",
  "checkpoints",
  "tool-usage-report",
]);
const PROTECTED_POLICY_SUBTREE_RE = /^(?:commands|rules|skills)(?:-|$)/;
// Agent policy namespaces. Each is write-denied as a whole, so a symbolic link
// inside one whose canonical target is also inside one (in the same workspace
// root) cannot be redirected or have its target edited by a sandboxed command.
const POLICY_NAMESPACE_NAMES = [
  ".agentlink",
  ".agents",
  ".claude",
  ".codex",
] as const;

const MACOS_RUNTIME_COMPATIBILITY_WRITE_ROOTS = [
  "/tmp/claude",
  "/private/tmp/claude",
] as const;
const LINUX_RUNTIME_COMPATIBILITY_WRITE_ROOTS = ["/tmp/claude"] as const;
const RESERVED_ENVIRONMENT_NAMES = new Set([
  "HOME",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "CLAUDE_CODE_TMPDIR",
  "PATH",
  "TERM",
  "LANG",
  "LC_ALL",
  "DEVELOPER_DIR",
  "xcrun_db",
  "xcrun_nocache",
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
const RESERVED_ENVIRONMENT_PREFIXES = ["DYLD_", "LD_"];

export interface SandboxPrivateDirectories {
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
  readonly cache: string;
  cleanup(): void;
}

export interface PrepareWorkspaceSandboxLaunchOptions {
  /** Writable roots; `cwd` must be inside one of them. */
  readonly workspaceRoots: readonly string[];
  readonly cwd: string;
  readonly command: string;
  /** Owning agent session, bound into the launch digest. */
  readonly sessionId: string;
  readonly capability: {
    readonly publicNetwork: boolean;
    readonly localBinding: boolean;
  };
  /** Per-command environment overrides requested by the caller. */
  readonly explicitEnvironment?: Readonly<Record<string, string>>;
  /** Source for the shell environment policy. */
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
  /** Host-reserved non-interactive variables (pagers, prompts, markers). */
  readonly agentEnvironment: Readonly<Record<string, string>>;
  readonly environmentPolicy?: SandboxShellEnvironmentPolicy;
  readonly environmentBudgetBytes: number;
  readonly homeDirectory: string;
  /** Host per-user temporary directory. */
  readonly hostTemporaryDirectory: string;
  readonly privateDirectoryPrefix: string;
  /** Canonical runtime directories commands need; validated, not widened. */
  readonly trustedRuntimeRoots: readonly string[];
  /** Give the command a fresh private HOME instead of the host home. */
  readonly temporaryHome: boolean;
  /**
   * Make `/tmp`, `/private/tmp` and the host temporary directory writable and
   * point `TMPDIR` at the host directory, for development toolchains.
   * Defaults to true. When false, only the workspace roots and the private
   * per-command directories are writable, and `TMPDIR` is private.
   */
  readonly shareHostTemporaryDirectories?: boolean;
  /**
   * Roots hidden from sandbox reads, such as the user's home folder. When
   * set, only the workspace roots, the private per-command directories and
   * `trustedRuntimeRoots` stay readable inside them. Defaults to none, which
   * keeps the whole host readable.
   */
  readonly deniedReadRoots?: readonly string[];
  /**
   * Verify caller-staged inline files. Runs after the private directories
   * exist, so a failure still cleans them up. Defaults to no inline files.
   */
  readonly verifyInlineFiles?: () => Promise<
    SandboxLaunchBindingInput["inlineFiles"]
  >;
  /** Host platform; picks the reported backend. Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

/** The sandbox backend the packaged helper uses on `platform`. */
export function sandboxBackendFor(
  platform: NodeJS.Platform,
): "seatbelt" | "bubblewrap" {
  return platform === "linux" ? "bubblewrap" : "seatbelt";
}

export const LINUX_SANDBOX_WARNINGS = [
  "Loopback is private to the sandbox's network namespace: commands cannot reach services listening on the host's localhost, and their listeners are not reachable from the host.",
  "Unix socket creation is blocked by seccomp, so host sockets such as the Docker socket are unreachable.",
] as const;

export interface PreparedWorkspaceSandboxLaunch {
  /** Canonical working directory. */
  readonly cwd: string;
  /** Owned by the caller: call `cleanup()` when the command finishes. */
  readonly directories: SandboxPrivateDirectories;
  readonly binding: SandboxLaunchBindingInput;
  readonly bindingDigest: string;
  readonly hasCapability: boolean;
  /** Ungranted authorization; capability launches still need a grant. */
  readonly authorization: SandboxLaunchAuthorization;
  readonly metadata: SandboxExecutionMetadata;
}

interface WorkspacePolicyIntegrityRoots {
  roots: string[];
  warnings: string[];
}

export function isWithinSandboxRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function uniqueSandboxRoots(roots: readonly string[]): string[] {
  const sorted = [...new Set(roots.map((root) => path.normalize(root)))].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  const result: string[] = [];
  for (const root of sorted) {
    if (!result.some((candidate) => isWithinSandboxRoot(root, candidate)))
      result.push(root);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

async function resolveRegularPolicyFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const name of (await readdir(root)).sort()) {
    const candidate = path.join(root, name);
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) continue;
    if (metadata.isFile()) {
      files.push(await realpath(candidate));
      continue;
    }
    if (metadata.isDirectory()) {
      files.push(...(await resolveRegularPolicyFiles(candidate)));
    }
  }
  return files;
}

/**
 * Follows a policy entry symlink whose canonical target stays inside one of
 * the workspace root's protected policy namespaces, such as the common
 * `.agents/skills -> ../.claude/skills` convention. Any other target (outside
 * the namespaces, another root, or dangling) fails closed with the offending
 * path so the caller sees a structural-protection error, not a generic one.
 */
async function resolveProtectedPolicySymlink(
  candidate: string,
  protectedNamespaces: readonly string[],
): Promise<{ target: string; metadata: Stats }> {
  let target: string;
  try {
    target = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new SandboxStructuralProtectionError(
      `Workspace policy entry must not be a dangling symbolic link: ${candidate}`,
      { kind: "symbolic_link", path: candidate },
    );
  }
  if (!protectedNamespaces.some((root) => isWithinSandboxRoot(target, root))) {
    throw new SandboxStructuralProtectionError(
      `Workspace policy entry must not be a symbolic link outside the workspace's ${POLICY_NAMESPACE_NAMES.join(", ")} folders: ${candidate} -> ${target}`,
      { kind: "symbolic_link", path: candidate },
    );
  }
  return { target, metadata: await lstat(target) };
}

async function resolvePolicyNamespaceIntegrityRoots(
  namespaceRoot: string,
  options: {
    runtimeEntries?: ReadonlySet<string>;
    protectedNamespaces: readonly string[];
  },
): Promise<string[]> {
  let rootMetadata;
  try {
    rootMetadata = await lstat(namespaceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  // The namespace node itself lives in the writable workspace root, so a
  // symlinked namespace could be repointed by a sandboxed command.
  if (rootMetadata.isSymbolicLink()) {
    throw new SandboxStructuralProtectionError(
      `Workspace policy namespace must not be a symbolic link: ${namespaceRoot}`,
      { kind: "symbolic_link", path: namespaceRoot },
    );
  }
  if (!rootMetadata.isDirectory()) {
    throw new SandboxStructuralProtectionError(
      `Workspace policy namespace must be a directory: ${namespaceRoot}`,
      { kind: "unsupported_node", path: namespaceRoot },
    );
  }

  const protectedRoots: string[] = [];
  for (const name of (await readdir(namespaceRoot)).sort()) {
    const candidate = path.join(namespaceRoot, name);
    let metadata = await lstat(candidate);
    if (options.runtimeEntries?.has(name)) {
      if (metadata.isSymbolicLink()) {
        throw new SandboxStructuralProtectionError(
          `Workspace policy entry must not be a symbolic link: ${candidate}`,
          { kind: "symbolic_link", path: candidate },
        );
      }
      continue;
    }
    const selectedSubtree = PROTECTED_POLICY_SUBTREE_RE.test(name);
    let resolved = candidate;
    if (metadata.isSymbolicLink()) {
      if (
        !namespaceRoot.endsWith(`${path.sep}.agentlink`) &&
        !selectedSubtree &&
        !path.extname(name)
      ) {
        continue;
      }
      ({ target: resolved, metadata } = await resolveProtectedPolicySymlink(
        candidate,
        options.protectedNamespaces,
      ));
    }
    if (metadata.isFile()) {
      protectedRoots.push(await realpath(resolved));
      continue;
    }
    if (metadata.isDirectory() && selectedSubtree) {
      protectedRoots.push(...(await resolveRegularPolicyFiles(resolved)));
    }
  }
  return uniqueSandboxRoots(protectedRoots);
}

async function resolveWorkspacePolicyIntegrityRoots(
  workspaceRoot: string,
): Promise<WorkspacePolicyIntegrityRoots> {
  const protectedNamespaces = POLICY_NAMESPACE_NAMES.map((name) =>
    path.join(workspaceRoot, name),
  );
  const namespaceRoots = await Promise.all(
    POLICY_NAMESPACE_NAMES.map((name) =>
      resolvePolicyNamespaceIntegrityRoots(path.join(workspaceRoot, name), {
        ...(name === ".agentlink"
          ? { runtimeEntries: AGENTLINK_RUNTIME_ENTRIES }
          : {}),
        protectedNamespaces,
      }),
    ),
  );
  const instructionResolutions = await Promise.all(
    [...PROTECTED_INSTRUCTION_FILENAMES].map(async (entry) => {
      const candidate = path.join(workspaceRoot, entry);
      return {
        candidate,
        resolution: await resolveWorkspaceInstructionFile(
          candidate,
          workspaceRoot,
        ),
      };
    }),
  );
  const instructionFiles = instructionResolutions.flatMap(({ resolution }) =>
    resolution.status === "accepted" ? [resolution.canonicalPath] : [],
  );
  const warnings = instructionResolutions.flatMap(
    ({ candidate, resolution }) =>
      resolution.status === "ignored"
        ? [
            describeIgnoredWorkspaceInstructionFile(
              candidate,
              resolution.reason,
            ),
          ]
        : [],
  );
  return {
    roots: uniqueSandboxRoots([...namespaceRoots.flat(), ...instructionFiles]),
    warnings,
  };
}

async function resolveDeveloperToolchain(): Promise<{
  developerDirectory?: string;
  readableRoots: string[];
}> {
  try {
    const developerDirectory = await realpath("/var/select/developer_dir");
    return {
      developerDirectory,
      readableRoots: [path.dirname(developerDirectory)],
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EACCES" && code !== "EPERM") {
      throw error;
    }
    return { readableRoots: [] };
  }
}

export async function createSandboxPrivateDirectories(
  prefix: string,
): Promise<SandboxPrivateDirectories> {
  if (!path.isAbsolute(prefix) || prefix.includes("\0")) {
    throw new Error(
      "Sandbox private directory prefix must be absolute without NUL",
    );
  }
  const requestedRoot = await mkdtemp(prefix);
  const root = await realpath(requestedRoot);
  const home = path.join(root, "h");
  const tmp = path.join(root, "t");
  const cache = path.join(root, "c");
  await Promise.all([mkdir(home), mkdir(tmp), mkdir(cache)]);
  let cleaned = false;
  return {
    root,
    home,
    tmp,
    cache,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        // A child process can finish creating cache files just as finalization
        // starts. Node retries ENOTEMPTY/EBUSY with bounded backoff here, and a
        // residual cleanup failure must not replace the completed command's
        // result with an unrelated finalizer error.
        rmSync(root, {
          recursive: true,
          force: true,
          maxRetries: 4,
          retryDelay: 50,
        });
      } catch {
        // Cleanup is best-effort after the bounded retries above. The root is
        // private to this launch and can be removed by normal temporary-file
        // reclamation without changing the command's launch outcome.
      }
    },
  };
}

/**
 * Whether a variable passed in the host environment would not reach a
 * sandboxed command as given: the default policy drops `*KEY*`, `*SECRET*`
 * and `*TOKEN*` names, and the sandbox sets or reserves the others itself.
 */
export function isSandboxManagedEnvironmentName(name: string): boolean {
  return (
    isReservedEnvironmentName(name) ||
    name.toLowerCase() === "npm_config_cache" ||
    name === "GOCACHE" ||
    name === "GOLANGCI_LINT_CACHE" ||
    /KEY|SECRET|TOKEN/i.test(name)
  );
}

function isReservedEnvironmentName(name: string): boolean {
  return (
    RESERVED_ENVIRONMENT_NAMES.has(name) ||
    RESERVED_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

function buildEnvironment(
  explicit: Readonly<Record<string, string>> | undefined,
  hostEnvironment: Readonly<Record<string, string | undefined>>,
  agentEnvironment: Readonly<Record<string, string>>,
  policy: SandboxShellEnvironmentPolicy | undefined,
  directories: SandboxPrivateDirectories,
  homeDirectory: string,
  temporaryDirectory: string,
  developerDirectory: string | undefined,
  temporaryHome: boolean,
  command: string,
  budgetBytes: number,
  locale: string,
) {
  const resolved = buildSandboxPolicyEnvironment(hostEnvironment, policy);
  if (resolved.policy.useProfile) {
    throw new SandboxPreparationError("unsupported_shell_profile");
  }
  const environment: Record<string, string> = {};
  const provenance: Record<string, SandboxEnvironmentProvenance> = {};
  const setEntry = (
    name: string,
    value: string,
    source: SandboxEnvironmentProvenance,
  ) => {
    environment[name] = value;
    provenance[name] = source;
  };
  for (const [name, value] of Object.entries(resolved.environment)) {
    if (
      isReservedEnvironmentName(name) ||
      name.toLowerCase() === "npm_config_cache"
    )
      continue;
    setEntry(name, value, resolved.provenance[name]);
  }
  for (const [name, value] of Object.entries(agentEnvironment)) {
    setEntry(name, value, "agent-reserved");
  }
  let explicitNpmCache: string | undefined;
  const reservedKeys = Object.keys(explicit ?? {}).filter(
    isReservedEnvironmentName,
  );
  if (reservedKeys.length > 0) {
    throw new SandboxPreparationError(
      reservedKeys.includes("PATH")
        ? "reserved_path_override"
        : "reserved_environment_override",
      undefined,
      {
        phase: "environment",
        ...sandboxEnvironmentKeyDiagnostic(reservedKeys),
      },
    );
  }
  for (const [name, value] of Object.entries(explicit ?? {})) {
    if (name.toLowerCase() === "npm_config_cache") {
      if (explicitNpmCache !== undefined && explicitNpmCache !== value) {
        throw new SandboxPreparationError("conflicting_npm_cache_overrides");
      }
      explicitNpmCache = value;
      continue;
    }

    setEntry(name, value, "per-command");
  }
  const hostPath = hostEnvironment.PATH?.trim() || DEFAULT_PATH;
  const executablePath = developerDirectory
    ? `${path.join(developerDirectory, "usr", "bin")}:${hostPath}`
    : hostPath;
  for (const [name, value] of Object.entries({
    HOME: temporaryHome ? directories.home : homeDirectory,
    TMPDIR: temporaryDirectory,
    XDG_CACHE_HOME: directories.cache,
    GOCACHE: explicit?.GOCACHE ?? path.join(directories.cache, "go-build"),
    GOLANGCI_LINT_CACHE:
      explicit?.GOLANGCI_LINT_CACHE ??
      path.join(directories.cache, "golangci-lint"),
    CLAUDE_CODE_TMPDIR: directories.tmp,
    PATH: executablePath,
    TERM: "xterm-256color",
    LANG: locale,
    LC_ALL: locale,
    ...(developerDirectory
      ? {
          DEVELOPER_DIR: developerDirectory,
          xcrun_db: path.join(directories.tmp, "xcrun_db"),
        }
      : {}),
  })) {
    setEntry(
      name,
      value,
      explicit && Object.hasOwn(explicit, name)
        ? "per-command"
        : "agent-reserved",
    );
  }
  setEntry(
    "npm_config_cache",
    explicitNpmCache || path.join(directories.cache, "npm"),
    explicitNpmCache ? "per-command" : "agent-reserved",
  );
  let budget: ReturnType<typeof budgetSandboxEnvironment>;
  try {
    budget = budgetSandboxEnvironment(
      environment,
      provenance,
      command,
      budgetBytes,
    );
  } catch (error) {
    // Identify this check without parsing or exposing exception text, values,
    // command contents, or unbounded environment names.
    throw new SandboxPreparationError(
      "preparation_failed",
      { cause: error },
      {
        phase: "environment",
        category: "environment_budget_failed",
        ...sandboxEnvironmentKeyDiagnostic(
          Object.keys(environment).filter(
            (name) => provenance[name] !== "host-inherited",
          ),
        ),
      },
    );
  }
  return {
    policy: resolved.policy,
    provenance,
    environment: budget.environment,
    budget,
  };
}

/**
 * Resolve roots, create the private directories, and build the policy,
 * binding and metadata for one sandboxed command. On failure the private
 * directories are removed; on success the caller owns them.
 */
export async function prepareWorkspaceSandboxLaunch(
  options: PrepareWorkspaceSandboxLaunchOptions,
): Promise<PreparedWorkspaceSandboxLaunch> {
  const { capability } = options;
  const backend = sandboxBackendFor(options.platform ?? process.platform);
  const linux = backend === "bubblewrap";
  const shareHostTemporaryDirectories =
    options.shareHostTemporaryDirectories ?? true;
  const prepareStage = async <T>(
    phase: SandboxPreparationPhase,
    run: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw sandboxPreparationFailure(error, phase);
    }
  };
  const workspaceRoots = await prepareStage("workspace_roots", async () =>
    uniqueSandboxRoots(
      await Promise.all(options.workspaceRoots.map((root) => realpath(root))),
    ),
  );
  const cwd = await prepareStage("working_directory", async () => {
    const resolved = await realpath(options.cwd);
    if (!workspaceRoots.some((root) => isWithinSandboxRoot(resolved, root))) {
      throw new Error("Sandbox cwd must be inside an active workspace root");
    }
    return resolved;
  });

  const directories = await prepareStage("private_directories", () =>
    createSandboxPrivateDirectories(options.privateDirectoryPrefix),
  );
  let phase: SandboxPreparationPhase = "inline_files";
  try {
    const inlineFiles = (await options.verifyInlineFiles?.()) ?? [];
    phase = "git_protection";
    const gitProtection = await Promise.all(
      workspaceRoots.map((root) => resolveWorkspaceGitProtection(root)),
    );
    const policyWriteDenials = workspaceRoots.flatMap((root) => [
      path.join(root, ".agentlink"),
      ...PROTECTED_WORKSPACE_ENTRIES.map((entry) => path.join(root, entry)),
    ]);
    phase = "workspace_policy_integrity";
    const policyIntegrity = await Promise.all(
      workspaceRoots.map(resolveWorkspacePolicyIntegrityRoots),
    );
    const policyIntegrityRoots = policyIntegrity.flatMap(
      (result) => result.roots,
    );
    const policyWarnings = policyIntegrity.flatMap((result) => result.warnings);
    phase = "developer_toolchain";
    const developerToolchain = await resolveDeveloperToolchain();
    phase = "trusted_runtime_roots";
    await Promise.all(
      options.trustedRuntimeRoots.map(async (root) => {
        if (!path.isAbsolute(root) || root.includes("\0")) {
          throw new Error(
            "Trusted sandbox runtime roots must be absolute without NUL",
          );
        }
        const canonical = await realpath(root);
        const metadata = await lstat(canonical);
        if (!metadata.isDirectory()) {
          throw new Error(
            `Trusted sandbox runtime root is not a directory: ${root}`,
          );
        }
      }),
    );
    phase = "temporary_directory";
    const hostTemporaryDirectory = await realpath(
      options.hostTemporaryDirectory,
    );
    const developmentTemporaryRoots = shareHostTemporaryDirectories
      ? uniqueSandboxRoots([
          ...(linux ? LINUX_TEMPORARY_ROOTS : MACOS_TEMPORARY_ROOTS),
          hostTemporaryDirectory,
        ])
      : [];
    phase = "environment";
    const environmentResult = buildEnvironment(
      options.explicitEnvironment,
      options.hostEnvironment,
      options.agentEnvironment,
      options.environmentPolicy,
      directories,
      options.homeDirectory,
      shareHostTemporaryDirectories ? hostTemporaryDirectory : directories.tmp,
      developerToolchain.developerDirectory,
      options.temporaryHome,
      options.command,
      options.environmentBudgetBytes,
      // Many Linux installs lack en_US.UTF-8, and setting a missing locale
      // makes every shell print warnings; glibc always has C.UTF-8.
      linux ? "C.UTF-8" : "en_US.UTF-8",
    );
    const { set: environmentOverrides, ...environmentPolicyFields } =
      environmentResult.policy;
    const environmentPolicySummary = {
      ...environmentPolicyFields,
      setKeys: Object.keys(environmentOverrides).sort(),
    };
    const deniedWriteRoots = uniqueSandboxRoots([
      ...gitProtection.flatMap((item) => item.deniedWrite),
      ...policyWriteDenials,
      ...(linux
        ? LINUX_RUNTIME_COMPATIBILITY_WRITE_ROOTS
        : MACOS_RUNTIME_COMPATIBILITY_WRITE_ROOTS),
      path.join(options.homeDirectory, ".npm", "_logs"),
      path.join(options.homeDirectory, ".claude", "debug"),
    ]);
    const protectedReadOnlyRoots = uniqueSandboxRoots([
      ...gitProtection.flatMap((item) => item.integrity),
      ...policyIntegrityRoots,
    ]);
    const structurallyProtectedRoots = uniqueSandboxRoots(
      gitProtection.flatMap((item) => item.structural),
    );
    phase = "read_policy";
    const deniedReadRoots = uniqueSandboxRoots(
      await Promise.all(
        (options.deniedReadRoots ?? []).map(async (root) => {
          if (!path.isAbsolute(root) || root.includes("\0")) {
            throw new Error(
              "Denied sandbox read roots must be absolute without NUL",
            );
          }
          return await realpath(root).catch(() => path.resolve(root));
        }),
      ),
    );
    // The runtime re-allows `allowRead` entries inside denied roots, so a
    // denied launch lists only what must stay readable there; everything
    // outside the denied roots is readable by default.
    const readableRoots =
      deniedReadRoots.length > 0
        ? uniqueSandboxRoots([
            ...workspaceRoots,
            directories.root,
            ...(await Promise.all(
              options.trustedRuntimeRoots.map((root) => realpath(root)),
            )),
          ])
        : ["/"];
    phase = "launch_binding";
    const binding: SandboxLaunchBindingInput = {
      command: options.command,
      cwd,
      environment: environmentResult.environment,
      inlineFiles,
      sessionId: options.sessionId,
      policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
      profileId: WORKSPACE_SANDBOX_PROFILE_ID,
      capability: {
        publicNetwork: capability.publicNetwork,
        localBinding: capability.localBinding,
      },
    };
    const bindingDigest = createSandboxLaunchBindingDigest(binding);
    const hasCapability = capability.publicNetwork || capability.localBinding;
    const capabilityRequest = hasCapability
      ? {
          ...(capability.publicNetwork
            ? { unrestrictedPublicNetwork: true as const }
            : {}),
          ...(capability.localBinding
            ? { allowLocalBinding: true as const }
            : {}),
        }
      : undefined;
    const authorization: SandboxLaunchAuthorization = {
      bindingDigest,
      ...(capabilityRequest ? { capabilityRequest } : {}),
      policy: {
        version: CURRENT_SANDBOX_POLICY_VERSION,
        profileId: WORKSPACE_SANDBOX_PROFILE_ID,
        readableRoots,
        writableRoots: uniqueSandboxRoots([
          ...workspaceRoots,
          ...developmentTemporaryRoots,
          directories.root,
        ]),
        deniedRoots: deniedReadRoots,
        deniedWriteRoots,
        protectedReadOnlyRoots,
        structurallyProtectedRoots,
        network: {
          mode: capability.publicNetwork ? "public-proxy" : "loopback",
          ...(capability.localBinding
            ? { allowLocalBinding: true as const }
            : {}),
        },
        environment: {
          inheritHost: false,
          values: { ...environmentResult.environment },
          summary: {
            ...environmentPolicySummary,
            exclude: [...environmentPolicySummary.exclude],
            includeOnly: [...environmentPolicySummary.includeOnly],
            setKeys: [...environmentPolicySummary.setKeys],
          },
        },
        allowedUnixSockets: [],
      },
    };
    const metadata: SandboxExecutionMetadata = {
      policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
      profileId: WORKSPACE_SANDBOX_PROFILE_ID,
      backend,
      environmentPolicy: {
        ...environmentPolicySummary,
        exclude: [...environmentPolicySummary.exclude],
        includeOnly: [...environmentPolicySummary.includeOnly],
        setKeys: [...environmentPolicySummary.setKeys],
      },
      environmentBudget: {
        limitBytes: options.environmentBudgetBytes,
        estimatedBytes: environmentResult.budget.estimatedBytes,
        protectedBytes: environmentResult.budget.protectedBytes,
        dropped: environmentResult.budget.dropped.map((entry) => ({
          ...entry,
        })),
      },
      capabilities: {
        backend,
        processTree: true,
        filesystemRead:
          deniedReadRoots.length > 0 ? "isolated" : "host-visible",
        filesystemWrite: "strict",
        network: capability.localBinding
          ? capability.publicNetwork
            ? "partial"
            : "loopback-listener"
          : capability.publicNetwork
            ? "proxy-only"
            : "loopback",
        privateHome: options.temporaryHome,
        privateTmp: !shareHostTemporaryDirectories,
        hostIpcBlocked: false,
        resourceLimits: "partial",
        warnings: [
          deniedReadRoots.length > 0
            ? "Denied read roots are hidden except for the workspace, private per-command directories and trusted runtime roots."
            : options.temporaryHome
              ? "HOME is a fresh writable per-command directory; normal user configuration and credentials are absent, while the host home remains readable by absolute path."
              : "The host home directory is readable but not writable; the configured shell environment policy controls inherited variables.",
          "Go and GolangCI caches use writable per-command sandbox directories unless explicitly overridden.",
          environmentResult.provenance.npm_config_cache === "per-command"
            ? "npm cache environment uses the explicit per-command env override; CLI --cache precedence and filesystem write restrictions still apply."
            : "npm cache environment uses writable per-command sandbox storage, overriding inherited environment, shell-policy and npmrc cache settings only. CLI --cache precedence and other npm configuration are unchanged.",
          shareHostTemporaryDirectories
            ? linux
              ? "Host temporary directories are available for development toolchain compatibility."
              : "Host temporary directories and POSIX IPC are available for development toolchain compatibility."
            : "TMPDIR is a private per-command directory; host temporary directories are read-only.",
          "CPU, memory, process-count, and disk quotas are not fully enforced.",
          ...(backend === "bubblewrap" ? LINUX_SANDBOX_WARNINGS : []),
          ...policyWarnings,
        ],
      },
      ...(capabilityRequest ? { capabilityRequest } : {}),
    };
    return {
      cwd,
      directories,
      binding,
      bindingDigest,
      hasCapability,
      authorization,
      metadata,
    };
  } catch (error) {
    directories.cleanup();
    throw sandboxPreparationFailure(error, phase);
  }
}
