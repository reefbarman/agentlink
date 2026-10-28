import {
  defineTool,
  type AgentPrincipal,
  type AuthorizeToolCall,
  type HostTool,
  type HostToolResolveRequest,
  type HostToolResolver,
} from "@agentlink/core";
import {
  filterCommandOutput,
  type CommandOutputFilterOptions,
} from "@agentlink/core/command-output";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import {
  type PreparedWorkspaceCommandLaunch,
  type WorkspaceCommandMode,
  type WorkspaceCommandLaunch,
  type WorkspaceCommandObservation,
  WorkspaceCommandSupervisor,
} from "./commandSupervisor.js";
import type { WorkspaceMutationCoordinator } from "./mutationCoordinator.js";

export type WorkspaceCommandRuleDecision = "allow" | "prompt" | "forbidden";

export interface WorkspaceCommandRule {
  readonly command: string;
  readonly cwd: string;
  readonly mode: WorkspaceCommandMode;
  readonly decision: WorkspaceCommandRuleDecision;
}

export interface WorkspaceCommandApprovalDisplay {
  readonly kind: "command_launch";
  readonly commandId: string;
  readonly command: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environmentKeys: readonly string[];
  readonly mode: WorkspaceCommandMode;
  readonly timeoutMs: number;
  /** False only when the host runs commands through a sandboxed launcher. */
  readonly unsandboxed: boolean;
  readonly concurrentEditingWarning: boolean;
  readonly ruleDecision: WorkspaceCommandRuleDecision | "unmatched";
  readonly policyFingerprint: string;
  readonly operationDigest: string;
}

export interface WorkspaceCommandSessionGrant {
  readonly command: string;
  readonly cwd: string;
  readonly mode: WorkspaceCommandMode;
  readonly policyFingerprint: string;
}

export interface CreateWorkspaceCommandToolsOptions {
  readonly projectRoot: string;
  /**
   * A folder inside the project that commands are confined to: their
   * default working directory, and every `cwd` must be inside it. Defaults
   * to the project root. A working-directory rule, not a sandbox.
   */
  readonly commandRoot?: string;
  readonly ownerId: string;
  readonly supervisor: WorkspaceCommandSupervisor;
  readonly mutations: WorkspaceMutationCoordinator;
  readonly stateDirectory: string;
  readonly shellExecutable?: string;
  /**
   * Set when `supervisor` launches through a sandbox (for example
   * `createSandboxedWorkspaceProcessLauncher`), so approval displays and
   * summaries say so. Defaults to false.
   */
  readonly sandboxed?: boolean;
  readonly environmentDigestSecret: string;
  readonly resolveEnvironment?: () =>
    | NodeJS.ProcessEnv
    | Promise<NodeJS.ProcessEnv>;
  /**
   * What the call's `env` may do: `allow` (default) sets any variable,
   * `add_only` refuses one the host environment already has.
   */
  readonly environmentOverrides?: "allow" | "add_only";
  /**
   * `execute_command`'s model result: `vscode` (default) is VS Code's
   * result with filtered output; `observation` is the raw supervisor
   * observation, for a host that advertises its own older schema.
   */
  readonly executeResult?: "vscode" | "observation";
  readonly hasSessionGrant?: (
    proposal: WorkspaceCommandApprovalDisplay,
    request: Pick<HostToolResolveRequest, "principal" | "sessionId" | "turnId">,
  ) => boolean;
  /** Force foreground human mediation even when a durable/session allow matches. */
  readonly requiresApproval?: (
    proposal: WorkspaceCommandApprovalDisplay,
    request: Pick<HostToolResolveRequest, "principal" | "sessionId" | "turnId">,
  ) => boolean;
  /** Reassign long-lived child processes to their foreground parent session. */
  readonly resolveBackgroundOwnerSessionId?: (
    request: Pick<HostToolResolveRequest, "principal" | "sessionId" | "turnId">,
  ) => string | undefined;
}

