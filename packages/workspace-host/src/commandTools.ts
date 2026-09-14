import {
  defineTool,
  type AgentPrincipal,
  type AuthorizeToolCall,
  type HostTool,
  type HostToolResolveRequest,
  type HostToolResolver,
} from "@agentlink/core";
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
  readonly unsandboxed: true;
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
  readonly ownerId: string;
  readonly supervisor: WorkspaceCommandSupervisor;
  readonly mutations: WorkspaceMutationCoordinator;
  readonly stateDirectory: string;
  readonly shellExecutable?: string;
  readonly environmentDigestSecret: string;
  readonly resolveEnvironment?: () =>
    | NodeJS.ProcessEnv
    | Promise<NodeJS.ProcessEnv>;
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
  const shellExecutable = options.shellExecutable ?? "/bin/zsh";
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
    const cwd = await canonicalCommandCwd(projectRoot, input.cwd);
    const timeoutMs = boundedInteger(
      input.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      1,
      MAX_TIMEOUT_MS,
    );
    const environment = completeEnvironment(
      await (options.resolveEnvironment?.() ?? Promise.resolve(process.env)),
      cwd,
    );
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
      unsandboxed: true,
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
    ),
    observeCommandTool(request, options.supervisor, options.ownerId),
    listCommandsTool(request, options.supervisor, options.ownerId),
    stopCommandTool(request, options.supervisor, options.ownerId),
  ];

  const authorizeToolCall: AuthorizeToolCall = async (request) => {
    if (request.toolName !== "execute_command") {
      return { decision: "deny", reason: "Unsupported command authorization" };
    }
    const prepared = await prepare(request.input, request);
    if (prepared.display.ruleDecision === "forbidden") {
      return {
        decision: "deny",
        reason: "Command forbidden by an explicit rule",
      };
    }
    if (
      prepared.display.mode === "foreground" &&
      !options.requiresApproval?.(prepared.display, request) &&
      (prepared.display.ruleDecision === "allow" ||
        options.hasSessionGrant?.(prepared.display, request))
    ) {
      return { decision: "allow", preparedInput: { launch: prepared.launch } };
    }
    return {
      decision: "require_user",
      summary:
        prepared.display.mode === "background"
          ? "Launch unsandboxed background command with concurrent editing"
          : "Run unsandboxed foreground command",
      displayContent: prepared.display,
      preparedInput: { launch: prepared.launch },
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
        projectRoot,
        launch.cwd,
      ).catch(() => undefined);
      if (cwd !== launch.cwd) {
        return { ok: false, reason: "Command working directory changed" };
      }
      const currentEnvironment = completeEnvironment(
        await (options.resolveEnvironment?.() ?? Promise.resolve(process.env)),
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
      return sameDisplay(launch, request.displayContent)
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
): HostTool {
  return defineTool({
    name: "execute_command",
    description:
      "Run an exact non-interactive command through /bin/zsh -c. There is no PTY, stdin, persistent shell state, or sandbox. Background launch requires explicit concurrent-editing acknowledgement.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, maxLength: 32_000 },
        cwd: {
          type: "string",
          description:
            "Project-relative working directory. Defaults to the project root.",
        },
        background: { type: "boolean" },
        timeoutMs: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS },
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
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
      const environment = completeEnvironment(
        await (resolveEnvironment?.() ?? Promise.resolve(process.env)),
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
      return commandResult(observation);
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
  requested: unknown,
): Promise<string> {
  const text = requested === undefined ? "." : requiredString(requested, "cwd");
  if (path.isAbsolute(text))
    throw new Error("command_cwd_must_be_project_relative");
  return await canonicalPreparedCommandCwd(
    projectRoot,
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
    display.unsandboxed === true &&
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
