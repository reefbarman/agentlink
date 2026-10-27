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
type WorkspaceFileTools = ReturnType<
  WorkspaceHostModule["createWorkspaceFileTools"]
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
  "list_commands",
  "stop_command",
  "write_file",
  "apply_diff",
  "present_files",
] as const;

/** Tools only useful once a folder is granted for commands. */
export const ASK_AGENT_GRANTED_FOLDER_TOOL_NAMES: readonly AskAgentSandboxToolName[] =
  ["apply_diff", "list_commands", "stop_command"];
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
/** Background commands in granted folders: default and longest run. */
export const ASK_AGENT_SANDBOX_DEFAULT_BACKGROUND_TIMEOUT_MS = 60 * 60 * 1_000;
export const ASK_AGENT_SANDBOX_MAX_BACKGROUND_TIMEOUT_MS = 8 * 60 * 60 * 1_000;
/** Background commands running at once in one chat. */
export const ASK_AGENT_SANDBOX_MAX_BACKGROUND_COMMANDS = 5;
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
  "",
  "## Working in real folders",
  "",
  'Use the scratch folder for throwaway work. When the user wants to keep the result, or asks you to work on files they already have, call request_folder_access first instead of asking them to grant a folder by hand. Suggest a location yourself: for new work they will keep, a new folder at ~/AgentLink/<short-task-name> with create: true; for an existing project or file, its own folder. Pass access: "commands" when you need to run commands or edit files there, "read" when you only need to read. Give a short reason. The user approves it on a card; then work in that folder with absolute paths.',
].join("\n");

export const ASK_AGENT_FOLDER_ACCESS_TOOL_NAME = "request_folder_access";
const ASK_AGENT_FOLDER_ACCESS_MAX_REASON_LENGTH = 1_000;

/**
 * Lets the agent ask for a folder grant on an approval card instead of the
 * user typing a path. The helper handles it, since grants live there.
 */
export const ASK_AGENT_FOLDER_ACCESS_TOOL: CoreModelToolDefinition =
  Object.freeze({
    name: ASK_AGENT_FOLDER_ACCESS_TOOL_NAME,
    description:
      "Ask the user for access to a folder on their computer, shown as an approval card. Use it before reading, running commands in, or editing files outside the scratch folder. For new work the user wants to keep, suggest ~/AgentLink/<short-task-name> with create: true. Returns status granted, already_granted or rejected_by_user.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description:
            "Absolute folder path; ~ means the user's home folder (for example ~/AgentLink/csv-cleanup).",
        },
        access: {
          type: "string",
          enum: ["read", "commands"],
          description:
            "read: read, list and search only. commands (the default): also run commands and edit files, each still asking first unless a rule or Approve for Me allows it.",
        },
        reason: {
          type: "string",
          maxLength: ASK_AGENT_FOLDER_ACCESS_MAX_REASON_LENGTH,
          description: "Short reason shown on the card.",
        },
        create: {
          type: "boolean",
          description:
            "Create the folder if it does not exist yet. Only inside the user's home folder.",
        },
      },
      required: ["path", "reason"],
      additionalProperties: false,
    },
  });