export interface WorkspaceCommandTools {
  readonly resolveTools: HostToolResolver;
  readonly authorizeToolCall: AuthorizeToolCall;
  readonly validatePendingLaunch: (request: {
    readonly principal: AgentPrincipal;
    readonly sessionId: string;
    readonly turnId: string;
    readonly toolName: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly displayContent: unknown;
  }) => Promise<{ readonly ok: true } | { readonly ok: false; reason: string }>;
  readonly listRules: () => readonly WorkspaceCommandRule[];
  readonly addRule: (rule: WorkspaceCommandRule) => Promise<void>;
  readonly acknowledgeBackgroundLaunch: (commandId: string) => void;
  readonly consumeBackgroundAcknowledgement: (commandId: string) => boolean;
}

interface RulesFile {
  readonly schemaVersion: 1;
  readonly rules: readonly WorkspaceCommandRule[];
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const POLICY_REVISION = "standalone-cli-commands-v1";

export async function createWorkspaceCommandTools(
  options: CreateWorkspaceCommandToolsOptions,
): Promise<WorkspaceCommandTools> {
  if (!path.isAbsolute(options.projectRoot)) {
    throw new Error("Workspace command tools require an absolute project root");
  }
  if (!path.isAbsolute(options.stateDirectory)) {
    throw new Error(
      "Workspace command rule state requires an absolute directory",
    );
  }
  const projectRoot = await fs.realpath(options.projectRoot);
  if (
    options.commandRoot !== undefined &&
    !path.isAbsolute(options.commandRoot)
  ) {
    throw new Error("Workspace command root must be absolute");
  }
  const commandRoot = options.commandRoot
    ? await canonicalPreparedCommandCwd(projectRoot, options.commandRoot)
    : projectRoot;
  const commandRootRelative = path.relative(projectRoot, commandRoot);
  const shellExecutable = options.shellExecutable ?? "/bin/zsh";
  const unsandboxed = options.sandboxed !== true;
  if (!path.isAbsolute(shellExecutable)) {
    throw new Error("Workspace command shell must be absolute");
  }
  const rules = await WorkspaceCommandRuleStore.open(options.stateDirectory);
  const backgroundAcknowledgements = new Set<string>();

  const prepare = async (
    input: Readonly<Record<string, unknown>>,
    request: Pick<HostToolResolveRequest, "principal" | "sessionId" | "turnId">,
  ): Promise<{
    readonly launch: PreparedWorkspaceCommandLaunch;
    readonly display: WorkspaceCommandApprovalDisplay;
  }> => {
    const command = requiredString(input.command, "command");
    const mode: WorkspaceCommandMode =
      input.background === true ? "background" : "foreground";
    const cwd = await canonicalCommandCwd(projectRoot, commandRoot, input.cwd);
    const timeoutMs = requestedTimeoutMs(input);
    const base = await (options.resolveEnvironment?.() ??
      Promise.resolve(process.env));
    const requestedEnvironment = parseRequestedEnvironment(
      input.env,
      completeEnvironment(base, cwd),
      options.environmentOverrides ?? "allow",
    );
    const environment = launchEnvironment(base, requestedEnvironment, cwd);
    const environmentKeys = Object.keys(environment).sort();
    const environmentDigest = digestEnvironment(
      environment,
      options.environmentDigestSecret,
    );
    const ruleDecision = evaluateRules(rules.list(), { command, cwd, mode });
    const policyFingerprint = commandPolicyFingerprint(
      rules.list(),
      shellExecutable,
    );
    const commandId = options.supervisor.nextCommandId();
    const launchSessionId =
      mode === "background"
        ? (options.resolveBackgroundOwnerSessionId?.(request) ??
          request.sessionId)
        : request.sessionId;
    const launchBase = {
      schemaVersion: 1 as const,
      commandId,
      ownerId: options.ownerId,
      sessionId: launchSessionId,
      turnId: request.turnId,
      command,
      executable: shellExecutable,
      args: ["-c", command] as const,
      cwd,
      environmentKeys,
      environmentDigest,
      ...(requestedEnvironment ? { requestedEnvironment } : {}),
      mode,
      timeoutMs,
      policyFingerprint,
    };
    const operationDigest = launchDigest(launchBase);
    const launch: PreparedWorkspaceCommandLaunch = {
      ...launchBase,
      operationDigest,
    };
    const display: WorkspaceCommandApprovalDisplay = {
      kind: "command_launch",
      commandId,
      command,
      executable: shellExecutable,
      args: [...launch.args],
      cwd,
      environmentKeys,
      mode,
      timeoutMs,
      unsandboxed,
      concurrentEditingWarning: mode === "background",
      ruleDecision,
      policyFingerprint,
      operationDigest,
    };
    return { launch, display };
  };

  const resolveTools: HostToolResolver = async (request) => [
    executeCommandTool(
      request,
      options.supervisor,
      options.mutations,
      options.resolveEnvironment,
      options.environmentDigestSecret,
      (commandId) => {
        if (!backgroundAcknowledgements.has(commandId)) return false;
        backgroundAcknowledgements.delete(commandId);
        return true;
      },
      commandRootRelative,
      options.executeResult ?? "vscode",
    ),
    observeCommandTool(request, options.supervisor, options.ownerId),
    listCommandsTool(request, options.supervisor, options.ownerId),
    stopCommandTool(request, options.supervisor, options.ownerId),
  ];

  const authorizeToolCall: AuthorizeToolCall = async (request) => {
    if (request.toolName !== "execute_command") {
      return { decision: "deny", reason: "Unsupported command authorization" };
    }
    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
      prepared = await prepare(request.input, request);
    } catch (error) {
      // Invalid input (cwd, env) is the model's to fix, not a turn failure.
      return { decision: "deny", reason: errorMessage(error) };
    }
    if (prepared.display.ruleDecision === "forbidden") {
      return {
        decision: "deny",
        reason: "Command forbidden by an explicit rule",
      };
    }
    // The output filters only shape the result; the launch is what's bound.
    const outputFilter = parseOutputFilter(request.input);
    const preparedInput = {
      launch: prepared.launch,
      ...(outputFilter ? { outputFilter } : {}),
    };
    if (
      prepared.display.mode === "foreground" &&
      !options.requiresApproval?.(prepared.display, request) &&
      (prepared.display.ruleDecision === "allow" ||
        options.hasSessionGrant?.(prepared.display, request))
    ) {
      return { decision: "allow", preparedInput };
    }
    const boundary = unsandboxed ? "unsandboxed" : "sandboxed";
    return {
      decision: "require_user",
      summary:
        prepared.display.mode === "background"
          ? `Launch ${boundary} background command with concurrent editing`
          : `Run ${boundary} foreground command`,
      displayContent: prepared.display,
      preparedInput,
    };
  };

