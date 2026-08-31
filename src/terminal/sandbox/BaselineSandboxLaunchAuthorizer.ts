import { rmSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CURRENT_SANDBOX_POLICY_VERSION,
  validateCheckpointBSandboxCapabilityRequest,
  type ApprovedSandboxCapabilityGrant,
  type SandboxLaunchAuthorization,
  type SandboxLaunchBindingInput,
} from "../../core/sandboxPolicy.js";
import type { SandboxExecutionMetadata } from "@agentlink/protocol/terminal-security";
import { SandboxCapabilityLaunchError } from "../../core/capabilities/SandboxCapabilityLaunchError.js";
import type { TerminalExecuteOptions } from "../../core/capabilities/terminal.js";
import { buildAgentExecutionEnv } from "../../process/agentExecutionPolicy.js";
import {
  createSandboxLaunchBindingDigest,
  SandboxCapabilityAuthority,
} from "./SandboxCapabilityAuthority.js";
import type {
  ActiveSandboxLaunch,
  PreparedSandboxLaunch,
  SandboxLaunchAuthorizer,
} from "./SandboxTerminalCoordinator.js";
import {
  budgetSandboxEnvironment,
  buildSandboxPolicyEnvironment,
  SANDBOX_AUTHORIZER_EXEC_BUDGET_BYTES,
  type SandboxEnvironmentProvenance,
  type SandboxShellEnvironmentPolicy,
} from "./sandboxEnvironmentPolicy.js";
import { resolveWorkspaceGitProtection } from "./gitMetadataProtection.js";
import { compileSandboxHelperLaunchRequest } from "./sandboxPolicyCompiler.js";
import { verifyTerminalInlineFiles } from "../inlineFileIntegrity.js";
import {
  describeIgnoredWorkspaceInstructionFile,
  resolveWorkspaceInstructionFile,
  WORKSPACE_INSTRUCTION_FILENAMES,
} from "../../util/workspaceInstructionFile.js";
import {
  sandboxCapabilityKind,
  sandboxCapabilityPreparationAgeBucket,
  type SandboxCapabilityGrantTiming,
  type SandboxCapabilityGrantTimingEvent,
} from "./sandboxCapabilityGrantTiming.js";

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
const PROTECTED_INSTRUCTION_FILENAMES = WORKSPACE_INSTRUCTION_FILENAMES;
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
  /** Conservative argv/environment budget used before the helper composes final argv. */
  environmentBudgetBytes?: number;
  /** Canonical validated runtime directories required by sandboxed commands. */
  trustedRuntimeRoots?: readonly string[];
  capabilityAuthority?: SandboxCapabilityAuthority;
  capabilityGrantTtlMs?: number;
  capabilityGrantTiming?: SandboxCapabilityGrantTiming;
  onCapabilityGrantTimingEvent?: (
    event: SandboxCapabilityGrantTimingEvent,
  ) => void;
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

