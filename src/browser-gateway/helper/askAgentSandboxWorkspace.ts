import { createHash } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  SANDBOX_INTERACTIVE_HELPER_RELATIVE_PATH,
  SandboxHelperClient,
  createNodeSandboxHelperTransportFactory,
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

/**
 * Per-chat sandboxed scratch folders for the Ask Agent helper (Desktop and
 * the browser tab). Each chat gets `<root>/<chat>/work`, created on first
 * use. Commands run through the shared workspace-host command tools on the
 * macOS sandbox: they can write only to that folder and private per-command
 * directories, cannot read the rest of the user's home or other chats, and
 * have loopback-only networking. The sandbox is the security boundary, so
 * calls run without an approval card.
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
  "Commands run in a macOS sandbox: they can only write inside the scratch folder, cannot read the user's home folder or other chats, and have no internet access, so package installs such as pip install fail. Prefer tools that are already installed. Read results with read_file, list_files or search_files using scratch-relative paths.",
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
              "Working directory relative to the scratch folder. Defaults to the scratch folder.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 1,
            maximum: ASK_AGENT_SANDBOX_MAX_TIMEOUT_MS,
            description: `Defaults to ${ASK_AGENT_SANDBOX_DEFAULT_TIMEOUT_MS} ms.`,
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
  /** Test seam replacing the sandboxed launcher. */
  readonly createProcessLauncher?: (options: {
    readonly workDirectory: string;
    readonly deniedReadRoots: readonly string[];
  }) => WorkspaceProcessLauncher | Promise<WorkspaceProcessLauncher>;
}

interface ChatSandbox {
  readonly workDirectory: string;
  readonly supervisor: WorkspaceCommandSupervisor;
  readonly commandTools: WorkspaceCommandTools;
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
  private runtime: SandboxRuntimeProvider | undefined;
  private workspaceHost: Promise<WorkspaceHostModule> | undefined;

  constructor(private readonly options: AskAgentSandboxWorkspaceOptions) {
    this.platform = options.platform ?? process.platform;
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    this.maxWorkspaceBytes =
      options.maxWorkspaceBytes ?? ASK_AGENT_SANDBOX_MAX_WORKSPACE_BYTES;
  }

  /** macOS with the packaged sandbox helper staged next to the host. */
  isAvailable(): boolean {
    if (this.platform !== "darwin") return false;
    if (this.options.createProcessLauncher) return true;
    return existsSync(
      path.join(
        this.options.extensionRoot,
        SANDBOX_INTERACTIVE_HELPER_RELATIVE_PATH,
      ),
    );
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

  async execute(request: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly toolName: AskAgentSandboxToolName;
    readonly input: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<AskAgentSandboxToolResult> {
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
    return [...new Set([this.homeDirectory, "/Users"])];
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

  private async runCommandTool(request: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly toolName: AskAgentSandboxToolName;
    readonly input: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<AskAgentSandboxToolResult> {
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
    const sandbox = await this.chatSandbox(request.sessionId);
    if (request.toolName === "execute_command") {
      await this.assertUnderQuota(sandbox.workDirectory);
    }
    const principal = { tenantId: "local", subjectId: "ask-agent" };
    const discovery = {
      principal,
      sessionId: request.sessionId,
      turnId: request.turnId,
      input: { text: "", attachments: undefined },
    };
    const tools = await sandbox.commandTools.resolveTools(discovery);
    const tool = tools.find(
      (candidate) => candidate.definition.name === request.toolName,
    );
    if (!tool) return errorResult(`unknown_tool:${request.toolName}`);
    const validation = tool.validate({
      ...request.input,
      ...(request.toolName === "execute_command" &&
      request.input.timeoutMs === undefined
        ? { timeoutMs: ASK_AGENT_SANDBOX_DEFAULT_TIMEOUT_MS }
        : {}),
    });
    if (!validation.valid) {
      return errorResult(
        `invalid_input: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
      );
    }
    const model = {
      model: { providerId: "ask-agent", modelId: "ask-agent" },
      source: "runtime" as const,
    };
    let executable = validation.input;
    if (request.toolName === "execute_command") {
      const authorization = await sandbox.commandTools.authorizeToolCall({
        ...discovery,
        model,
        toolCallId: request.turnId,
        toolName: request.toolName,
        input: validation.input,
        effect: "write",
      });
      if (authorization.decision !== "allow") {
        return errorResult(
          authorization.decision === "deny"
            ? (authorization.reason ?? "command_denied")
            : "command_requires_approval",
        );
      }
      executable = { ...(authorization.preparedInput ?? validation.input) };
    }
    const result = await tool.executeValidated(executable, {
      principal,
      sessionId: request.sessionId,
      turnId: request.turnId,
      model,
      signal: request.signal,
    });
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
    if (!this.isAvailable()) {
      throw new Error("ask_agent_sandbox_unavailable");
    }
    const workDirectory = await this.ensureWorkDirectory(sessionId);
    const stateDirectory = path.join(this.chatDirectory(sessionId), "state");
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    this.workspaceHost ??= import("@agentlink/workspace-host");
    const host = await this.workspaceHost;
    const deniedReadRoots = this.deniedReadRoots();
    const launcher = this.options.createProcessLauncher
      ? await this.options.createProcessLauncher({
          workDirectory,
          deniedReadRoots,
        })
      : host.createSandboxedWorkspaceProcessLauncher({
          runtime: this.sandboxRuntime(),
          writableRoots: [workDirectory],
          deniedReadRoots,
          temporaryHome: true,
          shareHostTemporaryDirectories: false,
          homeDirectory: this.homeDirectory,
          fallbackShell: "/bin/sh",
        });
    const ownerId = "ask-agent-sandbox";
    const supervisor = await host.WorkspaceCommandSupervisor.create({
      stateDirectory,
      ownerId,
      executionBackend: launcher,
    });
    const commandTools = await host.createWorkspaceCommandTools({
      projectRoot: workDirectory,
      ownerId,
      supervisor,
      mutations: new host.WorkspaceMutationCoordinator(),
      stateDirectory,
      shellExecutable: "/bin/zsh",
      environmentDigestSecret: createHash("sha256")
        .update(`${process.pid}:${sessionId}:${Date.now()}`)
        .digest("hex"),
      resolveEnvironment: () => ({
        PATH: SANDBOX_PATH,
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        TERM: "dumb",
        MPLBACKEND: "Agg",
      }),
      // Every command is confined by the sandbox, which is the boundary here.
      hasSessionGrant: () => true,
    });
    return { workDirectory, supervisor, commandTools };
  }

  private sandboxRuntime(): SandboxRuntimeProvider {
    this.runtime ??= new SandboxHelperClient(
      createNodeSandboxHelperTransportFactory({
        extensionRoot: this.options.extensionRoot,
        nodeExecutable: this.options.nodeExecutable ?? process.execPath,
        helperEnvironment:
          this.options.helperEnvironment ??
          (process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      }),
    );
    return this.runtime;
  }
}