  const validatePendingLaunch: WorkspaceCommandTools["validatePendingLaunch"] =
    async (request) => {
      if (request.toolName !== "execute_command") {
        return {
          ok: false,
          reason: "Pending operation is not a command launch",
        };
      }
      const launch = preparedLaunch(request.input.launch);
      if (
        !launch ||
        !isWorkspaceCommandApprovalDisplay(request.displayContent)
      ) {
        return { ok: false, reason: "Pending command proposal is invalid" };
      }
      const expectedSessionId =
        launch.mode === "background"
          ? (options.resolveBackgroundOwnerSessionId?.(request) ??
            request.sessionId)
          : request.sessionId;
      if (
        launch.ownerId !== options.ownerId ||
        launch.sessionId !== expectedSessionId ||
        launch.turnId !== request.turnId
      ) {
        return { ok: false, reason: "Pending command identity changed" };
      }
      if (
        launch.policyFingerprint !==
        commandPolicyFingerprint(rules.list(), shellExecutable)
      ) {
        return {
          ok: false,
          reason: "Command rules or shell configuration changed",
        };
      }
      if (launch.operationDigest !== launchDigest(launch)) {
        return { ok: false, reason: "Prepared command launch changed" };
      }
      const cwd = await canonicalPreparedCommandCwd(
        commandRoot,
        launch.cwd,
      ).catch(() => undefined);
      if (cwd !== launch.cwd) {
        return { ok: false, reason: "Command working directory changed" };
      }
      const currentEnvironment = launchEnvironment(
        await (options.resolveEnvironment?.() ?? Promise.resolve(process.env)),
        launch.requestedEnvironment,
        cwd,
      );
      if (
        JSON.stringify(Object.keys(currentEnvironment).sort()) !==
          JSON.stringify(launch.environmentKeys) ||
        digestEnvironment(
          currentEnvironment,
          options.environmentDigestSecret,
        ) !== launch.environmentDigest
      ) {
        return { ok: false, reason: "Command environment changed" };
      }
      return sameDisplay(launch, request.displayContent) &&
        request.displayContent.unsandboxed === unsandboxed
        ? { ok: true }
        : { ok: false, reason: "Pending command display changed" };
    };

