import { createHash } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  MIN_SANDBOX_NODE_MAJOR_VERSION,
  SANDBOX_INTERACTIVE_HELPER_RELATIVE_PATH,
  SandboxHelperClient,
  checkLinuxSandboxPrerequisites,
  createNodeSandboxHelperTransportFactory,
  linuxSandboxApplySeccompPath,
  type CheckLinuxSandboxPrerequisitesOptions,
  type LinuxSandboxPrerequisites,
  type SandboxManagedNetworkDestination,
  type SandboxRuntimeProvider,
} from "@agentlink/sandbox";
import type { CoreModelToolDefinition } from "@agentlink/core/model-runtime";

type WorkspaceHostModule = typeof import("@agentlink/workspace-host", {
  with: { "resolution-mode": "import" },
});
type WorkspaceProcessLauncher = ReturnType<
  WorkspaceHostModule["createSandboxedWorkspaceProcessLauncher"]
>;
type WorkspaceCommandTools = Awaited<
  ReturnType<WorkspaceHostModule["createWorkspaceCommandTools"]>
>;
type WorkspaceCommandSupervisor = Awaited<
  ReturnType<WorkspaceHostModule["WorkspaceCommandSupervisor"]["create"]>
>;
type WorkspaceProcessLaunch = Parameters<
  WorkspaceProcessLauncher["launchProcess"]
>[0];
type WorkspaceProcessHandle = ReturnType<
  WorkspaceProcessLauncher["launchProcess"]
>;
type WorkspaceProcessLaunchRequest = WorkspaceProcessLaunch["request"];

/**
 * Per-chat sandboxed scratch folders for the Ask Agent helper (Desktop and
 * the browser tab). Each chat gets `<root>/<chat>/work`, created on first
 * use. Commands run through the shared workspace-host command tools in the
 * sandbox (Seatbelt on macOS, bubblewrap on Linux when the host passes
 * `checkLinuxSandboxPrerequisites`): they can write only to that folder and private per-command
 * directories, cannot read the rest of the user's home or other chats, and
 * have loopback-only networking. The sandbox is the security boundary, so
 * calls run without an approval card.
 *
 * Folders the user granted for commands (from this machine only) can also
 * be a command's `cwd`. Those commands use the same workspace-write sandbox
 * as VS Code (host readable, writes only inside the granted folder and
 * temporary directories, Git and agent policy files protected, no network)
 * and every one waits for an approval card, because the folder is real work.
 *
 * A command there can ask for more with `sandbox_permissions`:
 * `require_managed_network` keeps the sandbox but routes the network through
 * its proxy, pausing each public destination for approval; and
 * `require_escalated` runs outside the sandbox as the user. The helper
 * decides who may approve each (escalations only on this computer).
 */

export const ASK_AGENT_SANDBOX_TOOL_NAMES = [
  "execute_command",
  "get_command_output",
  "write_file",
  "present_files",
] as const;
export type AskAgentSandboxToolName =
  (typeof ASK_AGENT_SANDBOX_TOOL_NAMES)[number];

export function isAskAgentSandboxToolName(
  name: string,
): name is AskAgentSandboxToolName {
  return (ASK_AGENT_SANDBOX_TOOL_NAMES as readonly string[]).includes(name);
}

export const ASK_AGENT_SANDBOX_PERMISSIONS = [
  "use_default",
  "require_managed_network",
  "require_escalated",
] as const;
export type AskAgentSandboxPermission =
  (typeof ASK_AGENT_SANDBOX_PERMISSIONS)[number];
const ASK_AGENT_SANDBOX_MAX_REASON_LENGTH = 1_000;
export const ASK_AGENT_SANDBOX_DEFAULT_TIMEOUT_MS = 120_000;
export const ASK_AGENT_SANDBOX_MAX_TIMEOUT_MS = 600_000;
export const ASK_AGENT_SANDBOX_MAX_WORKSPACE_BYTES = 1024 * 1024 * 1024;
export const ASK_AGENT_SANDBOX_MAX_WRITE_BYTES = 5 * 1024 * 1024;
export const ASK_AGENT_SANDBOX_MAX_PRESENTED_FILE_BYTES = 8 * 1024 * 1024;
export const ASK_AGENT_SANDBOX_MAX_PRESENTED_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_PRESENTED_FILES = 10;
const SANDBOX_PATH =
  "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export const ASK_AGENT_SANDBOX_PROMPT = [
  "## Sandboxed scratch folder",
  "",
  "This chat has a private scratch folder. Use write_file to create files there and execute_command to run non-interactive commands in it (for example python3, sqlite3, or shell tools) to analyse data, convert files, or make charts. Paths are relative to the scratch folder. Files the user attached to this chat are copied into inputs/.",
  "",
  "Commands run in a sandbox: they can only write inside the scratch folder, cannot read the user's home folder or other chats, and have no internet access, so package installs such as pip install fail. Prefer tools that are already installed. Read results with read_file, list_files or search_files using scratch-relative paths.",
  "",
  "The user cannot see the scratch folder. To give them a file (an image, CSV, PDF, report and so on), call present_files with its path; it then appears in the chat with a download button. Images are shown inline.",
].join("\n");

export const ASK_AGENT_SANDBOX_TOOLS: readonly CoreModelToolDefinition[] =
  Object.freeze([
    {
      name: "execute_command",
      description:
        "Run an exact non-interactive command with /bin/zsh -c in this chat's sandboxed scratch folder. There is no PTY, stdin, or persistent shell state. The sandbox allows writes only inside the scratch folder, hides the user's home folder, and has no internet access. Returns retained stdout/stderr and the exit state; use get_command_output with the commandId to page longer output.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", minLength: 1, maxLength: 32_000 },
          cwd: {
            type: "string",
            description:
              "Working directory relative to the scratch folder (the default), or an absolute path inside a folder the user granted for commands. Commands in a granted folder wait for the user's approval.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 1,
            maximum: ASK_AGENT_SANDBOX_MAX_TIMEOUT_MS,
            description: `Defaults to ${ASK_AGENT_SANDBOX_DEFAULT_TIMEOUT_MS} ms.`,
          },
          sandbox_permissions: {
            type: "string",
            enum: [...ASK_AGENT_SANDBOX_PERMISSIONS],
            description:
              "Only for commands in a folder granted for commands. use_default (the default): sandboxed with no internet. require_managed_network: sandboxed, but each public internet destination waits for the user's approval (for package installs, downloads, git fetch). require_escalated: runs outside the sandbox with the user's full permissions; only the user at their computer can approve it, so use it only when the sandbox blocks something essential. Give a reason with either.",
          },
          reason: {
            type: "string",
            maxLength: ASK_AGENT_SANDBOX_MAX_REASON_LENGTH,
            description:
              "Short reason shown to the user when the command needs the network or runs outside the sandbox.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    {
      name: "get_command_output",
      description:
        "Read bounded retained stdout/stderr and the current state of a command this chat ran with execute_command.",
      input_schema: {
        type: "object",
        properties: {
          commandId: { type: "string", minLength: 1 },
          offset: { type: "integer", minimum: 0 },
          limitBytes: { type: "integer", minimum: 1, maximum: 1_000_000 },
        },
        required: ["commandId"],
        additionalProperties: false,
      },
    },
    {
      name: "write_file",
      description:
        "Create or overwrite a text file in this chat's sandboxed scratch folder. The path is relative to the scratch folder; missing parent folders are created. Cannot write anywhere else.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    {
      name: "present_files",
      description: `Show files from this chat's scratch folder to the user as downloadable results. Images (PNG, JPEG, GIF, WebP) are previewed inline. Up to ${MAX_PRESENTED_FILES} files, ${ASK_AGENT_SANDBOX_MAX_PRESENTED_FILE_BYTES / (1024 * 1024)} MiB each and ${ASK_AGENT_SANDBOX_MAX_PRESENTED_TOTAL_BYTES / (1024 * 1024)} MiB in total.`,
      input_schema: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            maxItems: MAX_PRESENTED_FILES,
          },
        },
        required: ["paths"],
        additionalProperties: false,
      },
    },
  ]);