export const ASK_AGENT_SANDBOX_TOOLS: readonly CoreModelToolDefinition[] =
  Object.freeze([
    {
      name: "execute_command",
      description:
        "Run an exact non-interactive command with /bin/zsh -c in this chat's sandboxed scratch folder. There is no PTY, stdin, or persistent shell state. The sandbox allows writes only inside the scratch folder, hides the user's home folder, and has no internet access. Returns retained stdout/stderr and the exit state; use get_command_output with the commandId to page longer output. In a folder granted for commands, background: true starts a long-running command (for example a dev server or watcher) and returns as soon as it starts.",
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
            maximum: ASK_AGENT_SANDBOX_MAX_BACKGROUND_TIMEOUT_MS,
            description: `Defaults to ${ASK_AGENT_SANDBOX_DEFAULT_TIMEOUT_MS} ms (at most ${ASK_AGENT_SANDBOX_MAX_TIMEOUT_MS}). Background commands default to ${ASK_AGENT_SANDBOX_DEFAULT_BACKGROUND_TIMEOUT_MS} ms (at most ${ASK_AGENT_SANDBOX_MAX_BACKGROUND_TIMEOUT_MS}) and are stopped when it runs out.`,
          },
          background: {
            type: "boolean",
            description: `Only in a folder granted for commands, and not with require_managed_network. Starts the command and returns its commandId straight away; it keeps running after your reply until it exits, times out, you call stop_command, or the user revokes the folder or deletes the chat. Read its output with get_command_output. At most ${ASK_AGENT_SANDBOX_MAX_BACKGROUND_COMMANDS} at once per chat.`,
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
      name: "list_commands",
      description:
        "List this chat's commands with their commandId, command, folder and state (running, completed, failed, cancelled or timed_out), newest first.",
      input_schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "stop_command",
      description:
        "Stop a running command this chat started (TERM, then KILL), for example a background dev server you no longer need.",
      input_schema: {
        type: "object",
        properties: { commandId: { type: "string", minLength: 1 } },
        required: ["commandId"],
        additionalProperties: false,
      },
    },
    {
      name: "write_file",
      description:
        "Create or overwrite a text file. A relative path is in this chat's sandboxed scratch folder (missing parent folders are created, no approval). An absolute path must be inside a folder the user granted for commands: then pass expectedContentHash (the contentHash read_file returned) to replace an existing file, or expectedAbsent: true to create a new one, and the change waits for the user's approval.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          content: { type: "string" },
          expectedContentHash: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
            description:
              "Granted folders only: SHA-256 of the current file, from read_file's contentHash.",
          },
          expectedAbsent: {
            type: "boolean",
            description:
              "Granted folders only: true to create a file that must not exist yet.",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    {
      name: "apply_diff",
      description:
        "Edit an existing text file inside a folder the user granted for commands, using SEARCH/REPLACE blocks (each SEARCH must match exactly once). Pass the absolute path and expectedContentHash from read_file. The change waits for the user's approval. Each block is the line <<<<<<< SEARCH, the exact old lines, the line ======= DIVIDER =======, the new lines, then the line >>>>>>> REPLACE.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          diff: { type: "string", minLength: 1 },
          expectedContentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
        required: ["path", "diff", "expectedContentHash"],
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
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (roots.length === 0) return undefined;
  const localServers =
    platform === "darwin"
      ? "Servers work in the sandbox: a dev server or test server can listen on a local port (bind to localhost, for example 127.0.0.1:3000) and the user can open it in their browser. Do not ask for require_escalated just to start a server."
      : "A server started in the sandbox gets its own private network, so tests that start and call their own server work, but the user's browser cannot reach it. Only if the user needs to open it themselves, ask for require_escalated and say why.";
  return [
    "## Folders granted for commands",
    "",
    "The user granted these folders for commands. To run a command in one, pass its absolute path (or a folder inside it) as execute_command's cwd:",
    ...roots.map((root) => `- ${root}`),
    "",
    "A command there may wait for the user to approve it (saved rules or Approve for Me can let it run straight away, and saved rules can refuse it), so run one focused command at a time and explain why. Commands run in a sandbox: they can read files on this computer but only write inside the granted folder and temporary folders, cannot change the folder's Git metadata or agent instruction files, and have no internet access. present_files still only works in the scratch folder.",
    "",
    "To edit files there, read them with read_file (its result includes contentHash), then use apply_diff with the absolute path and that contentHash, or write_file with expectedContentHash (or expectedAbsent: true for a new file). Each change shows the user a diff to approve. Agent instruction and configuration files (for example AGENTS.md or .agentlink/) can only be approved at the user's computer, and .git and .env files cannot be changed. Edits wait until no command is running in that folder, including background commands, so stop a background command with stop_command before editing files it is in.",
    "",
    "For a long-running command such as a dev server, test watcher or build in watch mode, pass background: true. The call returns once it starts; check on it with get_command_output, find it again with list_commands, and stop it with stop_command when you are done. Background commands cannot use require_managed_network.",
    "",
    localServers,
    "",
    'When a command in a granted folder needs the internet (installing packages, downloading, git fetch), pass sandbox_permissions: "require_managed_network" with a reason; each new destination then waits for the user\'s approval. Only when the sandbox blocks something essential, pass sandbox_permissions: "require_escalated" with a reason to run it outside the sandbox with the user\'s full permissions. The user must approve that on their computer, so they may not be able to from a phone, and Approve for Me never skips it. Try the command sandboxed first and escalate only after it fails because of the sandbox.',
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
  /** Keeps running after the tool call returns, until it exits or is stopped. */
  readonly background: boolean;
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

/** A file change in a granted folder the user is asked to approve. */
export interface AskAgentEditApprovalProposal {
  readonly sessionId: string;
  readonly toolName: "write_file" | "apply_diff";
  /** Absolute path of the file. */
  readonly path: string;
  /** The granted folder the file is in. */
  readonly root: string;
  readonly operation: "created" | "modified";
  /** Unified diff of the change. */
  readonly diff: string;
  /**
   * An agent instruction or configuration file (for example AGENTS.md or
   * `.agentlink/`). Approve for Me never applies, and only this computer
   * can approve it.
   */
  readonly protected: boolean;
  readonly protectionReason?: string;
  /**
   * Aborted when the turn stops or the folder's grant is revoked, so an
   * open card is withdrawn.
   */
  readonly signal: AbortSignal;
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

/**
 * Canonical absolute path for a file that may not exist yet: the nearest
 * existing ancestor is resolved through symlinks and the rest appended.
 */
async function canonicalTarget(value: unknown): Promise<string | undefined> {
  if (typeof value !== "string" || !path.isAbsolute(value.trim())) {
    return undefined;
  }
  let existing = path.resolve(value.trim());
  const rest: string[] = [];
  for (;;) {
    const real = await fs.realpath(existing).catch(() => undefined);
    if (real) return path.join(real, ...rest.reverse());
    const parent = path.dirname(existing);
    if (parent === existing) return undefined;
    rest.push(path.basename(existing));
    existing = parent;
  }
}

function isFileApprovalDisplay(value: unknown): value is {
  readonly kind: "file_write";
  readonly operation: "created" | "modified";
  readonly diff: string;
  readonly protected: boolean;
  readonly protectionReason?: string;
} {
  if (!value || typeof value !== "object") return false;
  const display = value as Record<string, unknown>;
  return (
    display.kind === "file_write" &&
    (display.operation === "created" || display.operation === "modified") &&
    typeof display.diff === "string" &&
    typeof display.protected === "boolean"
  );
}

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
  /** Ask the user about a file change in a granted folder. */
  readonly requestEditApproval?: (
    proposal: AskAgentEditApprovalProposal,
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

/** One folder is the other or contains it. */
function overlaps(left: string, right: string): boolean {
  return isInside(left, right) || isInside(right, left);
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
  /** File tools per granted folder, dropped when the grant is revoked. */
  private readonly grantedFileTools = new Map<
    string,
    Promise<WorkspaceFileTools>
  >();
  private revocationClock = 0;
  /** Open edit cards per granted folder, withdrawn when it is revoked. */
  private readonly pendingEdits = new Map<string, Set<AbortController>>();
  /** Edits being written per granted folder; revoking waits for them. */
  private readonly editCommits = new Map<string, Set<Promise<unknown>>>();
  /**
   * Granted folders with an edit between its last check and its write.
   * Commands that can write there are refused until it finishes.
   */
  private readonly editReservations = new Map<symbol, string>();
  /** Granted folders of commands being launched, until the launch returns. */
  private readonly launchingCommands = new Map<symbol, string>();
  /** The granted folder each launched command can write to, by chat and ID. */
  private readonly commandWritableRoots = new Map<string, string>();
  /** Deleted chats; a late tool call must not recreate their sandbox. */
  private readonly deletedChats = new Set<string>();
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
    if (this.deletedChats.has(request.sessionId)) {
      return errorResult("chat_deleted");
    }
    try {
      switch (request.toolName) {
        case "write_file":
          if (
            typeof request.input.path === "string" &&
            path.isAbsolute(request.input.path.trim())
          ) {
            return await this.editGrantedFile(request);
          }
          if (
            request.input.expectedContentHash !== undefined ||
            request.input.expectedAbsent !== undefined
          ) {
            return errorResult(
              "expectedContentHash and expectedAbsent are only for absolute paths in folders granted for commands",
            );
          }
          return await this.writeFile(request.sessionId, request.input);
        case "apply_diff":
          return await this.editGrantedFile(request);
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
    this.grantedFileTools.delete(root);
    for (const controller of this.pendingEdits.get(root) ?? []) {
      controller.abort();
    }
    await Promise.allSettled(this.editCommits.get(root) ?? []);
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
    this.deletedChats.add(sessionId);
    for (const key of this.commandWritableRoots.keys()) {
      if (key.startsWith(`${sessionId}\0`))
        this.commandWritableRoots.delete(key);
    }
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
    const background =
      request.toolName === "execute_command" &&
      request.input.background === true;
    if (request.toolName === "execute_command") {
      if (
        request.input.background !== undefined &&
        typeof request.input.background !== "boolean"
      ) {
        return errorResult("background must be a boolean");
      }
      const maxTimeoutMs = background
        ? ASK_AGENT_SANDBOX_MAX_BACKGROUND_TIMEOUT_MS
        : ASK_AGENT_SANDBOX_MAX_TIMEOUT_MS;
      const timeoutMs = request.input.timeoutMs;
      if (
        timeoutMs !== undefined &&
        (typeof timeoutMs !== "number" || timeoutMs > maxTimeoutMs)
      ) {
        return errorResult(
          `timeoutMs must be at most ${maxTimeoutMs}${background ? " for a background command" : ""}`,
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
      if (background) {
        if (!grantedRoot) {
          return errorResult(
            "background_needs_granted_folder: background commands only run in a folder the user granted for commands",
          );
        }
        if (permission === "require_managed_network") {
          return errorResult(
            "background_network_unavailable: a background command cannot ask for internet destinations; run the network step in the foreground first",
          );
        }
        if (!request.requestApproval) {
          return errorResult("command_requires_approval");
        }
        const running = sandbox.supervisor
          .list({ ownerId: OWNER_ID, sessionId: request.sessionId })
          .filter(
            (record) =>
              record.mode === "background" &&
              (record.state === "running" || record.state === "interrupted"),
          ).length;
        if (running >= ASK_AGENT_SANDBOX_MAX_BACKGROUND_COMMANDS) {
          return errorResult(
            `too_many_background_commands: this chat already has ${running} background commands running; stop one with stop_command first`,
          );
        }
      }
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
        ? {
            timeoutMs: background
              ? ASK_AGENT_SANDBOX_DEFAULT_BACKGROUND_TIMEOUT_MS
              : ASK_AGENT_SANDBOX_DEFAULT_TIMEOUT_MS,
          }
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
    // A background launch is what the user approved (or a rule or Approve
    // for Me allowed), so acknowledge it to the workspace command tools.
    const launch = executable.launch as
      | { readonly commandId?: unknown; readonly mode?: unknown }
      | undefined;
    const launchingBackground =
      request.toolName === "execute_command" && launch?.mode === "background";
    if (launchingBackground) {
      if (!background || !grantedRoot || typeof launch.commandId !== "string") {
        if (launchId) endLaunch(sandbox, launchId);
        return errorResult("command_requires_approval");
      }
      if (request.signal?.aborted) {
        if (launchId) endLaunch(sandbox, launchId);
        return errorResult("command_cancelled_before_launch");
      }
    }
    // Pairs with the edit reservation. The check and the registration run
    // without awaiting in between, and the registration lasts until the
    // launch returns (by then the supervisor lists the command), so an edit
    // either sees this launch or this launch sees the edit.
    let launching: symbol | undefined;
    if (request.toolName === "execute_command" && grantedRoot) {
      const root = grantedRoot;
      if ([...this.editReservations.values()].some((r) => overlaps(r, root))) {
        if (launchId) endLaunch(sandbox, launchId);
        return errorResult(
          "edit_in_progress: a file edit is being written in this folder; retry the command",
        );
      }
      launching = Symbol("launch");
      this.launchingCommands.set(launching, root);
      if (typeof launch?.commandId === "string") {
        this.commandWritableRoots.set(
          `${request.sessionId}\0${launch.commandId}`,
          root,
        );
      }
    }
    if (launchingBackground && typeof launch?.commandId === "string") {
      commandTools.acknowledgeBackgroundLaunch(launch.commandId);
    }
    let result: Awaited<ReturnType<typeof tool.executeValidated>>;
    try {
      result = await tool.executeValidated(executable, {
        principal,
        sessionId: request.sessionId,
        turnId: request.turnId,
        model,
        // The supervisor stops a command when this signal aborts, so a
        // background command must not be tied to the turn that started it.
        signal: launchingBackground
          ? new AbortController().signal
          : request.signal,
      });
    } finally {
      if (launching) this.launchingCommands.delete(launching);
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
    if (this.deletedChats.has(sessionId)) {
      return Promise.reject(new Error("chat_deleted"));
    }
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
        // Dev and test servers can listen on a local port inside the
        // sandbox, so they need no full terminal access. On Linux each
        // command has its own network namespace instead.
        ...(this.platform === "darwin" ? { allowLocalBinding: true } : {}),
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
        background: display.mode === "background",
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

  /**
   * `write_file` with an absolute path, or `apply_diff`, in a folder granted
   * for commands. Uses the workspace file tools (baseline hash, diff,
   * protected paths, re-validation before the write) and asks the user.
   */
  private async editGrantedFile(
    request: SandboxToolRequest,
  ): Promise<AskAgentSandboxToolResult> {
    const toolName = request.toolName as "write_file" | "apply_diff";
    const target = await canonicalTarget(request.input.path);
    const root = target
      ? (request.commandRoots ?? [])
          .filter((candidate) => isInside(target, candidate))
          .sort((left, right) => right.length - left.length)[0]
      : undefined;
    if (!target || !root || target === root) {
      return errorResult(
        "path_not_granted: edits work in the scratch folder (relative paths) or at an absolute path inside a folder the user granted for commands",
      );
    }
    if (!request.requestEditApproval) {
      return errorResult("edit_requires_approval");
    }
    const startedAt = this.revocationClock;
    const tools = await this.fileToolsFor(root);
    const discovery = {
      principal: PRINCIPAL,
      sessionId: request.sessionId,
      turnId: request.turnId,
      input: { text: "", attachments: undefined },
    };
    const tool = (await tools.resolveTools(discovery)).find(
      (candidate) => candidate.definition.name === toolName,
    );
    if (!tool) return errorResult(`unknown_tool:${toolName}`);
    const validation = tool.validate({
      ...request.input,
      path: path.relative(root, target),
    });
    if (!validation.valid) {
      return errorResult(
        `invalid_input: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
      );
    }
    const authorization = await tools.authorizeToolCall({
      ...discovery,
      model: MODEL,
      toolCallId: request.turnId,
      toolName,
      input: validation.input,
      effect: "write",
    });
    if (authorization.decision === "deny") {
      return errorResult(authorization.reason ?? "edit_denied");
    }
    // apply_diff pins the reviewed baseline hash into a host-prepared input.
    const executeInput =
      (authorization.decision === "allow" ||
        authorization.decision === "require_user") &&
      authorization.preparedInput
        ? { ...authorization.preparedInput }
        : validation.input;
    if (authorization.decision === "require_user") {
      const display = authorization.displayContent;
      if (!isFileApprovalDisplay(display)) {
        return errorResult("edit_requires_approval");
      }
      let decision: AskAgentCommandApprovalDecision;
      const card = new AbortController();
      const abortCard = () => card.abort();
      request.signal?.addEventListener("abort", abortCard, { once: true });
      if (request.signal?.aborted) card.abort();
      const pendingInRoot = this.pendingEdits.get(root) ?? new Set();
      pendingInRoot.add(card);
      this.pendingEdits.set(root, pendingInRoot);
      try {
        decision = await request.requestEditApproval({
          sessionId: request.sessionId,
          toolName,
          path: target,
          root,
          operation: display.operation,
          diff: display.diff,
          protected: display.protected,
          ...(display.protectionReason
            ? { protectionReason: display.protectionReason }
            : {}),
          signal: card.signal,
        });
        if (card.signal.aborted) throw new Error("edit_cancelled");
      } catch (error) {
        const pending = errorMessage(error) === "ask_agent_approval_pending";
        return {
          content: JSON.stringify({
            status: pending ? "approval_pending" : "cancelled",
            error: pending
              ? "Another approval is already pending"
              : "Edit approval was cancelled",
          }),
          isError: true,
        };
      } finally {
        request.signal?.removeEventListener("abort", abortCard);
        pendingInRoot.delete(card);
        if (pendingInRoot.size === 0) this.pendingEdits.delete(root);
      }
      if (decision.decision === "deny") {
        return {
          content: JSON.stringify({
            status: "forbidden",
            error: decision.reason,
          }),
          isError: true,
        };
      }
      if (decision.decision !== "run") {
        return {
          content: JSON.stringify({
            status: "rejected_by_user",
            error: "The user declined this change",
            ...(decision.decision === "reject" && decision.reason
              ? { reason: decision.reason }
              : {}),
          }),
          isError: true,
        };
      }
      // The file or policy may have changed while the card was open.
      const pending = await tools.validatePendingWrite({
        principal: PRINCIPAL,
        sessionId: request.sessionId,
        turnId: request.turnId,
        toolName,
        input: executeInput,
        displayContent: display,
      });
      if (!pending.ok) return errorResult(pending.reason);
    } else if (authorization.decision !== "allow") {
      return errorResult("edit_requires_approval");
    }
    if (!(await this.isStillGranted(root, startedAt, request))) {
      return errorResult(
        "path_not_granted: this folder's command grant was revoked",
      );
    }
    // The file tools resolve the path once and then write through it, so a
    // command swapping a folder for a link mid-write could redirect the
    // write outside the grant. Edits wait until no command that can write
    // here runs (including ones from an enclosing grant), and the path must
    // still resolve to the same place. The reservation is taken before the
    // check, so a command launched after it is refused until the write ends.
    const reservation = Symbol("edit");
    this.editReservations.set(reservation, root);
    let result: Awaited<ReturnType<typeof tool.executeValidated>>;
    try {
      if (await this.commandRunningIn(root)) {
        return errorResult(
          "command_running: a command that can write in this folder is still running; wait for it to finish, or stop a background command with stop_command (list_commands shows them), then retry the edit",
        );
      }
      if ((await canonicalTarget(request.input.path)) !== target) {
        return errorResult(
          "path_changed: the file's location changed while the edit was pending; read it again and retry",
        );
      }
      if (
        request.signal?.aborted ||
        (this.commandRootRevocations.get(root) ?? 0) > startedAt
      ) {
        return errorResult(
          "path_not_granted: the edit was stopped or this folder's command grant was revoked",
        );
      }
      // Registered synchronously after the last check, so a revoke either
      // refuses this edit above or waits for the write to finish.
      const commit = tool.executeValidated(executeInput, {
        principal: PRINCIPAL,
        sessionId: request.sessionId,
        turnId: request.turnId,
        model: MODEL,
        signal: request.signal,
      });
      const commits = this.editCommits.get(root) ?? new Set();
      commits.add(commit);
      this.editCommits.set(root, commits);
      try {
        result = await commit;
      } finally {
        commits.delete(commit);
        if (commits.size === 0) this.editCommits.delete(root);
      }
    } finally {
      this.editReservations.delete(reservation);
    }
    return {
      content:
        typeof result.modelContent === "string"
          ? result.modelContent
          : JSON.stringify(result.modelContent),
      isError: result.isError === true,
    };
  }

  /**
   * Whether any chat has a command, running or still launching, that can
   * write inside `root`: its granted folder is `root`, inside it, or
   * encloses it.
   */
  private async commandRunningIn(root: string): Promise<boolean> {
    if ([...this.launchingCommands.values()].some((r) => overlaps(r, root))) {
      return true;
    }
    for (const pending of this.chats.values()) {
      const chat = await pending.catch(() => undefined);
      if (
        chat?.supervisor.list({ ownerId: OWNER_ID }).some((record) => {
          if (record.state !== "running" && record.state !== "interrupted") {
            return false;
          }
          const writable = this.commandWritableRoots.get(
            `${chat.sessionId}\0${record.commandId}`,
          );
          return writable
            ? overlaps(writable, root)
            : isInside(record.cwd, root);
        })
      ) {
        return true;
      }
    }
    return [...this.launchingCommands.values()].some((r) => overlaps(r, root));
  }

  private fileToolsFor(root: string): Promise<WorkspaceFileTools> {
    let tools = this.grantedFileTools.get(root);
    if (!tools) {
      tools = this.loadWorkspaceHost().then((host) =>
        host.createWorkspaceFileTools({ projectRoot: root }),
      );
      this.grantedFileTools.set(root, tools);
      tools.catch(() => {
        if (this.grantedFileTools.get(root) === tools) {
          this.grantedFileTools.delete(root);
        }
      });
    }
    return tools;
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