  return {
    resolveTools,
    authorizeToolCall,
    validatePendingLaunch,
    listRules: () => rules.list(),
    addRule: (rule) => rules.add(rule),
    acknowledgeBackgroundLaunch(commandId) {
      backgroundAcknowledgements.add(commandId);
    },
    consumeBackgroundAcknowledgement(commandId) {
      if (!backgroundAcknowledgements.has(commandId)) return false;
      backgroundAcknowledgements.delete(commandId);
      return true;
    },
  };
}

function executeCommandTool(
  discovery: HostToolResolveRequest,
  supervisor: WorkspaceCommandSupervisor,
  mutations: WorkspaceMutationCoordinator,
  resolveEnvironment:
    | (() => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>)
    | undefined,
  environmentDigestSecret: string,
  consumeBackgroundAcknowledgement: (commandId: string) => boolean,
  /** The command root relative to the project root; "" for the root. */
  commandRootRelative = "",
  resultFormat: "vscode" | "observation" = "vscode",
): HostTool {
  return defineTool({
    name: "execute_command",
    description:
      "Run an exact non-interactive command through /bin/zsh -c. There is no PTY, stdin, persistent shell state, or sandbox. Background launch requires explicit concurrent-editing acknowledgement. Use output_grep, output_head and output_tail instead of piping through grep, head or tail.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          minLength: 1,
          maxLength: 32_000,
          description: "Shell command to execute",
        },
        cwd: {
          type: "string",
          description: commandRootRelative
            ? `Project-relative working directory, inside ${commandRootRelative}. Defaults to ${commandRootRelative}; commands cannot run anywhere else.`
            : "Project-relative working directory. Defaults to the project root.",
        },
        background: {
          type: "boolean",
          description:
            "Run without waiting for completion. Use for long-running processes like dev servers. Returns immediately with command_id.",
        },
        timeout: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: MAX_TIMEOUT_MS / 1_000,
          description: `Timeout in seconds. Defaults to ${DEFAULT_TIMEOUT_MS / 1_000}. Always set one for quick commands.`,
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TIMEOUT_MS,
          description: "Deprecated: use timeout (seconds).",
        },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            'Environment variables to set for this command (e.g. {"CI":"1"}), merged with the base environment. Values are literal, not shell-expanded. PWD is set by the host.',
        },
        output_head: {
          type: "integer",
          minimum: 0,
          description:
            "Return only the first N lines of output. Overrides the default 200-line tail cap.",
        },
        output_tail: {
          type: "integer",
          minimum: 0,
          description:
            "Return only the last N lines of output. Overrides the default 200-line tail cap.",
        },
        output_offset: {
          type: "integer",
          minimum: 0,
          description:
            'Skip first N lines/entries before applying head/tail, equivalent to "| tail -n +N | head -N". Defaults to 0.',
        },
        output_grep: {
          type: "string",
          description:
            "Filter output to lines matching this regex pattern (case-insensitive). Applied before head/tail. Use this instead of piping through grep.",
        },
        output_grep_context: {
          type: "integer",
          minimum: 0,
          description:
            "Number of context lines around each grep match (like grep -C). Only used with output_grep.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    effect: "write",
    authorization: "required",
    displayInput: (input) => ({
      command: input.command,
      cwd: input.cwd ?? ".",
      background: input.background === true,
      timeoutMs: requestedTimeoutMs(input),
      ...(input.env && typeof input.env === "object"
        ? { environmentKeys: Object.keys(input.env).sort() }
        : {}),
    }),
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      const prepared = preparedLaunch(input.launch);
      if (!prepared) return toolError("command_launch_not_prepared");
      if (
        prepared.sessionId !== context.sessionId ||
        prepared.turnId !== context.turnId
      ) {
        return toolError("command_launch_identity_mismatch");
      }
      const environment = launchEnvironment(
        await (resolveEnvironment?.() ?? Promise.resolve(process.env)),
        prepared.requestedEnvironment,
        prepared.cwd,
      );
      if (
        JSON.stringify(Object.keys(environment).sort()) !==
          JSON.stringify(prepared.environmentKeys) ||
        digestEnvironment(environment, environmentDigestSecret) !==
          prepared.environmentDigest
      ) {
        return toolError("command_environment_changed");
      }
      const concurrentEditingAcknowledged =
        prepared.mode !== "background" ||
        consumeBackgroundAcknowledgement(prepared.commandId);
      if (!concurrentEditingAcknowledged) {
        return toolError("background_concurrent_editing_not_acknowledged");
      }
      const launch: WorkspaceCommandLaunch = {
        ...prepared,
        environment,
        concurrentEditingAcknowledged,
      };
      const run = async () =>
        launch.mode === "background"
          ? await supervisor.launchBackground(launch, context.signal)
          : await supervisor.launchForeground(launch, context.signal);
      const record = await mutations.withExclusive(run, context.signal);
      const observation = supervisor.observe(
        record.commandId,
        { ownerId: launch.ownerId, sessionId: launch.sessionId },
        { offset: 0, limitBytes: 128_000 },
      );
      if (resultFormat === "observation") {
        return commandResult(observation);
      }
      return executeCommandResult(
        observation,
        parseOutputFilter(input.outputFilter),
      );
    },
  });
}