/**
 * Prompt section for folders granted for commands, or undefined when none
 * are. Listed so the model knows which absolute `cwd` values are allowed.
 */
export function askAgentCommandFoldersPrompt(
  roots: readonly string[],
): string | undefined {
  if (roots.length === 0) return undefined;
  return [
    "## Folders granted for commands",
    "",
    "The user granted these folders for commands. To run a command in one, pass its absolute path (or a folder inside it) as execute_command's cwd:",
    ...roots.map((root) => `- ${root}`),
    "",
    "A command there may wait for the user to approve it (saved rules or Approve for Me can let it run straight away, and saved rules can refuse it), so run one focused command at a time and explain why. Commands run in a sandbox: they can read files on this computer but only write inside the granted folder and temporary folders, cannot change the folder's Git metadata or agent instruction files, and have no internet access. write_file and present_files still only work in the scratch folder.",
    "",
    'When a command in a granted folder needs the internet (installing packages, downloading, git fetch), pass sandbox_permissions: "require_managed_network" with a reason; each new destination then waits for the user\'s approval. Only when the sandbox blocks something essential, pass sandbox_permissions: "require_escalated" with a reason to run it outside the sandbox with the user\'s full permissions. The user must approve that on their computer, so they may not be able to from a phone.',
  ].join("\n");
}

/** What the user is asked to approve for a command in a granted folder. */
export interface AskAgentCommandApprovalProposal {
  /** The chat asking, for chat-scoped rules. */
  readonly sessionId: string;
  readonly command: string;
  readonly cwd: string;
  /** The granted folder the command can write to. */
  readonly root: string;
  readonly timeoutMs: number;
  /**
   * `loopback` on macOS, where the sandbox still allows connections to
   * services on this computer; `none` on Linux, where each command has a
   * private network namespace; `approved-destinations` when the command
   * asked for the network and each public destination asks first; `full`
   * outside the sandbox.
   */
  readonly network: "none" | "loopback" | "approved-destinations" | "full";
  /**
   * `unsandboxed` runs as the user with full access. Saved rules and
   * Approve for Me never approve it, and only this computer can.
   */
  readonly sandbox: "workspace-write" | "unsandboxed";
  /** The model's reason, when it asked for the network or to escalate. */
  readonly reason?: string;
}

/** A public destination a granted-folder command is connecting to. */
export interface AskAgentNetworkApprovalProposal {
  readonly sessionId: string;
  /** The workspace command ID of the command connecting. */
  readonly commandId: string;
  readonly command: string;
  readonly cwd: string;
  readonly root: string;
  readonly reason?: string;
  readonly destination: SandboxManagedNetworkDestination;
  /**
   * Aborted when the command's tool call returns (it exited, timed out or
   * was stopped). An answer after that must not allow or save anything.
   */
  readonly signal: AbortSignal;
}

type GrantedLaunchMode = "network" | "unsandboxed";

/** How an approved command in a granted folder launches, keyed by command ID. */
interface GrantedLaunchContext {
  readonly mode: GrantedLaunchMode;
  readonly root: string;
  readonly command: string;
  readonly cwd: string;
  readonly reason?: string;
  readonly requestNetworkApproval?: (
    proposal: AskAgentNetworkApprovalProposal,
  ) => Promise<"allow-once" | "reject">;
  /** Aborted when the context is removed. */
  readonly ended: AbortController;
}

const NESTED_REPOSITORY_SCAN_MAX_DIRECTORIES = 20_000;
const NESTED_REPOSITORY_SCAN_MAX_DEPTH = 8;

/**
 * The sandbox protects Git metadata and agent instruction files only at the
 * top of a writable root, so a commands grant must not contain other
 * repositories. Returns the first nested `.git` found, `too_large` when the
 * folder is too big to check, or undefined. Symlinks and `node_modules` are
 * not followed.
 */
export async function findNestedRepository(
  root: string,
): Promise<string | "too_large" | undefined> {
  let scanned = 0;
  let level = [root];
  for (
    let depth = 0;
    depth < NESTED_REPOSITORY_SCAN_MAX_DEPTH && level.length > 0;
    depth += 1
  ) {
    const next: string[] = [];
    for (const directory of level) {
      scanned += 1;
      if (scanned > NESTED_REPOSITORY_SCAN_MAX_DIRECTORIES) return "too_large";
      const entries = await fs
        .readdir(directory, { withFileTypes: true })
        .catch(() => []);
      for (const entry of entries) {
        const child = path.join(directory, entry.name);
        if (entry.name === ".git") {
          if (directory !== root) return child;
          continue;
        }
        if (
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          entry.name !== "node_modules"
        ) {
          next.push(child);
        }
      }
    }
    level = next;
  }
  return undefined;
}

export type AskAgentCommandApprovalDecision =
  | { readonly decision: "run" }
  | { readonly decision: "edit"; readonly command: string }
  | { readonly decision: "reject"; readonly reason?: string }
  /** Refused by policy (for example a Forbidden rule), without a card. */
  | { readonly decision: "deny"; readonly reason: string };

export interface AskAgentSandboxInputFile {
  readonly name: string;
  readonly base64: string;
}

export interface AskAgentSandboxToolResult {
  readonly content: string;
  readonly isError: boolean;
  readonly resultImages?: Array<{ mimeType: string; data: string }>;
  readonly resultDocuments?: Array<{
    name: string;
    mimeType: string;
    data: string;
  }>;
}

