import { rmSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  readdir,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CURRENT_SANDBOX_POLICY_VERSION,
  validateCheckpointBSandboxCapabilityRequest,
  type SandboxExecutionMetadata,
  type SandboxLaunchAuthorization,
  type SandboxLaunchBindingInput,
} from "../../core/sandboxPolicy.js";
import type { TerminalExecuteOptions } from "../../core/capabilities/terminal.js";
import { buildAgentExecutionEnv } from "../../process/agentExecutionPolicy.js";
import {
  createSandboxLaunchBindingDigest,
  SandboxCapabilityAuthority,
} from "./SandboxCapabilityAuthority.js";
import {
  type AuthorizedSandboxLaunch,
  type SandboxLaunchAuthorizer,
} from "./SandboxTerminalCoordinator.js";
import {
  buildSandboxPolicyEnvironment,
  type SandboxShellEnvironmentPolicy,
} from "./sandboxEnvironmentPolicy.js";
import { resolveWorkspaceGitProtection } from "./gitMetadataProtection.js";
import { compileSandboxHelperLaunchRequest } from "./sandboxPolicyCompiler.js";
import { verifyTerminalInlineFiles } from "../inlineFileIntegrity.js";

const PROFILE_ID = "workspace-write";
const DEFAULT_CAPABILITY_GRANT_TTL_MS = 10 * 60_000;
const DEFAULT_PATH =
  "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const PRIVATE_DIRECTORY_PREFIX = "/tmp/al-sbx-";
const MACOS_TEMPORARY_ROOTS = ["/tmp", "/private/tmp"] as const;
const PROTECTED_WORKSPACE_ENTRIES = [
  ".agents",
  ".claude",
  ".codex",
  "AGENT.md",
  "AGENTS.md",
  "AGENTS.local.md",
  "CLAUDE.md",
] as const;
const PROTECTED_INSTRUCTION_FILENAMES: ReadonlySet<string> = new Set(
  PROTECTED_WORKSPACE_ENTRIES.filter((entry) => !entry.startsWith(".")),
);
const AGENTLINK_RUNTIME_ENTRIES = new Set([
  "history",
  "transcripts",
  "debug",
  "checkpoints",
  "tool-usage-report",
]);
const PROTECTED_POLICY_SUBTREE_RE = /^(?:commands|rules|skills)(?:-|$)/;

const RUNTIME_COMPATIBILITY_WRITE_ROOTS = [
  "/tmp/claude",
  "/private/tmp/claude",
] as const;
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
export interface BaselineSandboxLaunchAuthorizerOptions {
  workspaceRoots: readonly string[];
  shell?: string;
  privateDirectoryPrefix?: string;
  homeDirectory?: string;
  /** Host per-user temporary directory exposed for normal toolchain compatibility. */
  hostTemporaryDirectory?: string;
  /** Host environment used as the source for the configured shell environment policy. */
  hostEnvironment?: Readonly<Record<string, string | undefined>>;
  environmentPolicy?: SandboxShellEnvironmentPolicy;
  /** Canonical validated runtime directories required by sandboxed commands. */
  trustedRuntimeRoots?: readonly string[];
  capabilityAuthority?: SandboxCapabilityAuthority;
  capabilityGrantTtlMs?: number;
  now?: () => number;
}