function observeCommandTool(
  discovery: HostToolResolveRequest,
  supervisor: WorkspaceCommandSupervisor,
  ownerId: string,
): HostTool {
  return defineTool({
    name: "get_command_output",
    description:
      "Observe bounded retained stdout/stderr and current state for a command owned by this session.",
    inputSchema: {
      type: "object",
      properties: {
        commandId: { type: "string", minLength: 1 },
        offset: { type: "integer", minimum: 0 },
        limitBytes: { type: "integer", minimum: 1, maximum: 1_000_000 },
      },
      required: ["commandId"],
      additionalProperties: false,
    },
    effect: "read",
    displayInput: (input) => ({ commandId: input.commandId }),
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      try {
        return commandResult(
          supervisor.observe(
            requiredString(input.commandId, "commandId"),
            { ownerId, sessionId: context.sessionId },
            {
              offset: optionalInteger(input.offset),
              limitBytes: optionalInteger(input.limitBytes),
            },
          ),
        );
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  });
}

function listCommandsTool(
  discovery: HostToolResolveRequest,
  supervisor: WorkspaceCommandSupervisor,
  ownerId: string,
): HostTool {
  return defineTool({
    name: "list_commands",
    description:
      "List retained foreground and background commands for this session.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    effect: "read",
    handler: async (_input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      const records = supervisor.list({
        ownerId,
        sessionId: context.sessionId,
      });
      return {
        modelContent: JSON.stringify(records),
        displayContent: records,
      };
    },
  });
}

function stopCommandTool(
  discovery: HostToolResolveRequest,
  supervisor: WorkspaceCommandSupervisor,
  ownerId: string,
): HostTool {
  return defineTool({
    name: "stop_command",
    description:
      "Stop a running command owned by this session with TERM then KILL escalation.",
    inputSchema: {
      type: "object",
      properties: { commandId: { type: "string", minLength: 1 } },
      required: ["commandId"],
      additionalProperties: false,
    },
    effect: "write",
    displayInput: (input) => ({ commandId: input.commandId }),
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      try {
        const record = await supervisor.stop(
          requiredString(input.commandId, "commandId"),
          { ownerId, sessionId: context.sessionId },
        );
        return {
          modelContent: JSON.stringify(record),
          displayContent: record,
        };
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  });
}

class WorkspaceCommandRuleStore {
  private readonly statePath: string;
  private rules: WorkspaceCommandRule[];

  private constructor(stateDirectory: string, rules: WorkspaceCommandRule[]) {
    this.statePath = path.join(stateDirectory, "command-rules.json");
    this.rules = rules;
  }

  static async open(
    stateDirectory: string,
  ): Promise<WorkspaceCommandRuleStore> {
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const statePath = path.join(stateDirectory, "command-rules.json");
    const content = await fs.readFile(statePath, "utf8").catch((error) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (!content) return new WorkspaceCommandRuleStore(stateDirectory, []);
    const parsed = JSON.parse(content) as RulesFile;
    if (
      parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.rules) ||
      !parsed.rules.every(validRule)
    ) {
      throw new Error("command_rules_invalid");
    }
    return new WorkspaceCommandRuleStore(stateDirectory, [...parsed.rules]);
  }

  list(): readonly WorkspaceCommandRule[] {
    return this.rules.map((rule) => ({ ...rule }));
  }

  async add(rule: WorkspaceCommandRule): Promise<void> {
    if (!validRule(rule)) throw new Error("command_rule_invalid");
    this.rules = [
      ...this.rules.filter(
        (candidate) =>
          candidate.command !== rule.command ||
          candidate.cwd !== rule.cwd ||
          candidate.mode !== rule.mode,
      ),
      { ...rule },
    ];
    const content = `${JSON.stringify(
      { schemaVersion: 1, rules: this.rules } satisfies RulesFile,
      null,
      2,
    )}\n`;
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, content, {
      mode: 0o600,
      flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    });
    await fs.rename(temporary, this.statePath);
    await fs.chmod(this.statePath, 0o600);
  }
}

function evaluateRules(
  rules: readonly WorkspaceCommandRule[],
  request: Pick<WorkspaceCommandRule, "command" | "cwd" | "mode">,
): WorkspaceCommandRuleDecision | "unmatched" {
  const matches = rules.filter(
    (rule) =>
      rule.command === request.command &&
      rule.cwd === request.cwd &&
      rule.mode === request.mode,
  );
  if (matches.some((rule) => rule.decision === "forbidden")) return "forbidden";
  if (matches.some((rule) => rule.decision === "prompt")) return "prompt";
  if (matches.some((rule) => rule.decision === "allow")) return "allow";
  return "unmatched";
}

function commandPolicyFingerprint(
  rules: readonly WorkspaceCommandRule[],
  shellExecutable: string,
): string {
  return digest({
    revision: POLICY_REVISION,
    shellExecutable,
    rules: [...rules].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    ),
  });
}