export interface AskAgentSandboxWorkspaceOptions {
  /** Parent of every chat's folder, e.g. `~/.agentlink/ask-agent-sandboxes`. */
  readonly rootDirectory: string;
  /** Where `dist/sandbox-runtime` is staged (extension or Desktop runtime root). */
  readonly extensionRoot: string;
  /** Defaults to `process.execPath`. */
  readonly nodeExecutable?: string;
  /** Defaults to `ELECTRON_RUN_AS_NODE=1` when running under Electron. */
  readonly helperEnvironment?: Readonly<Record<string, string>>;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly maxWorkspaceBytes?: number;
  /**
   * Linux only: an absolute ripgrep the sandbox uses to expand deny paths.
   * Used when executable; otherwise `/usr/bin/rg`.
   */
  readonly ripgrepPath?: string;
  /** Linux only: log sink for the sandbox prerequisite check. */
  readonly log?: (message: string) => void;
  /** Test seam replacing the Linux sandbox doctor. */
  readonly checkLinuxPrerequisites?: (
    options: CheckLinuxSandboxPrerequisitesOptions,
  ) => Promise<LinuxSandboxPrerequisites>;
  /**
   * Environment for commands in granted folders. Defaults to this process's
   * environment (Desktop starts the helper with the login-shell PATH) minus
   * helper-only variables; the sandbox also drops KEY/SECRET/TOKEN names.
   */
  readonly hostEnvironment?: () => NodeJS.ProcessEnv;
  /**
   * Test seam replacing the sandboxed launcher. Called once per chat for the
   * scratch folder, and once per chat and granted folder with `grantedRoot`
   * set (then `workDirectory` is that folder).
   */
  readonly createProcessLauncher?: (options: {
    readonly workDirectory: string;
    readonly deniedReadRoots: readonly string[];
    readonly trustedRuntimeRoots: readonly string[];
    readonly grantedRoot?: string;
    /**
     * For a granted folder: `network` sandboxes with the public proxy and
     * passes `onNetworkRequest`; `unsandboxed` runs outside the sandbox.
     */
    readonly mode?: GrantedLaunchMode;
    readonly onNetworkRequest?: (
      destination: SandboxManagedNetworkDestination,
      request: WorkspaceProcessLaunchRequest,
    ) => Promise<"allow-once" | "reject">;
  }) => WorkspaceProcessLauncher | Promise<WorkspaceProcessLauncher>;
}

interface GrantedFolder {
  readonly launcher: WorkspaceProcessLauncher;
  readonly commandTools: WorkspaceCommandTools;
  /** Launchers for commands approved with more access, created on use. */
  readonly launcherFor: (
    mode: GrantedLaunchMode,
  ) => Promise<WorkspaceProcessLauncher>;
}

interface ChatSandbox {
  readonly sessionId: string;
  readonly workDirectory: string;
  readonly stateDirectory: string;
  readonly supervisor: WorkspaceCommandSupervisor;
  readonly commandTools: WorkspaceCommandTools;
  /** Keyed by canonical granted root; removed when the grant is revoked. */
  readonly granted: Map<string, Promise<GrantedFolder>>;
  /**
   * Commands approved for the network or to run unsandboxed, keyed by
   * command ID while their tool call runs. Any other launch is sandboxed
   * without internet.
   */
  readonly launchModes: Map<string, GrantedLaunchContext>;
}

const OWNER_ID = "ask-agent-sandbox";
const PRINCIPAL = { tenantId: "local", subjectId: "ask-agent" };
const MODEL = {
  model: { providerId: "ask-agent", modelId: "ask-agent" },
  source: "runtime" as const,
};
/** Helper-process variables that must not leak into user commands. */
const HELPER_ONLY_ENVIRONMENT =
  /^(ELECTRON_|NODE_PATH$|NODE_OPTIONS$|AGENTLINK_)/;

/** Forget an approved launch mode and withdraw its open network requests. */
function endLaunch(chat: ChatSandbox, launchId: string): void {
  chat.launchModes.get(launchId)?.ended.abort();
  chat.launchModes.delete(launchId);
}

function refusedLaunch(error: Error): WorkspaceProcessHandle {
  const started = Promise.reject(error);
  started.catch(() => undefined);
  return {
    pid: undefined,
    started,
    exited: Promise.resolve({}),
    signal: () => true,
  };
}