interface PrivateDirectories {
  root: string;
  home: string;
  tmp: string;
  cache: string;
  cleanup(): void;
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function uniqueRoots(roots: readonly string[]): string[] {
  const sorted = [...new Set(roots.map((root) => path.normalize(root)))].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  const result: string[] = [];
  for (const root of sorted) {
    if (!result.some((candidate) => isWithin(root, candidate)))
      result.push(root);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

async function resolveProtectedInstructionFile(
  candidate: string,
  workspaceRoot: string,
): Promise<string | undefined> {
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    const target = await readlink(candidate);
    if (
      path.basename(target) !== target ||
      !PROTECTED_INSTRUCTION_FILENAMES.has(target)
    ) {
      throw new Error(
        `Workspace instruction alias must target another declared instruction file in the same workspace root: ${candidate}`,
      );
    }
    const resolvedTarget = path.join(workspaceRoot, target);
    let targetMetadata;
    try {
      targetMetadata = await lstat(resolvedTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Workspace instruction alias target must exist: ${candidate}`,
        );
      }
      throw error;
    }
    if (targetMetadata.isSymbolicLink() || !targetMetadata.isFile()) {
      throw new Error(
        `Workspace instruction alias target must be a regular non-symlink file: ${candidate}`,
      );
    }
    try {
      const canonicalTarget = await realpath(resolvedTarget);
      if (canonicalTarget !== resolvedTarget) {
        throw new Error(
          `Workspace instruction alias target must resolve directly within the workspace root: ${candidate}`,
        );
      }
      return canonicalTarget;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Workspace instruction alias target must exist: ${candidate}`,
        );
      }
      throw error;
    }
  }
  if (!metadata.isFile()) {
    throw new Error(
      `Workspace instruction path must be a regular file: ${candidate}`,
    );
  }
  return realpath(candidate);
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

async function resolvePolicyNamespaceIntegrityRoots(
  namespaceRoot: string,
  options: { runtimeEntries?: ReadonlySet<string> } = {},
): Promise<string[]> {
  let rootMetadata;
  try {
    rootMetadata = await lstat(namespaceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (rootMetadata.isSymbolicLink()) {
    throw new Error(
      `Workspace policy namespace must not be a symbolic link: ${namespaceRoot}`,
    );
  }
  if (!rootMetadata.isDirectory()) {
    throw new Error(
      `Workspace policy namespace must be a directory: ${namespaceRoot}`,
    );
  }

  const protectedRoots: string[] = [];
  for (const name of (await readdir(namespaceRoot)).sort()) {
    const candidate = path.join(namespaceRoot, name);
    const metadata = await lstat(candidate);
    if (options.runtimeEntries?.has(name)) {
      if (metadata.isSymbolicLink()) {
        throw new Error(
          `Workspace policy entry must not be a symbolic link: ${candidate}`,
        );
      }
      continue;
    }
    const selectedSubtree = PROTECTED_POLICY_SUBTREE_RE.test(name);
    if (metadata.isSymbolicLink()) {
      if (
        namespaceRoot.endsWith(`${path.sep}.agentlink`) ||
        selectedSubtree ||
        path.extname(name)
      ) {
        throw new Error(
          `Workspace policy entry must not be a symbolic link: ${candidate}`,
        );
      }
      continue;
    }
    if (metadata.isFile()) {
      protectedRoots.push(await realpath(candidate));
      continue;
    }
    if (metadata.isDirectory() && selectedSubtree) {
      protectedRoots.push(...(await resolveRegularPolicyFiles(candidate)));
    }
  }
  return uniqueRoots(protectedRoots);
}

async function resolveWorkspacePolicyIntegrityRoots(
  workspaceRoot: string,
): Promise<string[]> {
  const namespaceRoots = await Promise.all([
    resolvePolicyNamespaceIntegrityRoots(
      path.join(workspaceRoot, ".agentlink"),
      {
        runtimeEntries: AGENTLINK_RUNTIME_ENTRIES,
      },
    ),
    ...[".agents", ".claude", ".codex"].map((name) =>
      resolvePolicyNamespaceIntegrityRoots(path.join(workspaceRoot, name)),
    ),
  ]);
  const instructionFiles = (
    await Promise.all(
      PROTECTED_WORKSPACE_ENTRIES.filter((entry) => !entry.startsWith(".")).map(
        (entry) =>
          resolveProtectedInstructionFile(
            path.join(workspaceRoot, entry),
            workspaceRoot,
          ),
      ),
    )
  ).filter((entry): entry is string => entry !== undefined);
  return uniqueRoots([...namespaceRoots.flat(), ...instructionFiles]);
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

async function createPrivateDirectories(
  prefix: string,
): Promise<PrivateDirectories> {
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
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function verifyInlineFiles(
  files: TerminalExecuteOptions["sandboxInlineFiles"],
): Promise<{
  binding: SandboxLaunchBindingInput["inlineFiles"];
  readableRoots: string[];
}> {
  const verified = await verifyTerminalInlineFiles(files);
  return {
    binding: verified.binding,
    readableRoots: uniqueRoots(verified.canonicalPaths.map(path.dirname)),
  };
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
  policy: SandboxShellEnvironmentPolicy | undefined,
  directories: PrivateDirectories,
  homeDirectory: string,
  hostTemporaryDirectory: string,
  developerDirectory: string | undefined,
  temporaryHome: boolean,
): ReturnType<typeof buildSandboxPolicyEnvironment> {
  const resolved = buildSandboxPolicyEnvironment(hostEnvironment, policy);
  if (resolved.policy.useProfile) {
    throw new Error(
      "Sandbox shell environment useProfile is not supported by the attested interactive helper yet.",
    );
  }
  const agentEnvironment = buildAgentExecutionEnv();
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(resolved.environment)) {
    if (isReservedEnvironmentName(name)) continue;
    environment[name] = value;
  }
  Object.assign(environment, agentEnvironment);
  for (const [name, value] of Object.entries(explicit ?? {})) {
    if (isReservedEnvironmentName(name)) {
      throw new Error(`Sandbox environment override is reserved: ${name}`);
    }
    environment[name] = value;
  }
  const hostPath = hostEnvironment.PATH?.trim() || DEFAULT_PATH;
  const executablePath = developerDirectory
    ? `${path.join(developerDirectory, "usr", "bin")}:${hostPath}`
    : hostPath;
  return {
    policy: resolved.policy,
    environment: {
      ...environment,
      HOME: temporaryHome ? directories.home : homeDirectory,
      TMPDIR: hostTemporaryDirectory,
      XDG_CACHE_HOME: directories.cache,
      GOCACHE: explicit?.GOCACHE ?? path.join(directories.cache, "go-build"),
      GOLANGCI_LINT_CACHE:
        explicit?.GOLANGCI_LINT_CACHE ??
        path.join(directories.cache, "golangci-lint"),
      CLAUDE_CODE_TMPDIR: directories.tmp,
      PATH: executablePath,
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      ...(developerDirectory
        ? {
            DEVELOPER_DIR: developerDirectory,
            xcrun_db: path.join(directories.tmp, "xcrun_db"),
          }
        : {}),
    },
  };
}

export class BaselineSandboxLaunchAuthorizer implements SandboxLaunchAuthorizer {
  private readonly workspaceRoots: readonly string[];
  private readonly shell: string;
  private readonly privateDirectoryPrefix: string;
  private readonly homeDirectory: string;
  private readonly hostTemporaryDirectory: string;
  private readonly hostEnvironment: Readonly<
    Record<string, string | undefined>
  >;
  private readonly trustedRuntimeRoots: readonly string[];
  private readonly environmentPolicy: SandboxShellEnvironmentPolicy | undefined;
  private readonly capabilityAuthority: SandboxCapabilityAuthority;
  private readonly capabilityGrantTtlMs: number;
  private readonly now: () => number;

  constructor(options: BaselineSandboxLaunchAuthorizerOptions) {
    if (options.workspaceRoots.length === 0) {
      throw new Error(
        "Sandbox terminal requires at least one local workspace root",
      );
    }
    this.workspaceRoots = [...options.workspaceRoots];
    this.shell = options.shell ?? "/bin/zsh";
    this.privateDirectoryPrefix =
      options.privateDirectoryPrefix ?? PRIVATE_DIRECTORY_PREFIX;
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    this.hostTemporaryDirectory = options.hostTemporaryDirectory ?? os.tmpdir();
    this.hostEnvironment = { ...(options.hostEnvironment ?? process.env) };
    this.environmentPolicy = options.environmentPolicy
      ? {
          ...options.environmentPolicy,
          exclude: [...(options.environmentPolicy.exclude ?? [])],
          set: { ...options.environmentPolicy.set },
          includeOnly: [...(options.environmentPolicy.includeOnly ?? [])],
        }
      : undefined;
    this.trustedRuntimeRoots = [...(options.trustedRuntimeRoots ?? [])];
    this.capabilityAuthority =
      options.capabilityAuthority ?? new SandboxCapabilityAuthority();
    this.capabilityGrantTtlMs =
      options.capabilityGrantTtlMs ?? DEFAULT_CAPABILITY_GRANT_TTL_MS;
    if (
      !Number.isFinite(this.capabilityGrantTtlMs) ||
      this.capabilityGrantTtlMs <= 0
    ) {
      throw new Error("Sandbox capability grant TTL must be positive");
    }
    this.now = options.now ?? Date.now;
  }

  async authorize({
    options,
    channelId,
    commandId,
    generation,
    dimensions,
  }: Parameters<
    SandboxLaunchAuthorizer["authorize"]
  >[0]): Promise<AuthorizedSandboxLaunch> {
    if (!options.sandboxSessionId) {
      throw new Error("Sandbox launch requires an owning AgentLink session ID");
    }
    const capability = validateCheckpointBSandboxCapabilityRequest(
      options.sandboxCapabilityRequest,
    );
    if (!capability.ok) {
      throw new Error(
        `Unsupported sandbox capabilities: ${capability.fields.join(", ")}`,
      );
    }

    const workspaceRoots = uniqueRoots(
      await Promise.all(this.workspaceRoots.map((root) => realpath(root))),
    );
    const cwd = await realpath(options.cwd);
    if (!workspaceRoots.some((root) => isWithin(cwd, root))) {
      throw new Error("Sandbox cwd must be inside an active workspace root");
    }

    const directories = await createPrivateDirectories(
      this.privateDirectoryPrefix,
    );
    try {
      const inlineFiles = await verifyInlineFiles(options.sandboxInlineFiles);
      const gitProtection = await Promise.all(
        workspaceRoots.map((root) => resolveWorkspaceGitProtection(root)),
      );
      const policyWriteDenials = workspaceRoots.flatMap((root) => [
        path.join(root, ".agentlink"),
        ...PROTECTED_WORKSPACE_ENTRIES.map((entry) => path.join(root, entry)),
      ]);
      const policyIntegrityRoots = (
        await Promise.all(
          workspaceRoots.map(resolveWorkspacePolicyIntegrityRoots),
        )
      ).flat();
      const developerToolchain = await resolveDeveloperToolchain();
      await Promise.all(
        this.trustedRuntimeRoots.map(async (root) => {
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
      const hostTemporaryDirectory = await realpath(
        this.hostTemporaryDirectory,
      );
      const developmentTemporaryRoots = uniqueRoots([
        ...MACOS_TEMPORARY_ROOTS,
        hostTemporaryDirectory,
      ]);
      const environmentResult = buildEnvironment(
        options.env,
        this.hostEnvironment,
        this.environmentPolicy,
        directories,
        this.homeDirectory,
        hostTemporaryDirectory,
        developerToolchain.developerDirectory,
        options.temporaryHome === true,
      );
      const { set: environmentOverrides, ...environmentPolicyFields } =
        environmentResult.policy;
      const environmentPolicySummary = {
        ...environmentPolicyFields,
        setKeys: Object.keys(environmentOverrides).sort(),
      };
      const deniedWriteRoots = uniqueRoots([
        ...gitProtection.flatMap((item) => item.deniedWrite),
        ...policyWriteDenials,
        ...RUNTIME_COMPATIBILITY_WRITE_ROOTS,
        path.join(this.homeDirectory, ".npm", "_logs"),
        path.join(this.homeDirectory, ".claude", "debug"),
      ]);
      const protectedReadOnlyRoots = uniqueRoots([
        ...gitProtection.flatMap((item) => item.integrity),
        ...policyIntegrityRoots,
      ]);
      const structurallyProtectedRoots = uniqueRoots(
        gitProtection.flatMap((item) => item.structural),
      );
      const readableRoots = ["/"];
      const binding: SandboxLaunchBindingInput = {
        command: options.command,
        cwd,
        environment: environmentResult.environment,
        inlineFiles: inlineFiles.binding,
        sessionId: options.sandboxSessionId,
        policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
        profileId: PROFILE_ID,
        capability: {
          publicNetwork: capability.publicNetwork,
          localBinding: capability.localBinding,
        },
      };
      const bindingDigest = createSandboxLaunchBindingDigest(binding);
      let consumedGrant:
        | ReturnType<
            SandboxCapabilityAuthority["issuePublicNetworkGrant"]
          >["grant"]
        | undefined;
      if (capability.publicNetwork || capability.localBinding) {
        const issued = this.capabilityAuthority.issueCapabilityGrant({
          binding,
          expiresAt: this.now() + this.capabilityGrantTtlMs,
        });
        const consumed = this.capabilityAuthority.consume(
          issued.handle,
          binding,
        );
        if (!consumed.ok) {
          this.capabilityAuthority.revoke(issued.grant.grantId);
          throw new Error(
            `Sandbox capability grant could not be consumed: ${consumed.reason}`,
          );
        }
        consumedGrant = consumed.grant;
      }
      const authorization: SandboxLaunchAuthorization = {
        bindingDigest,
        ...(capability.publicNetwork || capability.localBinding
          ? {
              capabilityRequest: {
                ...(capability.publicNetwork
                  ? { unrestrictedPublicNetwork: true }
                  : {}),
                ...(capability.localBinding ? { allowLocalBinding: true } : {}),
              },
              grant: consumedGrant,
            }
          : {}),
        policy: {
          version: CURRENT_SANDBOX_POLICY_VERSION,
          profileId: PROFILE_ID,
          readableRoots,
          writableRoots: uniqueRoots([
            ...workspaceRoots,
            ...developmentTemporaryRoots,
            directories.root,
          ]),
          deniedRoots: [],
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
            values: environmentResult.environment,
            summary: environmentPolicySummary,
          },
          allowedUnixSockets: [],
        },
      };
      const helperRequest = compileSandboxHelperLaunchRequest({
        channelId,
        commandId,
        generation,
        command: options.command,
        cwd,
        shell: this.shell,
        dimensions,
        authorization,
      });
      const metadata: SandboxExecutionMetadata = {
        policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
        profileId: PROFILE_ID,
        backend: "seatbelt",
        environmentPolicy: environmentPolicySummary,
        capabilities: {
          backend: "seatbelt",
          processTree: true,
          filesystemRead: "host-visible",
          filesystemWrite: "strict",
          network: capability.localBinding
            ? capability.publicNetwork
              ? "partial"
              : "loopback-listener"
            : capability.publicNetwork
              ? "proxy-only"
              : "loopback",
          privateHome: options.temporaryHome === true,
          privateTmp: false,
          hostIpcBlocked: false,
          resourceLimits: "partial",
          warnings: [
            options.temporaryHome === true
              ? "HOME is a fresh writable per-command directory; normal user configuration and credentials are absent, while the host home remains readable by absolute path."
              : "The host home directory is readable but not writable; the configured shell environment policy controls inherited variables.",
            "Go and GolangCI caches use writable per-command sandbox directories unless explicitly overridden.",
            "Host temporary directories and POSIX IPC are available for development toolchain compatibility.",
            "CPU, memory, process-count, and disk quotas are not fully enforced.",
          ],
        },
        ...(capability.publicNetwork || capability.localBinding
          ? {
              capabilityRequest: {
                ...(capability.publicNetwork
                  ? { unrestrictedPublicNetwork: true }
                  : {}),
                ...(capability.localBinding ? { allowLocalBinding: true } : {}),
              },
            }
          : {}),
        ...(consumedGrant
          ? {
              grant: {
                grantId: consumedGrant.grantId,
                auditId: consumedGrant.auditId,
              },
            }
          : {}),
      };
      let finalized = false;
      const finalize = () => {
        if (finalized) return;
        finalized = true;
        if (consumedGrant) {
          this.capabilityAuthority.revoke(consumedGrant.grantId);
        }
        directories.cleanup();
      };
      return {
        authorization,
        helperRequest,
        metadata,
        ...(consumedGrant
          ? {
              assertLaunchValid: () => {
                const validation = this.capabilityAuthority.validateConsumed(
                  consumedGrant.grantId,
                  binding,
                );
                if (!validation.ok) {
                  throw new Error(
                    `Prepared sandbox capability grant is no longer valid: ${validation.reason}`,
                  );
                }
              },
            }
          : {}),
        finalize,
      };
    } catch (error) {
      directories.cleanup();
      throw error;
    }
  }
}