function launchDigest(
  launch:
    | PreparedWorkspaceCommandLaunch
    | Omit<PreparedWorkspaceCommandLaunch, "operationDigest">,
): string {
  const { operationDigest: _operationDigest, ...bound } =
    launch as PreparedWorkspaceCommandLaunch;
  return digest(bound);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function canonicalCommandCwd(
  projectRoot: string,
  commandRoot: string,
  requested: unknown,
): Promise<string> {
  if (requested === undefined) return commandRoot;
  const text = requiredString(requested, "cwd");
  if (path.isAbsolute(text))
    throw new Error("command_cwd_must_be_project_relative");
  return await canonicalPreparedCommandCwd(
    commandRoot,
    path.resolve(projectRoot, text),
  );
}

async function canonicalPreparedCommandCwd(
  projectRoot: string,
  requested: string,
): Promise<string> {
  if (!path.isAbsolute(requested)) {
    throw new Error("command_cwd_not_canonical");
  }
  const canonical = await fs.realpath(requested);
  const stat = await fs.stat(canonical);
  if (!stat.isDirectory()) throw new Error("command_cwd_not_directory");
  const relative = path.relative(projectRoot, canonical);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("command_cwd_outside_project");
  }
  return canonical;
}

function completeEnvironment(
  source: NodeJS.ProcessEnv,
  cwd: string,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) environment[key] = value;
  }
  environment.PWD = cwd;
  if (!environment.PATH) {
    environment.PATH =
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  }
  return environment;
}

/** The host environment plus the call's `env`, with PWD and PATH set. */
function launchEnvironment(
  base: NodeJS.ProcessEnv,
  requested: Readonly<Record<string, string>> | undefined,
  cwd: string,
): Readonly<Record<string, string>> {
  return completeEnvironment({ ...base, ...requested }, cwd);
}

