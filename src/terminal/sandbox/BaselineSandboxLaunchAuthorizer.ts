import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
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
import { createSandboxLaunchBindingDigest } from "./SandboxCapabilityAuthority.js";
import {
  type AuthorizedSandboxLaunch,
  type SandboxLaunchAuthorizer,
} from "./SandboxTerminalCoordinator.js";
import { compileSandboxHelperLaunchRequest } from "./sandboxPolicyCompiler.js";

const PROFILE_ID = "workspace-write";
const DEFAULT_PATH =
  "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const PRIVATE_DIRECTORY_PREFIX = "/tmp/al-sbx-";
const PROTECTED_WORKSPACE_ENTRIES = [
  ".agentlink",
  ".claude",
  "CLAUDE.md",
] as const;
const SYSTEM_READ_ROOTS = [
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/Library",
  "/dev",
  "/etc",
  "/private/etc",
  "/var/select",
  "/private/var/select",
  "/usr/local",
  "/opt/homebrew",
] as const;
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
  /** Canonical validated runtime directories required by sandboxed commands. */
  trustedRuntimeRoots?: readonly string[];
}

interface PrivateDirectories {
  root: string;
  home: string;
  tmp: string;
  cache: string;
  cleanup(): void;
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
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

async function existingCanonicalPath(
  candidate: string,
): Promise<string | undefined> {
  try {
    const metadata = await lstat(candidate);
    if (!metadata.isDirectory() && !metadata.isFile()) return undefined;
    return realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function resolveGitProtection(workspaceRoot: string): Promise<{
  deniedWrite: string[];
  existing: string[];
  readable: string[];
}> {
  const dotGit = path.join(workspaceRoot, ".git");
  const metadata = await existingCanonicalPath(dotGit);
  if (!metadata) {
    return { deniedWrite: [dotGit], existing: [], readable: [] };
  }

  const deniedWrite = [dotGit, metadata];
  const existing = [dotGit, metadata];
  const readable = [metadata];
  const dotGitStat = await lstat(dotGit);
  if (dotGitStat.isFile()) {
    const pointer = await readFile(dotGit, "utf8");
    const match = /^gitdir:\s*(.+?)\s*$/im.exec(pointer);
    if (!match) throw new Error(`Invalid Git worktree pointer: ${dotGit}`);
    const gitDirectory = await realpath(
      path.resolve(workspaceRoot, match[1] as string),
    );
    deniedWrite.push(gitDirectory);
    existing.push(gitDirectory);
    readable.push(gitDirectory);

    try {
      const commonPointer = await readFile(
        path.join(gitDirectory, "commondir"),
        "utf8",
      );
      const commonDirectory = await realpath(
        path.resolve(gitDirectory, commonPointer.trim()),
      );
      deniedWrite.push(commonDirectory);
      existing.push(commonDirectory);
      readable.push(commonDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  return {
    deniedWrite: uniqueRoots(deniedWrite),
    existing: uniqueRoots(existing),
    readable: uniqueRoots(readable),
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
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
  const binding: Array<{ name: string; bytes: number; sha256: string }> = [];
  const readableRoots: string[] = [];
  const names = new Set<string>();
  for (const file of files ?? []) {
    if (names.has(file.name))
      throw new Error(`Duplicate inline file: ${file.name}`);
    names.add(file.name);
    if (!path.isAbsolute(file.path) || file.path.includes("\0")) {
      throw new Error(
        `Inline file path must be absolute without NUL: ${file.name}`,
      );
    }
    const metadata = await lstat(file.path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        `Inline file must be a regular non-symlink file: ${file.name}`,
      );
    }
    const content = await readFile(file.path);
    const digest = createHash("sha256").update(content).digest("hex");
    if (content.byteLength !== file.bytes || digest !== file.sha256) {
      throw new Error(
        `Inline file changed after materialization: ${file.name}`,
      );
    }
    const canonicalPath = await realpath(file.path);
    binding.push({ name: file.name, bytes: file.bytes, sha256: file.sha256 });
    readableRoots.push(path.dirname(canonicalPath));
  }
  return { binding, readableRoots: uniqueRoots(readableRoots) };
}

function buildEnvironment(
  explicit: Readonly<Record<string, string>> | undefined,
  directories: PrivateDirectories,
  developerDirectory: string | undefined,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(explicit ?? {})) {
    if (
      RESERVED_ENVIRONMENT_NAMES.has(name) ||
      RESERVED_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      throw new Error(`Sandbox environment override is reserved: ${name}`);
    }
    environment[name] = value;
  }
  const executablePath = developerDirectory
    ? `${path.join(developerDirectory, "usr", "bin")}:${DEFAULT_PATH}`
    : DEFAULT_PATH;
  return {
    ...environment,
    HOME: directories.home,
    TMPDIR: directories.tmp,
    XDG_CACHE_HOME: directories.cache,
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
  };
}

export class BaselineSandboxLaunchAuthorizer implements SandboxLaunchAuthorizer {
  private readonly workspaceRoots: readonly string[];
  private readonly shell: string;
  private readonly privateDirectoryPrefix: string;
  private readonly homeDirectory: string;
  private readonly trustedRuntimeRoots: readonly string[];

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
    this.trustedRuntimeRoots = [...(options.trustedRuntimeRoots ?? [])];
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
    if (capability.publicNetwork) {
      throw new Error(
        "Public network approval is not available yet; rerun without sandbox_permissions.public_network.",
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
        workspaceRoots.map((root) => resolveGitProtection(root)),
      );
      const policyWriteDenials = workspaceRoots.flatMap((root) =>
        PROTECTED_WORKSPACE_ENTRIES.map((entry) => path.join(root, entry)),
      );
      const existingPolicyRoots = (
        await Promise.all(policyWriteDenials.map(existingCanonicalPath))
      ).filter((entry): entry is string => entry !== undefined);
      const readableGitRoots = gitProtection.flatMap((item) => item.readable);
      const developerToolchain = await resolveDeveloperToolchain();
      const trustedRuntimeRoots = uniqueRoots(
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
            return canonical;
          }),
        ),
      );
      const environment = buildEnvironment(
        options.env,
        directories,
        developerToolchain.developerDirectory,
      );
      const deniedWriteRoots = uniqueRoots([
        ...gitProtection.flatMap((item) => item.deniedWrite),
        ...policyWriteDenials,
        ...RUNTIME_COMPATIBILITY_WRITE_ROOTS,
        path.join(this.homeDirectory, ".npm", "_logs"),
        path.join(this.homeDirectory, ".claude", "debug"),
      ]);
      const protectedReadOnlyRoots = uniqueRoots([
        ...gitProtection.flatMap((item) => item.existing),
        ...existingPolicyRoots,
      ]);
      const readableRoots = uniqueRoots([
        ...workspaceRoots,
        ...SYSTEM_READ_ROOTS,
        ...developerToolchain.readableRoots,
        ...trustedRuntimeRoots,
        ...readableGitRoots,
        ...inlineFiles.readableRoots,
        directories.root,
      ]);
      const binding: SandboxLaunchBindingInput = {
        command: options.command,
        cwd,
        environment,
        inlineFiles: inlineFiles.binding,
        sessionId: options.sandboxSessionId,
        policyVersion: CURRENT_SANDBOX_POLICY_VERSION,
        profileId: PROFILE_ID,
        capability: { publicNetwork: false },
      };
      const authorization: SandboxLaunchAuthorization = {
        bindingDigest: createSandboxLaunchBindingDigest(binding),
        policy: {
          version: CURRENT_SANDBOX_POLICY_VERSION,
          profileId: PROFILE_ID,
          readableRoots,
          writableRoots: uniqueRoots([...workspaceRoots, directories.root]),
          deniedRoots: ["/"],
          deniedWriteRoots,
          protectedReadOnlyRoots,
          network: { mode: "blocked" },
          environment: { inheritHost: false, values: environment },
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
        capabilities: {
          backend: "seatbelt",
          processTree: true,
          filesystemRead: "isolated",
          filesystemWrite: "strict",
          network: "blocked",
          privateHome: true,
          privateTmp: true,
          hostIpcBlocked: true,
          resourceLimits: "partial",
          warnings: [
            "CPU, memory, process-count, and disk quotas are not fully enforced.",
          ],
        },
      };
      return {
        authorization,
        helperRequest,
        metadata,
        finalize: directories.cleanup,
      };
    } catch (error) {
      directories.cleanup();
      throw error;
    }
  }
}