interface WorkspacePolicyIntegrityRoots {
  roots: string[];
  warnings: string[];
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
): Promise<WorkspacePolicyIntegrityRoots> {
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
  const warnings = instructionResolutions.flatMap(({ candidate, resolution }) =>
    resolution.status === "ignored"
      ? [describeIgnoredWorkspaceInstructionFile(candidate, resolution.reason)]
      : [],
  );
  return {
    roots: uniqueRoots([...namespaceRoots.flat(), ...instructionFiles]),
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
  command: string,
  budgetBytes: number,
) {
  const resolved = buildSandboxPolicyEnvironment(hostEnvironment, policy);
  if (resolved.policy.useProfile) {
    throw new Error(
      "Sandbox shell environment useProfile is not supported by the attested interactive helper yet.",
    );
  }
  const agentEnvironment = buildAgentExecutionEnv();
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
    if (isReservedEnvironmentName(name)) continue;
    setEntry(name, value, resolved.provenance[name]);
  }
  for (const [name, value] of Object.entries(agentEnvironment)) {
    setEntry(name, value, "agent-reserved");
  }
  for (const [name, value] of Object.entries(explicit ?? {})) {
    if (isReservedEnvironmentName(name)) {
      throw new Error(`Sandbox environment override is reserved: ${name}`);
    }
    setEntry(name, value, "per-command");
  }
  const hostPath = hostEnvironment.PATH?.trim() || DEFAULT_PATH;
  const executablePath = developerDirectory
    ? `${path.join(developerDirectory, "usr", "bin")}:${hostPath}`
    : hostPath;
  for (const [name, value] of Object.entries({
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
  })) {
    setEntry(
      name,
      value,
      explicit && Object.hasOwn(explicit, name)
        ? "per-command"
        : "agent-reserved",
    );
  }
  const budget = budgetSandboxEnvironment(
    environment,
    provenance,
    command,
    budgetBytes,
  );
  return {
    policy: resolved.policy,
    provenance,
    environment: budget.environment,
    budget,
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
  private readonly environmentBudgetBytes: number;
  private readonly capabilityAuthority: SandboxCapabilityAuthority;
  private readonly capabilityGrantTtlMs: number;
  private readonly capabilityGrantTiming: SandboxCapabilityGrantTiming;
  private readonly onCapabilityGrantTimingEvent?: (
    event: SandboxCapabilityGrantTimingEvent,
  ) => void;
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
    this.environmentBudgetBytes =
      options.environmentBudgetBytes ?? SANDBOX_AUTHORIZER_EXEC_BUDGET_BYTES;
    if (
      !Number.isSafeInteger(this.environmentBudgetBytes) ||
      this.environmentBudgetBytes <= 0
    ) {
      throw new Error("Sandbox environment budget must be a positive integer");
    }
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
    this.capabilityGrantTiming = options.capabilityGrantTiming ?? "launch";
    this.onCapabilityGrantTimingEvent = options.onCapabilityGrantTimingEvent;
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
  >[0]): Promise<PreparedSandboxLaunch> {
    const preparedAt = this.now();
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
      const policyIntegrity = await Promise.all(
        workspaceRoots.map(resolveWorkspacePolicyIntegrityRoots),
      );
      const policyIntegrityRoots = policyIntegrity.flatMap(
        (result) => result.roots,
      );
      const policyWarnings = policyIntegrity.flatMap(
        (result) => result.warnings,
      );
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
        options.command,
        this.environmentBudgetBytes,
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
        profileId: PROFILE_ID,
        backend: "seatbelt",
        environmentPolicy: {
          ...environmentPolicySummary,
          exclude: [...environmentPolicySummary.exclude],
          includeOnly: [...environmentPolicySummary.includeOnly],
          setKeys: [...environmentPolicySummary.setKeys],
        },
        environmentBudget: {
          limitBytes: this.environmentBudgetBytes,
          estimatedBytes: environmentResult.budget.estimatedBytes,
          protectedBytes: environmentResult.budget.protectedBytes,
          dropped: environmentResult.budget.dropped.map((entry) => ({
            ...entry,
          })),
        },
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
            ...policyWarnings,
          ],
        },
        ...(capabilityRequest ? { capabilityRequest } : {}),
      };
      const identity = Object.freeze({ channelId, commandId, generation });
      const compile = (activeAuthorization: SandboxLaunchAuthorization) =>
        compileSandboxHelperLaunchRequest({
          channelId,
          commandId,
          generation,
          command: options.command,
          cwd,
          shell: this.shell,
          dimensions: { ...dimensions },
          authorization: activeAuthorization,
        });
      let activeGrantId: string | undefined;
      let finalized = false;
      let activated = false;
      const timingEvent = (
        type: SandboxCapabilityGrantTimingEvent["type"],
        reason?: SandboxCapabilityGrantTimingEvent["reason"],
      ) => {
        if (!hasCapability) return;
        const ageMs = Math.max(0, this.now() - preparedAt);
        this.onCapabilityGrantTimingEvent?.({
          type,
          timing: this.capabilityGrantTiming,
          capability: sandboxCapabilityKind(capability),
          preparationAgeBucket: sandboxCapabilityPreparationAgeBucket(ageMs),
          exceededLegacyTtl: ageMs >= this.capabilityGrantTtlMs,
          ...(reason ? { reason } : {}),
        });
      };
      const finalize = () => {
        if (finalized) return;
        finalized = true;
        if (activeGrantId && this.capabilityAuthority.revoke(activeGrantId)) {
          timingEvent("revoked");
        }
        directories.cleanup();
      };
      const activeMetadata = (
        grant: ApprovedSandboxCapabilityGrant | undefined,
      ): SandboxExecutionMetadata => ({
        ...metadata,
        capabilities: {
          ...metadata.capabilities,
          warnings: [...metadata.capabilities.warnings],
        },
        ...(metadata.environmentPolicy
          ? {
              environmentPolicy: {
                ...metadata.environmentPolicy,
                exclude: [...metadata.environmentPolicy.exclude],
                includeOnly: [...metadata.environmentPolicy.includeOnly],
                setKeys: [...metadata.environmentPolicy.setKeys],
              },
            }
          : {}),
        ...(metadata.environmentBudget
          ? {
              environmentBudget: {
                ...metadata.environmentBudget,
                dropped: metadata.environmentBudget.dropped.map((entry) => ({
                  ...entry,
                })),
              },
            }
          : {}),
        ...(metadata.capabilityRequest
          ? { capabilityRequest: { ...metadata.capabilityRequest } }
          : {}),
        ...(grant
          ? {
              grantTiming: this.capabilityGrantTiming,
              grant: { grantId: grant.grantId, auditId: grant.auditId },
            }
          : {}),
      });
      const activateGrant = () => {
        let grant: ApprovedSandboxCapabilityGrant;
        try {
          const issued = this.capabilityAuthority.issueCapabilityGrant({
            binding,
            expiresAt: this.now() + this.capabilityGrantTtlMs,
          });
          activeGrantId = issued.grant.grantId;
          const consumed = this.capabilityAuthority.consume(
            issued.handle,
            binding,
          );
          if (!consumed.ok) {
            throw new SandboxCapabilityLaunchError(consumed.reason);
          }
          grant = consumed.grant;
        } catch (error) {
          const failure =
            error instanceof SandboxCapabilityLaunchError
              ? error
              : new SandboxCapabilityLaunchError("issue_failed", {
                  cause: error,
                });
          timingEvent("activation_failed", failure.reason);
          finalize();
          throw failure;
        }
        const activeAuthorization = { ...authorization, grant };
        try {
          const helperRequest = compile(activeAuthorization);
          const assertLaunchValid = () => {
            const validation = this.capabilityAuthority.validateConsumed(
              grant.grantId,
              binding,
            );
            if (!validation.ok) {
              throw new SandboxCapabilityLaunchError(validation.reason);
            }
          };
          assertLaunchValid();
          timingEvent("activated");
          return {
            helperRequest,
            metadata: activeMetadata(grant),
            assertLaunchValid,
          };
        } catch (error) {
          const failure =
            error instanceof SandboxCapabilityLaunchError
              ? error
              : new SandboxCapabilityLaunchError("compile_failed", {
                  cause: error,
                });
          timingEvent("activation_failed", failure.reason);
          finalize();
          throw failure;
        }
      };
      let cachedActive: ActiveSandboxLaunch | undefined = !hasCapability
        ? {
            helperRequest: compile(authorization),
            metadata: activeMetadata(undefined),
          }
        : this.capabilityGrantTiming === "preparation"
          ? activateGrant()
          : undefined;
      const preparedMetadata = cachedActive?.metadata ?? metadata;
      return {
        identity,
        policy: {
          ...authorization.policy,
          readableRoots: [...authorization.policy.readableRoots],
          writableRoots: [...authorization.policy.writableRoots],
          deniedRoots: [...authorization.policy.deniedRoots],
          deniedWriteRoots: [...(authorization.policy.deniedWriteRoots ?? [])],
          protectedReadOnlyRoots: [
            ...authorization.policy.protectedReadOnlyRoots,
          ],
          structurallyProtectedRoots: [
            ...(authorization.policy.structurallyProtectedRoots ?? []),
          ],
          network: { ...authorization.policy.network },
          environment: {
            inheritHost: false,
            values: { ...authorization.policy.environment.values },
            ...(authorization.policy.environment.summary
              ? {
                  summary: {
                    ...authorization.policy.environment.summary,
                    exclude: [
                      ...authorization.policy.environment.summary.exclude,
                    ],
                    includeOnly: [
                      ...authorization.policy.environment.summary.includeOnly,
                    ],
                    setKeys: [
                      ...authorization.policy.environment.summary.setKeys,
                    ],
                  },
                }
              : {}),
          },
          allowedUnixSockets: [...authorization.policy.allowedUnixSockets],
        },
        bindingDigest,
        metadata: preparedMetadata,
        activate: () => {
          if (activated || finalized) {
            throw new Error("Prepared sandbox launch is no longer available");
          }
          activated = true;
          if (!cachedActive) cachedActive = activateGrant();
          if (cachedActive.assertLaunchValid) {
            try {
              cachedActive.assertLaunchValid();
            } catch (error) {
              const failure =
                error instanceof SandboxCapabilityLaunchError
                  ? error
                  : new SandboxCapabilityLaunchError("issue_failed", {
                      cause: error,
                    });
              timingEvent("activation_failed", failure.reason);
              finalize();
              throw failure;
            }
          }
          return cachedActive;
        },
        finalize,
      };
    } catch (error) {
      directories.cleanup();
      throw error;
    }
  }
}