const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MAX_REQUESTED_VARIABLES = 64;

function parseRequestedEnvironment(
  value: unknown,
  base: Readonly<Record<string, string>>,
  overrides: "allow" | "add_only",
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("env_must_be_an_object");
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) return undefined;
  if (entries.length > MAX_REQUESTED_VARIABLES) {
    throw new Error("env_too_many_variables");
  }
  const requested: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!ENVIRONMENT_KEY.test(key)) throw new Error(`env_key_invalid: ${key}`);
    if (typeof entry !== "string") {
      throw new Error(`env_value_must_be_a_string: ${key}`);
    }
    if (key === "PWD") throw new Error("env_pwd_is_host_managed");
    if (overrides === "add_only" && base[key] !== undefined) {
      throw new Error(`env_override_not_allowed: ${key}`);
    }
    requested[key] = entry;
  }
  return requested;
}

/** VS Code's `timeout` in seconds, or a replayed `timeoutMs`. */
function requestedTimeoutMs(input: Readonly<Record<string, unknown>>): number {
  const seconds = input.timeout;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.round(seconds * 1_000)));
  }
  return boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
}

function parseOutputFilter(
  value: unknown,
): CommandOutputFilterOptions | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  const count = (field: unknown) =>
    typeof field === "number" && Number.isFinite(field) && field >= 0
      ? Math.floor(field)
      : undefined;
  const filter: CommandOutputFilterOptions = {
    ...(count(input.output_head) !== undefined
      ? { output_head: count(input.output_head) }
      : {}),
    ...(count(input.output_tail) !== undefined
      ? { output_tail: count(input.output_tail) }
      : {}),
    ...(count(input.output_offset) !== undefined
      ? { output_offset: count(input.output_offset) }
      : {}),
    ...(typeof input.output_grep === "string"
      ? { output_grep: input.output_grep }
      : {}),
    ...(count(input.output_grep_context) !== undefined
      ? { output_grep_context: count(input.output_grep_context) }
      : {}),
  };
  return Object.keys(filter).length > 0 ? filter : undefined;
}

function digestEnvironment(
  environment: Readonly<Record<string, string>>,
  secret: string,
): string {
  const entries = Object.entries(environment).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return createHmac("sha256", secret)
    .update(JSON.stringify(entries))
    .digest("hex");
}

function preparedLaunch(
  value: unknown,
): PreparedWorkspaceCommandLaunch | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const launch = value as Partial<PreparedWorkspaceCommandLaunch>;
  return launch.schemaVersion === 1 &&
    typeof launch.commandId === "string" &&
    typeof launch.ownerId === "string" &&
    typeof launch.sessionId === "string" &&
    typeof launch.turnId === "string" &&
    typeof launch.command === "string" &&
    typeof launch.executable === "string" &&
    Array.isArray(launch.args) &&
    launch.args.every((arg) => typeof arg === "string") &&
    typeof launch.cwd === "string" &&
    Array.isArray(launch.environmentKeys) &&
    launch.environmentKeys.every((item) => typeof item === "string") &&
    typeof launch.environmentDigest === "string" &&
    (launch.requestedEnvironment === undefined ||
      (typeof launch.requestedEnvironment === "object" &&
        launch.requestedEnvironment !== null &&
        Object.values(launch.requestedEnvironment).every(
          (value) => typeof value === "string",
        ))) &&
    (launch.mode === "foreground" || launch.mode === "background") &&
    typeof launch.timeoutMs === "number" &&
    typeof launch.policyFingerprint === "string" &&
    typeof launch.operationDigest === "string"
    ? (launch as PreparedWorkspaceCommandLaunch)
    : undefined;
}

export function isWorkspaceCommandApprovalDisplay(
  value: unknown,
): value is WorkspaceCommandApprovalDisplay {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const display = value as Partial<WorkspaceCommandApprovalDisplay>;
  return (
    display.kind === "command_launch" &&
    typeof display.commandId === "string" &&
    typeof display.command === "string" &&
    typeof display.executable === "string" &&
    Array.isArray(display.args) &&
    display.args.every((arg) => typeof arg === "string") &&
    typeof display.cwd === "string" &&
    Array.isArray(display.environmentKeys) &&
    display.environmentKeys.every((key) => typeof key === "string") &&
    (display.mode === "foreground" || display.mode === "background") &&
    typeof display.timeoutMs === "number" &&
    typeof display.unsandboxed === "boolean" &&
    typeof display.concurrentEditingWarning === "boolean" &&
    typeof display.policyFingerprint === "string" &&
    typeof display.operationDigest === "string"
  );
}