interface SandboxToolRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolName: AskAgentSandboxToolName;
  readonly input: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  /**
   * Canonical folders currently granted for commands. Read per call so a
   * revoked grant stops applying immediately.
   */
  readonly commandRoots?: readonly string[];
  /** Ask the user about a command in a granted folder. */
  readonly requestApproval?: (
    proposal: AskAgentCommandApprovalProposal,
  ) => Promise<AskAgentCommandApprovalDecision>;
  /** Ask the user about a public destination an approved command connects to. */
  readonly requestNetworkApproval?: (
    proposal: AskAgentNetworkApprovalProposal,
  ) => Promise<"allow-once" | "reject">;
  /**
   * Whether a folder is still granted for commands, checked again just
   * before launch so a grant revoked during the call is not used.
   */
  readonly isCommandRootGranted?: (root: string) => Promise<boolean>;
}

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".html": "text/html",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function mimeTypeFor(filePath: string): string {
  return (
    MIME_TYPES[path.extname(filePath).toLowerCase()] ??
    "application/octet-stream"
  );
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorResult(error: string): AskAgentSandboxToolResult {
  return { content: JSON.stringify({ error }), isError: true };
}

function safeFileName(name: string): string {
  const base = path
    .basename(name)
    .replace(/[^A-Za-z0-9._ -]+/g, "_")
    .trim();
  return base && base !== "." && base !== ".." ? base.slice(0, 120) : "file";
}

export class AskAgentSandboxWorkspace {
  private readonly platform: NodeJS.Platform;
  private readonly homeDirectory: string;
  private readonly maxWorkspaceBytes: number;
  private readonly chats = new Map<string, Promise<ChatSandbox>>();
  /** Clock value at each folder's latest command-grant revocation. */
  private readonly commandRootRevocations = new Map<string, number>();
  private revocationClock = 0;
  private runtime: SandboxRuntimeProvider | undefined;
  private workspaceHost: Promise<WorkspaceHostModule> | undefined;
  private digestSecrets: Map<string, string> | undefined;
  private linuxCheck:
    | Promise<{ available: boolean; ripgrepPath: string | undefined }>
    | undefined;

  constructor(private readonly options: AskAgentSandboxWorkspaceOptions) {
    this.platform = options.platform ?? process.platform;
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    this.maxWorkspaceBytes =
      options.maxWorkspaceBytes ?? ASK_AGENT_SANDBOX_MAX_WORKSPACE_BYTES;
  }

  /**
   * macOS, or Linux when the bubblewrap prerequisites pass, with the packaged
   * sandbox helper staged next to the host. The Linux check runs once per
   * process, so installing a missing tool takes effect after a restart.
   */
  async isAvailable(): Promise<boolean> {
    if (this.platform !== "darwin" && this.platform !== "linux") return false;
    if (
      !this.options.createProcessLauncher &&
      !existsSync(
        path.join(
          this.options.extensionRoot,
          SANDBOX_INTERACTIVE_HELPER_RELATIVE_PATH,
        ),
      )
    ) {
      return false;
    }
    if (this.platform === "darwin") return true;
    return (await this.checkLinuxHost()).available;
  }

  private checkLinuxHost(): Promise<{
    available: boolean;
    ripgrepPath: string | undefined;
  }> {
    this.linuxCheck ??= (async () => {
      const check =
        this.options.checkLinuxPrerequisites ?? checkLinuxSandboxPrerequisites;
      const requestedRipgrep = this.options.ripgrepPath;
      // The helper runs on this process's Node unless one is configured;
      // Electron's is new enough, but distro Node (Ubuntu 24.04: 18) may not be.
      const nodeMajor = Number(process.versions.node.split(".")[0]);
      if (
        !this.options.nodeExecutable &&
        nodeMajor < MIN_SANDBOX_NODE_MAJOR_VERSION
      ) {
        this.options.log?.(
          `[ask-agent-sandbox] Linux sandbox needs Node.js ${MIN_SANDBOX_NODE_MAJOR_VERSION} or later; this helper runs ${process.version}.`,
        );
        return { available: false, ripgrepPath: undefined };
      }
      try {
        const result = await check({
          runtimeRoot: path.join(
            this.options.extensionRoot,
            "dist",
            "sandbox-runtime",
          ),
          ...(requestedRipgrep ? { ripgrepPath: requestedRipgrep } : {}),
        });
        for (const item of result.checks) {
          this.options.log?.(
            `[ask-agent-sandbox] Linux sandbox check ${item.id}: ${item.status}, ${item.detail}${item.fix ? ` Fix: ${item.fix}` : ""}`,
          );
        }
        // The doctor and the helper fall back to /usr/bin/rg; pass the
        // requested ripgrep only when the doctor chose it.
        const ripgrep = result.checks.find((item) => item.id === "ripgrep");
        return {
          available: result.available,
          ripgrepPath:
            requestedRipgrep && ripgrep?.detail === requestedRipgrep
              ? requestedRipgrep
              : undefined,
        };
      } catch (error) {
        this.options.log?.(
          `[ask-agent-sandbox] Linux sandbox check failed: ${errorMessage(error)}`,
        );
        return { available: false, ripgrepPath: undefined };
      }
    })();
    return this.linuxCheck;
  }

  /** The chat's folder (not created). */
  chatDirectory(sessionId: string): string {
    const segment = SAFE_SESSION_ID.test(sessionId)
      ? sessionId
      : createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
    return path.join(this.options.rootDirectory, segment);
  }

  workDirectory(sessionId: string): string {
    return path.join(this.chatDirectory(sessionId), "work");
  }

  /** The chat's work folder when it already exists, canonicalised. */
  async existingWorkDirectory(sessionId: string): Promise<string | undefined> {
    return await fs
      .realpath(this.workDirectory(sessionId))
      .catch(() => undefined);
  }

  /** Copy attachments into `work/inputs/`, keeping existing files. */
  async syncInputs(
    sessionId: string,
    files: readonly AskAgentSandboxInputFile[],
  ): Promise<void> {
    if (files.length === 0) return;
    const work = await this.ensureWorkDirectory(sessionId);
    const inputs = path.join(work, "inputs");
    await fs.mkdir(inputs, { recursive: true, mode: 0o700 });
    const used = new Set<string>();
    for (const file of files) {
      let name = safeFileName(file.name);
      for (let index = 2; used.has(name); index += 1) {
        const extension = path.extname(name);
        name = `${path.basename(name, extension)}-${index}${extension}`;
      }
      used.add(name);
      const target = path.join(inputs, name);
      const handle = await fs
        .open(
          target,
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            fsConstants.O_NOFOLLOW,
          0o600,
        )
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST") return undefined;
          throw error;
        });
      if (!handle) continue;
      try {
        await handle.writeFile(Buffer.from(file.base64, "base64"));
      } finally {
        await handle.close();
      }
    }
  }

  async execute(
    request: SandboxToolRequest,
  ): Promise<AskAgentSandboxToolResult> {
    try {
      switch (request.toolName) {
        case "write_file":
          return await this.writeFile(request.sessionId, request.input);
        case "present_files":
          return await this.presentFiles(request.sessionId, request.input);
        default:
          return await this.runCommandTool(request);
      }
    } catch (error) {
      return errorResult(errorMessage(error));
    }
  }

  /**
   * Stop applying a revoked command grant: later launches there are refused
   * and commands still running inside it are stopped.
   */
  async revokeCommandRoot(root: string): Promise<void> {
    // Recorded before any await, so a call that began earlier with a stale
    // list of roots cannot recreate this folder's launcher.
    this.commandRootRevocations.set(root, ++this.revocationClock);
    await Promise.all(
      [...this.chats.values()].map(async (pending) => {
        const chat = await pending.catch(() => undefined);
        if (!chat) return;
        chat.granted.delete(root);
        const running = chat.supervisor
          .list({ ownerId: OWNER_ID })
          .filter(
            (record) =>
              (record.state === "running" || record.state === "interrupted") &&
              isInside(record.cwd, root),
          );
        await Promise.all(
          running.map((record) =>
            chat.supervisor
              .stop(record.commandId, { ownerId: OWNER_ID })
              .catch(() => undefined),
          ),
        );
      }),
    );
  }

  async deleteChat(sessionId: string): Promise<void> {
    const chat = this.chats.get(sessionId);
    this.chats.delete(sessionId);
    if (chat) {
      await chat
        .then((sandbox) => sandbox.supervisor.close())
        .catch(() => undefined);
    }
    await fs.rm(this.chatDirectory(sessionId), {
      recursive: true,
      force: true,
    });
  }

  async dispose(): Promise<void> {
    const chats = [...this.chats.values()];
    this.chats.clear();
    await Promise.all(
      chats.map((chat) =>
        chat
          .then((sandbox) => sandbox.supervisor.close())
          .catch(() => undefined),
      ),
    );
    this.runtime?.dispose();
    this.runtime = undefined;
  }

  private async ensureWorkDirectory(sessionId: string): Promise<string> {
    const work = this.workDirectory(sessionId);
    await fs.mkdir(work, { recursive: true, mode: 0o700 });
    return await fs.realpath(work);
  }

  private deniedReadRoots(): string[] {
    return [
      ...new Set([
        this.homeDirectory,
        this.platform === "linux" ? "/home" : "/Users",
      ]),
    ];
  }

  private async resolveInside(
    work: string,
    requested: unknown,
    label: string,
  ): Promise<string> {
    if (typeof requested !== "string" || !requested.trim()) {
      throw new Error(`${label}_required`);
    }
    const text = requested.trim();
    const candidate = path.isAbsolute(text)
      ? path.resolve(text)
      : path.resolve(work, text);
    if (!isInside(candidate, work)) {
      throw new Error(`${label}_outside_scratch_folder`);
    }
    return candidate;
  }

  private async workspaceBytes(work: string): Promise<number> {
    let total = 0;
    const pending = [work];
    let visited = 0;
    while (pending.length > 0 && visited < 100_000) {
      const directory = pending.pop()!;
      const entries = await fs
        .readdir(directory, { withFileTypes: true })
        .catch(() => []);
      for (const entry of entries) {
        visited += 1;
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(entryPath);
        else if (entry.isFile()) {
          total +=
            (await fs.lstat(entryPath).catch(() => undefined))?.size ?? 0;
        }
      }
    }
    return total;
  }

  private async assertUnderQuota(work: string): Promise<void> {
    if ((await this.workspaceBytes(work)) > this.maxWorkspaceBytes) {
      throw new Error(
        `scratch_folder_over_quota: this chat's scratch folder uses more than ${Math.round(this.maxWorkspaceBytes / (1024 * 1024))} MiB; delete files before running more commands`,
      );
    }
  }

  private async writeFile(
    sessionId: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<AskAgentSandboxToolResult> {
    if (typeof input.content !== "string") {
      return errorResult("content_required");
    }
    const bytes = Buffer.from(input.content, "utf8");
    if (bytes.byteLength > ASK_AGENT_SANDBOX_MAX_WRITE_BYTES) {
      return errorResult("content_too_large");
    }
    const work = await this.ensureWorkDirectory(sessionId);
    await this.assertUnderQuota(work);
    const target = await this.resolveInside(work, input.path, "path");
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const parent = await fs.realpath(path.dirname(target));
    if (!isInside(parent, work)) {
      return errorResult("path_outside_scratch_folder");
    }
    const handle = await fs.open(
      path.join(parent, path.basename(target)),
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      if (!(await handle.stat()).isFile()) {
        return errorResult("path_not_a_regular_file");
      }
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    return {
      content: JSON.stringify({
        ok: true,
        path: path.relative(work, path.join(parent, path.basename(target))),
        bytes: bytes.byteLength,
      }),
      isError: false,
    };
  }

  private async presentFiles(
    sessionId: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<AskAgentSandboxToolResult> {
    const paths = input.paths;
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      paths.length > MAX_PRESENTED_FILES
    ) {
      return errorResult(`paths must list 1-${MAX_PRESENTED_FILES} files`);
    }
    const work = await this.existingWorkDirectory(sessionId);
    if (!work) return errorResult("scratch_folder_empty");
    const resultImages: Array<{ mimeType: string; data: string }> = [];
    const resultDocuments: Array<{
      name: string;
      mimeType: string;
      data: string;
    }> = [];
    const presented: Array<{ path: string; bytes: number; mimeType: string }> =
      [];
    let total = 0;
    for (const requested of paths) {
      const candidate = await this.resolveInside(work, requested, "path");
      const real = await fs.realpath(candidate).catch(() => undefined);
      if (!real || !isInside(real, work)) {
        return errorResult(`file_not_found: ${String(requested)}`);
      }
      const stat = await fs.stat(real);
      if (!stat.isFile()) {
        return errorResult(`not_a_file: ${String(requested)}`);
      }
      if (stat.size > ASK_AGENT_SANDBOX_MAX_PRESENTED_FILE_BYTES) {
        return errorResult(`file_too_large: ${String(requested)}`);
      }
      total += stat.size;
      if (total > ASK_AGENT_SANDBOX_MAX_PRESENTED_TOTAL_BYTES) {
        return errorResult("files_too_large_in_total");
      }
      const data = (await fs.readFile(real)).toString("base64");
      const mimeType = mimeTypeFor(real);
      const relative = path.relative(work, real);
      if (INLINE_IMAGE_TYPES.has(mimeType)) {
        resultImages.push({ mimeType, data });
      } else {
        resultDocuments.push({ name: path.basename(real), mimeType, data });
      }
      presented.push({ path: relative, bytes: stat.size, mimeType });
    }
    return {
      content: JSON.stringify({ ok: true, presented }),
      isError: false,
      ...(resultImages.length > 0 ? { resultImages } : {}),
      ...(resultDocuments.length > 0 ? { resultDocuments } : {}),
    };
  }

  /** The granted root containing an absolute `cwd`, or why there is none. */
  private async grantedRootFor(
    work: string,
    cwd: unknown,
    commandRoots: readonly string[],
  ): Promise<{ root?: string; relativeCwd?: string; error?: string }> {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd.trim())) return {};
    const real = await fs.realpath(cwd.trim()).catch(() => undefined);
    if (!real) return { error: "cwd_not_found" };
    if (isInside(real, work)) return {};
    // The deepest grant wins when grants nest.
    const root = commandRoots
      .filter((candidate) => isInside(real, candidate))
      .sort((left, right) => right.length - left.length)[0];
    return root
      ? { root, relativeCwd: path.relative(root, real) || "." }
      : {
          error:
            "cwd_not_granted: commands run in the scratch folder or in a folder the user granted for commands",
        };
  }

  private async runCommandTool(
    request: SandboxToolRequest,
  ): Promise<AskAgentSandboxToolResult> {
    if (request.toolName === "execute_command") {
      if (request.input.background === true) {
        return errorResult(
          "background commands are not available in the Ask Agent sandbox",
        );
      }
      const timeoutMs = request.input.timeoutMs;
      if (
        timeoutMs !== undefined &&
        (typeof timeoutMs !== "number" ||
          timeoutMs > ASK_AGENT_SANDBOX_MAX_TIMEOUT_MS)
      ) {
        return errorResult(
          `timeoutMs must be at most ${ASK_AGENT_SANDBOX_MAX_TIMEOUT_MS}`,
        );
      }
    }
    let permission: AskAgentSandboxPermission = "use_default";
    let reason: string | undefined;
    let input = request.input;
    if (request.toolName === "execute_command") {
      const {
        sandbox_permissions: requestedPermission,
        reason: requestedReason,
        ...rest
      } = request.input;
      input = rest;
      if (requestedPermission !== undefined) {
        if (
          !(ASK_AGENT_SANDBOX_PERMISSIONS as readonly unknown[]).includes(
            requestedPermission,
          )
        ) {
          return errorResult(
            `sandbox_permissions must be one of ${ASK_AGENT_SANDBOX_PERMISSIONS.join(", ")}`,
          );
        }
        permission = requestedPermission as AskAgentSandboxPermission;
      }
      if (requestedReason !== undefined) {
        if (
          typeof requestedReason !== "string" ||
          requestedReason.length > ASK_AGENT_SANDBOX_MAX_REASON_LENGTH
        ) {
          return errorResult(
            `reason must be a string of at most ${ASK_AGENT_SANDBOX_MAX_REASON_LENGTH} characters`,
          );
        }
        reason = requestedReason.trim() || undefined;
      }
    }
    const startedAt = this.revocationClock;
    const sandbox = await this.chatSandbox(request.sessionId);
    let grantedRoot: string | undefined;
    if (request.toolName === "execute_command") {
      const granted = await this.grantedRootFor(
        sandbox.workDirectory,
        input.cwd,
        request.commandRoots ?? [],
      );
      if (granted.error) return errorResult(granted.error);
      grantedRoot = granted.root;
      if (grantedRoot) {
        // Workspace command tools take a cwd relative to their project.
        input = { ...input, cwd: granted.relativeCwd };
      } else {
        await this.assertUnderQuota(sandbox.workDirectory);
      }
      if (permission !== "use_default") {
        if (!grantedRoot) {
          return errorResult(
            "sandbox_permissions_need_granted_folder: scratch-folder commands always run in the sandbox without internet; network access and running outside the sandbox are only available in folders the user granted for commands",
          );
        }
        if (
          !request.requestApproval ||
          (permission === "require_managed_network" &&
            !request.requestNetworkApproval)
        ) {
          return errorResult("command_requires_approval");
        }
      }
    }
    const commandTools = grantedRoot
      ? (await this.grantedFolder(sandbox, grantedRoot)).commandTools
      : sandbox.commandTools;
    const principal = PRINCIPAL;
    const discovery = {
      principal,
      sessionId: request.sessionId,
      turnId: request.turnId,
      input: { text: "", attachments: undefined },
    };
    const tools = await commandTools.resolveTools(discovery);
    const tool = tools.find(
      (candidate) => candidate.definition.name === request.toolName,
    );
    if (!tool) return errorResult(`unknown_tool:${request.toolName}`);
    const validation = tool.validate({
      ...input,
      ...(request.toolName === "execute_command" &&
      input.timeoutMs === undefined
        ? { timeoutMs: ASK_AGENT_SANDBOX_DEFAULT_TIMEOUT_MS }
        : {}),
    });
    if (!validation.valid) {
      return errorResult(
        `invalid_input: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
      );
    }
    const model = MODEL;
    let executable = validation.input;
    let launchId: string | undefined;
    if (request.toolName === "execute_command") {
      const authorize = (candidate: Readonly<Record<string, unknown>>) =>
        commandTools.authorizeToolCall({
          ...discovery,
          model,
          toolCallId: request.turnId,
          toolName: "execute_command",
          input: candidate,
          effect: "write",
        });
      const authorization = await authorize(validation.input);
      if (authorization.decision === "deny") {
        return errorResult(authorization.reason ?? "command_denied");
      }
      if (authorization.decision === "allow") {
        // More access than the default sandbox is always the helper's call.
        if (grantedRoot && permission !== "use_default") {
          return errorResult("command_requires_approval");
        }
        executable = { ...(authorization.preparedInput ?? validation.input) };
      } else if (
        authorization.decision === "require_user" &&
        grantedRoot &&
        request.requestApproval
      ) {
        const approved = await this.approveGrantedCommand({
          request,
          root: grantedRoot,
          commandTools,
          authorization,
          permission,
          reason,
          reauthorize: (command) => authorize({ ...validation.input, command }),
        });
        if ("result" in approved) return approved.result;
        executable = approved.input;
      } else {
        return errorResult("command_requires_approval");
      }
      if (permission !== "use_default" && grantedRoot) {
        const launch = executable.launch as
          | {
              readonly commandId?: unknown;
              readonly command?: unknown;
              readonly cwd?: unknown;
            }
          | undefined;
        if (typeof launch?.commandId !== "string") {
          return errorResult("command_requires_approval");
        }
        launchId = launch.commandId;
        sandbox.launchModes.set(launchId, {
          mode: permission === "require_escalated" ? "unsandboxed" : "network",
          root: grantedRoot,
          command:
            typeof launch.command === "string"
              ? launch.command
              : String(input.command),
          cwd: typeof launch.cwd === "string" ? launch.cwd : grantedRoot,
          ...(reason ? { reason } : {}),
          ...(request.requestNetworkApproval
            ? { requestNetworkApproval: request.requestNetworkApproval }
            : {}),
          ended: new AbortController(),
        });
      }
      if (
        grantedRoot &&
        !(await this.isStillGranted(grantedRoot, startedAt, request))
      ) {
        // Drop a launcher this stale call may have recreated.
        sandbox.granted.delete(grantedRoot);
        if (launchId) endLaunch(sandbox, launchId);
        return errorResult(
          "cwd_not_granted: this folder's command grant was revoked",
        );
      }
    }
    let result: Awaited<ReturnType<typeof tool.executeValidated>>;
    try {
      result = await tool.executeValidated(executable, {
        principal,
        sessionId: request.sessionId,
        turnId: request.turnId,
        model,
        signal: request.signal,
      });
    } finally {
      // Later network requests from a command still running after this
      // call returned are refused, and open ones are withdrawn.
      if (launchId) endLaunch(sandbox, launchId);
    }
    return {
      content:
        typeof result.modelContent === "string"
          ? result.modelContent
          : JSON.stringify(result.modelContent),
      isError: result.isError === true,
    };
  }

  private chatSandbox(sessionId: string): Promise<ChatSandbox> {
    let chat = this.chats.get(sessionId);
    if (!chat) {
      chat = this.createChatSandbox(sessionId);
      this.chats.set(sessionId, chat);
      chat.catch(() => {
        if (this.chats.get(sessionId) === chat) this.chats.delete(sessionId);
      });
    }
    return chat;
  }

  private async createChatSandbox(sessionId: string): Promise<ChatSandbox> {
    if (!(await this.isAvailable())) {
      throw new Error("ask_agent_sandbox_unavailable");
    }
    const ripgrepPath =
      this.platform === "linux"
        ? (await this.checkLinuxHost()).ripgrepPath
        : undefined;
    const workDirectory = await this.ensureWorkDirectory(sessionId);
    const stateDirectory = path.join(this.chatDirectory(sessionId), "state");
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const host = await this.loadWorkspaceHost();
    const deniedReadRoots = this.deniedReadRoots();
    const trustedRuntimeRoots = this.trustedRuntimeRoots();
    const scratchLauncher = this.options.createProcessLauncher
      ? await this.options.createProcessLauncher({
          workDirectory,
          deniedReadRoots,
          trustedRuntimeRoots,
        })
      : host.createSandboxedWorkspaceProcessLauncher({
          runtime: this.sandboxRuntime(ripgrepPath),
          platform: this.platform,
          writableRoots: [workDirectory],
          deniedReadRoots,
          trustedRuntimeRoots,
          temporaryHome: true,
          shareHostTemporaryDirectories: false,
          homeDirectory: this.homeDirectory,
          fallbackShell: "/bin/sh",
        });
    const locale = this.platform === "linux" ? "C.UTF-8" : "en_US.UTF-8";
    const granted = new Map<string, Promise<GrantedFolder>>();
    const launchModes = new Map<string, GrantedLaunchContext>();
    // One supervisor per chat, so get_command_output finds commands from the
    // scratch folder and granted folders alike. Each launch goes to the
    // launcher for the root its cwd is in; a revoked grant has no launcher.
    // A command approved for more access uses that root's matching launcher.
    const routingLauncher: WorkspaceProcessLauncher = {
      launchProcess: (launch: WorkspaceProcessLaunch) => {
        const cwd = launch.request.cwd;
        if (isInside(cwd, workDirectory)) {
          return scratchLauncher.launchProcess(launch);
        }
        const root = [...granted.keys()]
          .filter((candidate) => isInside(cwd, candidate))
          .sort((left, right) => right.length - left.length)[0];
        const folder = root ? granted.get(root) : undefined;
        if (!folder) {
          return refusedLaunch(
            new host.WorkspaceProcessLaunchError("cwd_not_granted"),
          );
        }
        const context = launchModes.get(launch.request.operationId);
        const mode = context?.root === root ? context.mode : undefined;
        const started = folder.then(async (resolved) =>
          (mode
            ? await resolved.launcherFor(mode)
            : resolved.launcher
          ).launchProcess(launch),
        );
        return {
          get pid() {
            return undefined;
          },
          started: started.then((handle) => handle.started),
          exited: started.then(
            (handle) => handle.exited,
            () => ({}),
          ),
          signal: (signal) => {
            void started.then(
              (handle) => handle.signal(signal),
              () => undefined,
            );
            return true;
          },
        };
      },
    };
    const supervisor = await host.WorkspaceCommandSupervisor.create({
      stateDirectory,
      ownerId: OWNER_ID,
      executionBackend: routingLauncher,
    });
    const commandTools = await host.createWorkspaceCommandTools({
      projectRoot: workDirectory,
      ownerId: OWNER_ID,
      supervisor,
      mutations: new host.WorkspaceMutationCoordinator(),
      stateDirectory,
      shellExecutable: this.shellExecutable(),
      sandboxed: true,
      environmentDigestSecret: this.environmentDigestSecret(sessionId),
      resolveEnvironment: () => ({
        PATH: SANDBOX_PATH,
        LANG: locale,
        LC_ALL: locale,
        TERM: "dumb",
        MPLBACKEND: "Agg",
      }),
      // Every command is confined by the sandbox, which is the boundary here.
      hasSessionGrant: () => true,
    });
    return {
      sessionId,
      workDirectory,
      stateDirectory,
      supervisor,
      commandTools,
      granted,
      launchModes,
    };
  }

  /**
   * Answer a public destination from a granted-folder command: only a
   * command whose tool call is still running and was approved for the
   * network can ask; anything else is refused.
   */
  private answerNetworkRequest(
    chat: ChatSandbox,
    root: string,
    destination: SandboxManagedNetworkDestination,
    launch: WorkspaceProcessLaunchRequest,
  ): Promise<"allow-once" | "reject"> {
    const context = chat.launchModes.get(launch.operationId);
    if (
      !context ||
      context.mode !== "network" ||
      context.root !== root ||
      !context.requestNetworkApproval ||
      context.ended.signal.aborted
    ) {
      return Promise.resolve("reject");
    }
    const signal = context.ended.signal;
    return context
      .requestNetworkApproval({
        sessionId: chat.sessionId,
        commandId: launch.operationId,
        command: context.command,
        cwd: context.cwd,
        root,
        ...(context.reason ? { reason: context.reason } : {}),
        destination,
        signal,
      })
      .then((answer) => (signal.aborted ? "reject" : answer))
      .catch(() => "reject" as const);
  }

  private async isStillGranted(
    root: string,
    startedAt: number,
    request: SandboxToolRequest,
  ): Promise<boolean> {
    if ((this.commandRootRevocations.get(root) ?? 0) > startedAt) return false;
    if (
      request.isCommandRootGranted &&
      !(await request.isCommandRootGranted(root))
    ) {
      return false;
    }
    return (this.commandRootRevocations.get(root) ?? 0) <= startedAt;
  }

  /** Command tools for one granted folder in one chat, created on first use. */
  private grantedFolder(
    chat: ChatSandbox,
    root: string,
  ): Promise<GrantedFolder> {
    let folder = chat.granted.get(root);
    if (!folder) {
      folder = this.createGrantedFolder(chat, root);
      chat.granted.set(root, folder);
      folder.catch(() => {
        if (chat.granted.get(root) === folder) chat.granted.delete(root);
      });
    }
    return folder;
  }

  private async createGrantedFolder(
    chat: ChatSandbox,
    root: string,
  ): Promise<GrantedFolder> {
    const host = await this.loadWorkspaceHost();
    const trustedRuntimeRoots = this.trustedRuntimeRoots();
    const ripgrepPath =
      this.platform === "linux"
        ? (await this.checkLinuxHost()).ripgrepPath
        : undefined;
    // VS Code's workspace-write profile: the host stays readable (so tools
    // installed under the home folder run), writes are limited to the folder
    // and temporary directories, and Git and agent policy files are protected.
    const onNetworkRequest = (
      destination: SandboxManagedNetworkDestination,
      launch: WorkspaceProcessLaunchRequest,
    ) => this.answerNetworkRequest(chat, root, destination, launch);
    const createLauncher = async (
      mode?: GrantedLaunchMode,
    ): Promise<WorkspaceProcessLauncher> => {
      if (this.options.createProcessLauncher) {
        return await this.options.createProcessLauncher({
          workDirectory: root,
          deniedReadRoots: [],
          trustedRuntimeRoots,
          grantedRoot: root,
          ...(mode ? { mode } : {}),
          ...(mode === "network" ? { onNetworkRequest } : {}),
        });
      }
      // Runs as the user: only for a command approved on this computer.
      if (mode === "unsandboxed") {
        return host.createLocalWorkspaceExecutionBackend();
      }
      return host.createSandboxedWorkspaceProcessLauncher({
        runtime: this.sandboxRuntime(ripgrepPath),
        platform: this.platform,
        writableRoots: [root],
        trustedRuntimeRoots,
        temporaryHome: false,
        shareHostTemporaryDirectories: true,
        homeDirectory: this.homeDirectory,
        fallbackShell: "/bin/sh",
        ...(mode === "network" ? { publicNetwork: { onNetworkRequest } } : {}),
      });
    };
    const launcher = await createLauncher();
    const modeLaunchers = new Map<
      GrantedLaunchMode,
      Promise<WorkspaceProcessLauncher>
    >();
    const launcherFor = (mode: GrantedLaunchMode) => {
      let pending = modeLaunchers.get(mode);
      if (!pending) {
        pending = createLauncher(mode);
        modeLaunchers.set(mode, pending);
        pending.catch(() => {
          if (modeLaunchers.get(mode) === pending) modeLaunchers.delete(mode);
        });
      }
      return pending;
    };
    const stateDirectory = path.join(
      chat.stateDirectory,
      "granted",
      createHash("sha256").update(root).digest("hex").slice(0, 32),
    );
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const commandTools = await host.createWorkspaceCommandTools({
      projectRoot: root,
      ownerId: OWNER_ID,
      supervisor: chat.supervisor,
      mutations: new host.WorkspaceMutationCoordinator(),
      stateDirectory,
      shellExecutable: this.shellExecutable(),
      sandboxed: true,
      environmentDigestSecret: this.environmentDigestSecret(chat.sessionId),
      resolveEnvironment: () => this.grantedEnvironment(),
      // A granted folder is real work: every command asks, whatever rules say.
      hasSessionGrant: () => false,
      requiresApproval: () => true,
    });
    return { launcher, commandTools, launcherFor };
  }

  /**
   * Show the approval card for a prepared command in a granted folder. On
   * approval returns the input to execute; otherwise the tool result.
   */
  private async approveGrantedCommand(options: {
    readonly request: SandboxToolRequest;
    readonly root: string;
    readonly commandTools: WorkspaceCommandTools;
    readonly authorization: {
      readonly displayContent?: unknown;
      readonly preparedInput?: Readonly<Record<string, unknown>>;
    };
    readonly permission: AskAgentSandboxPermission;
    readonly reason: string | undefined;
    readonly reauthorize: (
      command: string,
    ) => ReturnType<WorkspaceCommandTools["authorizeToolCall"]>;
  }): Promise<
    | { readonly input: Readonly<Record<string, unknown>> }
    | { readonly result: AskAgentSandboxToolResult }
  > {
    const { request, root, commandTools } = options;
    const host = await this.loadWorkspaceHost();
    const display = options.authorization.displayContent;
    const prepared = options.authorization.preparedInput;
    if (!prepared || !host.isWorkspaceCommandApprovalDisplay(display)) {
      return { result: errorResult("command_requires_approval") };
    }
    let decision: AskAgentCommandApprovalDecision;
    try {
      decision = await request.requestApproval!({
        sessionId: request.sessionId,
        command: display.command,
        cwd: display.cwd,
        root,
        timeoutMs: display.timeoutMs,
        network:
          options.permission === "require_escalated"
            ? "full"
            : options.permission === "require_managed_network"
              ? "approved-destinations"
              : this.platform === "linux"
                ? "none"
                : "loopback",
        sandbox:
          options.permission === "require_escalated"
            ? "unsandboxed"
            : "workspace-write",
        ...(options.reason ? { reason: options.reason } : {}),
      });
    } catch (error) {
      const message = errorMessage(error);
      return {
        result: {
          content: JSON.stringify({
            status:
              message === "ask_agent_approval_pending"
                ? "approval_pending"
                : "cancelled",
            error:
              message === "ask_agent_approval_pending"
                ? "Another approval is already pending"
                : "Command approval was cancelled",
          }),
          isError: true,
        },
      };
    }
    if (decision.decision === "deny") {
      return {
        result: {
          content: JSON.stringify({
            status: "forbidden",
            error: decision.reason,
          }),
          isError: true,
        },
      };
    }
    if (decision.decision === "reject") {
      return {
        result: {
          content: JSON.stringify({
            status: "rejected_by_user",
            error: "The user declined this command",
            ...(decision.reason ? { reason: decision.reason } : {}),
          }),
          isError: true,
        },
      };
    }
    if (decision.decision === "edit") {
      // The user wrote this command, so it runs without a second card.
      const edited = await options.reauthorize(decision.command);
      if (edited.decision === "deny") {
        return { result: errorResult(edited.reason ?? "command_denied") };
      }
      if (!edited.preparedInput) {
        return { result: errorResult("command_requires_approval") };
      }
      return { input: { ...edited.preparedInput } };
    }
    const validation = await commandTools.validatePendingLaunch({
      principal: PRINCIPAL,
      sessionId: request.sessionId,
      turnId: request.turnId,
      toolName: "execute_command",
      input: prepared,
      displayContent: display,
    });
    if (!validation.ok) return { result: errorResult(validation.reason) };
    return { input: { ...prepared } };
  }

  private loadWorkspaceHost(): Promise<WorkspaceHostModule> {
    this.workspaceHost ??= import("@agentlink/workspace-host");
    return this.workspaceHost;
  }

  /** macOS always ships zsh; Linux distributions reliably ship bash. */
  private shellExecutable(): string {
    return this.platform === "linux" ? "/bin/bash" : "/bin/zsh";
  }

  private environmentDigestSecret(sessionId: string): string {
    this.digestSecrets ??= new Map();
    let secret = this.digestSecrets.get(sessionId);
    if (!secret) {
      secret = createHash("sha256")
        .update(`${process.pid}:${sessionId}:${Date.now()}:${Math.random()}`)
        .digest("hex");
      this.digestSecrets.set(sessionId, secret);
    }
    return secret;
  }

  private grantedEnvironment(): NodeJS.ProcessEnv {
    const source = this.options.hostEnvironment?.() ?? process.env;
    return Object.fromEntries(
      Object.entries(source).filter(
        ([name, value]) =>
          value !== undefined && !HELPER_ONLY_ENVIRONMENT.test(name),
      ),
    );
  }

  /**
   * On Linux the sandboxed shell runs AgentLink's apply-seccomp helper, so
   * its directory must stay readable when the runtime sits inside a hidden
   * root (an extracted AppImage or a source checkout under /home). Only that
   * directory is re-allowed, not the rest of the install.
   */
  private trustedRuntimeRoots(): string[] {
    return this.platform === "linux"
      ? [
          path.dirname(
            linuxSandboxApplySeccompPath(
              path.join(this.options.extensionRoot, "dist", "sandbox-runtime"),
              process.arch,
            ),
          ),
        ]
      : [];
  }

  private sandboxRuntime(ripgrepPath?: string): SandboxRuntimeProvider {
    this.runtime ??= new SandboxHelperClient(
      createNodeSandboxHelperTransportFactory({
        extensionRoot: this.options.extensionRoot,
        platform: this.platform,
        ...(ripgrepPath ? { ripgrepPath } : {}),
        nodeExecutable: this.options.nodeExecutable ?? process.execPath,
        helperEnvironment:
          this.options.helperEnvironment ??
          (process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      }),
    );
    return this.runtime;
  }
}