function sameDisplay(
  launch: PreparedWorkspaceCommandLaunch,
  display: WorkspaceCommandApprovalDisplay,
): boolean {
  return (
    display.commandId === launch.commandId &&
    display.command === launch.command &&
    display.executable === launch.executable &&
    JSON.stringify(display.args) === JSON.stringify(launch.args) &&
    display.cwd === launch.cwd &&
    JSON.stringify(display.environmentKeys) ===
      JSON.stringify(launch.environmentKeys) &&
    display.mode === launch.mode &&
    display.timeoutMs === launch.timeoutMs &&
    display.concurrentEditingWarning === (launch.mode === "background") &&
    display.policyFingerprint === launch.policyFingerprint &&
    display.operationDigest === launch.operationDigest
  );
}

function commandResult(observation: WorkspaceCommandObservation) {
  return {
    modelContent: JSON.stringify(observation),
    displayContent: observation,
    isError:
      observation.record.state === "failed" ||
      observation.record.state === "timed_out" ||
      observation.record.state === "interrupted",
  };
}

/**
 * VS Code's `execute_command` result for the model: the filtered output and
 * its line counts, with the exit code and state. The UI keeps the full
 * observation as display content.
 */
function executeCommandResult(
  observation: WorkspaceCommandObservation,
  filter: CommandOutputFilterOptions | undefined,
) {
  const record = observation.record;
  const raw = observation.output.map((chunk) => chunk.text).join("");
  const { filtered, totalLines, linesShown, truncated } = filterCommandOutput(
    raw,
    filter ?? {},
  );
  const running = record.state === "running";
  const complete =
    !observation.truncatedBeforeOffset &&
    record.outputDroppedBytes === 0 &&
    observation.nextOffset >= record.outputEndOffset;
  const result = {
    command: record.command,
    cwd: record.cwd,
    command_id: record.commandId,
    state: record.state,
    exit_code: record.exitCode ?? null,
    ...(record.signal ? { signal: record.signal } : {}),
    timed_out: record.state === "timed_out",
    is_running: running,
    ...(record.mode === "background" ? { backgrounded: true } : {}),
    output: filtered,
    output_complete: complete,
    output_finalized: !running,
    output_dropped_bytes: record.outputDroppedBytes,
    total_lines: totalLines,
    lines_shown: linesShown,
    output_truncated: truncated,
    total_lines_scope: complete && !running ? "complete" : "retained",
    ...(running
      ? {
          output_warning:
            "The command is still running. Read more output with get_command_output.",
        }
      : !complete
        ? {
            output_warning:
              "Older output was not retained. Filtering applies only to retained output.",
          }
        : {}),
  };
  return {
    modelContent: JSON.stringify(result),
    displayContent: observation,
    isError:
      record.state === "failed" ||
      record.state === "timed_out" ||
      record.state === "interrupted",
  };
}

function validRule(value: WorkspaceCommandRule): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof value.command === "string" &&
    value.command.length > 0 &&
    typeof value.cwd === "string" &&
    path.isAbsolute(value.cwd) &&
    (value.mode === "foreground" || value.mode === "background") &&
    (value.decision === "allow" ||
      value.decision === "prompt" ||
      value.decision === "forbidden")
  );
}

function sameTurn(
  discovery: HostToolResolveRequest,
  context: { readonly sessionId: string; readonly turnId: string },
): boolean {
  return (
    discovery.sessionId === context.sessionId &&
    discovery.turnId === context.turnId
  );
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}_required`);
  }
  return value;
}

function optionalInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? Number(value) : undefined;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
    ? Number(value)
    : fallback;
}

function toolError(message: string) {
  return {
    modelContent: message,
    displayContent: { error: message },
    isError: true,
  };
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
