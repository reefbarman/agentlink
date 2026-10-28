import {
  defineTool,
  type AgentModelReference,
  type AgentPrincipal,
  type CoreModelJsonSchema,
  type HostTool,
  type HostToolExecutionContext,
  type HostToolResolveRequest,
  type HostToolResolver,
} from "@agentlink/core";
import {
  FORBIDDEN_PATHS_PROPERTY,
  OWNED_PATHS_PROPERTY,
  GET_BACKGROUND_STATUS_TOOL,
  KILL_BACKGROUND_AGENT_TOOL,
  STEER_BACKGROUND_AGENT_TOOL,
  backgroundResultsPendingEntry,
  buildBackgroundDenialPayload,
  buildBackgroundFailurePayload,
  buildBackgroundResultsPayload,
  buildBackgroundStatusDenial,
  buildBackgroundStillRunningPayload,
  buildBackgroundWaitCancelledPayload,
  getBackgroundResultToolDefinition,
  type BackgroundAgentKillResult,
  type BackgroundAgentStatusResult,
  type BackgroundResultState,
  type BackgroundResultsCompletedEntry,
} from "@agentlink/core/background-agent-tools";

import {
  type SpawnWorkspaceBackgroundRequest,
  type WorkspaceBackgroundRecord,
  type WorkspaceBackgroundSupervisor,
} from "./backgroundSupervisor.js";

export interface CreateWorkspaceBackgroundToolsOptions {
  readonly supervisor: WorkspaceBackgroundSupervisor;
  readonly isForegroundSession: (sessionId: string) => boolean;
  /**
   * Named models a parent may ask for with `model_role` (for example
   * `review`) instead of an exact provider and model.
   */
  readonly modelRoles?: Readonly<Record<string, AgentModelReference>>;
  /** Clock for elapsed and idle times; defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface WorkspaceBackgroundTools<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly resolveTools: HostToolResolver<TPrincipal>;
}

/**
 * `get_background_status` for a workspace child: VS Code's fields, then the
 * child's ID, task, scopes and any approval it is waiting on, which VS Code
 * does not report.
 */
export type WorkspaceBackgroundStatus = BackgroundAgentStatusResult & {
  readonly sessionId: string;
  readonly task: string;
  readonly scopes: WorkspaceBackgroundRecord["scopes"];
  readonly forbiddenPaths?: readonly string[];
  readonly pendingApproval?: {
    readonly toolName: string;
    readonly summary: string;
  };
  readonly steeringQueued?: number;
};

/** Preview of a running child's output, like VS Code's `streamingPreview`. */
const STREAMING_PREVIEW_CHARS = 2_000;

/** Foreground-only model tools over the host-owned one-level supervisor. */
export function createWorkspaceBackgroundTools<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
>(
  options: CreateWorkspaceBackgroundToolsOptions,
): WorkspaceBackgroundTools<TPrincipal> {
  const resolveTools: HostToolResolver<TPrincipal> = (request) => {
    if (!options.isForegroundSession(request.sessionId)) return [];
    return [
      spawnTool(request, options),
      statusTool(request, options),
      resultTool(request, options),
      steerTool(request, options),
      stopTool(request, options),
    ];
  };
  return { resolveTools };
}

function spawnTool<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  options: CreateWorkspaceBackgroundToolsOptions,
): HostTool<TPrincipal> {
  const roles = Object.keys(options.modelRoles ?? {}).sort();
  const limit = options.supervisor.activeChildLimit;
  return defineTool({
    name: "spawn_background_agent",
    description: [
      `Start one native child session in this project. It may write only inside its ownedPaths (none makes a read-only child, such as a reviewer), never inside forbiddenPaths, and reads the whole project unless read_paths narrows it. At most ${limit} ${limit === 1 ? "child" : "children"} may be active, owned paths must not overlap another running child's, and children cannot delegate. Returns the child's sessionId for get_background_status, get_background_result, steer_background_agent and kill_background_agent.`,
      roles.length > 0
        ? `Set model_role to run the child on a configured model (${roles.join(", ")}); use "review" for reviews when available.`
        : undefined,
    ]
      .filter(Boolean)
      .join(" "),
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          minLength: 1,
          maxLength: 8_192,
          description: "Short label shown in the UI (max 50 chars)",
        },
        message: {
          type: "string",
          minLength: 1,
          maxLength: 65_536,
          description:
            "Full instruction for the background agent. Be specific and self-contained. For writable work, include the files it owns, files to avoid, allowed commands/tests, and how to report conflicts.",
        },
        ownedPaths: {
          ...OWNED_PATHS_PROPERTY,
          maxItems: 64,
          items: { type: "string", minLength: 1 },
          description:
            "Project-relative files or directories the agent may write (a trailing / marks a directory that does not exist yet). Enforced. Fixed when spawned; steering cannot widen this boundary. For additional paths, edit them in the coordinator or spawn a replacement with the required scope.",
        },
        forbiddenPaths: {
          ...FORBIDDEN_PATHS_PROPERTY,
          maxItems: 64,
          items: { type: "string", minLength: 1 },
        },
        read_paths: {
          ...pathScopeArraySchema(),
          description:
            "Optional: limit what the agent may read to these files and directories. Defaults to the whole project.",
        },
        write_paths: {
          ...pathScopeArraySchema(),
          description: "Deprecated: use ownedPaths.",
        },
        ...(roles.length > 0
          ? { model_role: { type: "string", enum: roles } }
          : {}),
        provider_id: { type: "string", minLength: 1 },
        model_id: { type: "string", minLength: 1 },
        reasoning_effort: {
          type: "string",
          enum: ["none", "minimal", "low", "medium", "high", "xhigh"],
        },
      },
      required: ["task", "message"],
      additionalProperties: false,
    },
    effect: "external",
    parallelSafe: false,
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      const providerId = optionalString(input.provider_id);
      const modelId = optionalString(input.model_id);
      if ((providerId === undefined) !== (modelId === undefined)) {
        return toolError("provider_id_and_model_id_must_be_supplied_together");
      }
      const role = optionalString(input.model_role);
      if (role !== undefined && providerId !== undefined) {
        return toolError("model_role_conflicts_with_provider_id_and_model_id");
      }
      const roleModel =
        role !== undefined && Object.hasOwn(options.modelRoles ?? {}, role)
          ? options.modelRoles![role]
          : undefined;
      if (role !== undefined && !roleModel) {
        return toolError("model_role_not_configured");
      }
      const model = roleModel
        ? { providerId: roleModel.providerId, modelId: roleModel.modelId }
        : providerId && modelId
          ? { providerId, modelId }
          : undefined;
      try {
        const record = await options.supervisor.spawn({
          callerSessionId: discovery.sessionId,
          callerTurnId: discovery.turnId,
          task: String(input.task),
          message: String(input.message),
          ...(input.read_paths !== undefined
            ? { readScopes: parseScopes(input.read_paths) }
            : {}),
          ...(input.write_paths !== undefined
            ? { writeScopes: parseScopes(input.write_paths) }
            : {}),
          ...(Array.isArray(input.ownedPaths)
            ? { ownedPaths: input.ownedPaths.map(String) }
            : {}),
          ...(Array.isArray(input.forbiddenPaths)
            ? { forbiddenPaths: input.forbiddenPaths.map(String) }
            : {}),
          ...(model ? { model } : {}),
          ...(typeof input.reasoning_effort === "string"
            ? {
                reasoningEffort:
                  input.reasoning_effort as SpawnWorkspaceBackgroundRequest["reasoningEffort"],
              }
            : {}),
        });
        return toolResult({
          sessionId: record.childSessionId,
          ...(record.model
            ? {
                resolvedModel: record.model.modelId,
                resolvedProvider: record.model.providerId,
              }
            : {}),
          ...(record.reasoningEffort
            ? { reasoningEffort: record.reasoningEffort }
            : {}),
          routingReason: roleModel
            ? `model_role ${role}`
            : model
              ? "explicit provider_id and model_id"
              : "parent session model",
          fallbackUsed: false,
          task: record.task,
          scopes: record.scopes,
          ...(record.forbidden
            ? { forbiddenPaths: record.forbidden.map((entry) => entry.path) }
            : {}),
        });
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  });
}

function statusTool<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  options: CreateWorkspaceBackgroundToolsOptions,
): HostTool<TPrincipal> {
  return defineTool({
    name: GET_BACKGROUND_STATUS_TOOL.name,
    description: GET_BACKGROUND_STATUS_TOOL.description,
    inputSchema: withSessionIdAlias(GET_BACKGROUND_STATUS_TOOL.input_schema),
    effect: "read",
    parallelSafe: true,
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      const request = target(discovery.sessionId, input);
      try {
        return toolResult(
          workspaceBackgroundStatus(
            options.supervisor.status(request),
            now(options),
          ),
        );
      } catch (error) {
        const denial = denialFor(error, request, options);
        return denial
          ? toolResult(buildBackgroundStatusDenial(denial))
          : toolError(errorMessage(error));
      }
    },
  });
}

function resultTool<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  options: CreateWorkspaceBackgroundToolsOptions,
): HostTool<TPrincipal> {
  // Waits end on completion, timeout or cancellation; a message the user
  // sends meanwhile is taken at the parent's next turn boundary.
  const definition = getBackgroundResultToolDefinition({
    interruptsOnUserMessage: false,
  });
  return defineTool({
    name: definition.name,
    description: definition.description,
    inputSchema: withResultSessionIdAlias(definition.input_schema),
    effect: "read",
    parallelSafe: true,
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      const timeoutMs = Number(input.wait_seconds) * 1_000;
      if (Array.isArray(input.sessionIds)) {
        return await waitForSeveral(discovery, options, context, {
          childSessionIds: input.sessionIds.map(String),
          returnWhen: input.return_when === "all" ? "all" : "any",
          timeoutMs,
        });
      }
      const request = target(discovery.sessionId, input);
      try {
        const waited = await options.supervisor.wait({
          ...request,
          timeoutMs,
          signal: context.signal,
        });
        if (waited.status === "completed") {
          const outcome = workspaceBackgroundOutcome(waited.record);
          return {
            modelContent: outcome.result,
            displayContent: {
              status: "completed",
              sessionId: request.childSessionId,
              done: true,
              resultState: outcome.resultState,
              ...(outcome.terminalReason
                ? { terminalReason: outcome.terminalReason }
                : {}),
              result: outcome.result,
            },
          };
        }
        return toolResult(
          waited.status === "still_running"
            ? buildBackgroundStillRunningPayload(
                request.childSessionId,
                workspaceBackgroundStatus(waited.record, now(options)),
              )
            : buildBackgroundWaitCancelledPayload(request.childSessionId),
        );
      } catch (error) {
        const denial = denialFor(error, request, options);
        return denial
          ? toolResult(buildBackgroundDenialPayload(denial))
          : toolError(errorMessage(error));
      }
    },
  });
}

async function waitForSeveral<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  options: CreateWorkspaceBackgroundToolsOptions,
  context: HostToolExecutionContext<TPrincipal>,
  request: {
    readonly childSessionIds: readonly string[];
    readonly returnWhen: "any" | "all";
    readonly timeoutMs: number;
  },
) {
  // Authorize every child first so a denied request waits for nothing.
  for (const childSessionId of request.childSessionIds) {
    const single = { callerSessionId: discovery.sessionId, childSessionId };
    try {
      options.supervisor.status(single);
    } catch (error) {
      const denial = denialFor(error, single, options);
      return denial
        ? toolResult(
            buildBackgroundDenialPayload({
              ...denial,
              sessionId: childSessionId,
            }),
          )
        : toolError(errorMessage(error));
    }
  }
  try {
    const waited = await options.supervisor.waitMany({
      callerSessionId: discovery.sessionId,
      childSessionIds: request.childSessionIds,
      returnWhen: request.returnWhen,
      timeoutMs: request.timeoutMs,
      signal: context.signal,
    });
    const timestamp = now(options);
    const completed: BackgroundResultsCompletedEntry[] = [];
    const pending = [];
    for (const record of waited.records) {
      if (isTerminalRecord(record)) {
        const outcome = workspaceBackgroundOutcome(record);
        completed.push({
          sessionId: record.childSessionId,
          result: outcome.result,
          resultState: outcome.resultState,
          terminalReason: outcome.terminalReason,
          retrySafe: true,
          agentRetryable: false,
        });
      } else {
        pending.push(
          backgroundResultsPendingEntry(
            record.childSessionId,
            workspaceBackgroundStatus(record, timestamp),
          ),
        );
      }
    }
    return toolResult(
      buildBackgroundResultsPayload({
        status: waited.status,
        returnWhen: request.returnWhen,
        completed,
        pending,
      }),
    );
  } catch (error) {
    return toolError(errorMessage(error));
  }
}

function steerTool<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  options: CreateWorkspaceBackgroundToolsOptions,
): HostTool<TPrincipal> {
  return defineTool({
    name: STEER_BACKGROUND_AGENT_TOOL.name,
    description: STEER_BACKGROUND_AGENT_TOOL.description,
    inputSchema: withSessionIdAlias(STEER_BACKGROUND_AGENT_TOOL.input_schema, {
      message: { type: "string", minLength: 1, maxLength: 65_536 },
    }),
    effect: "external",
    parallelSafe: false,
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      const request = target(discovery.sessionId, input);
      try {
        await options.supervisor.steer({
          ...request,
          message: String(input.message),
        });
        return toolResult({ accepted: true });
      } catch (error) {
        const denial = denialFor(error, request, options);
        if (denial)
          return toolResult({ accepted: false, reason: denial.error });
        const message = errorMessage(error);
        return toolResult({
          accepted: false,
          reason:
            message === "background_child_not_running"
              ? "session is not currently running"
              : message === "background_steering_queue_full"
                ? "the session cannot accept more steering messages until it reaches a turn boundary"
                : message,
        });
      }
    },
  });
}

function stopTool<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  options: CreateWorkspaceBackgroundToolsOptions,
): HostTool<TPrincipal> {
  return defineTool({
    name: KILL_BACKGROUND_AGENT_TOOL.name,
    description: KILL_BACKGROUND_AGENT_TOOL.description,
    inputSchema: withSessionIdAlias(KILL_BACKGROUND_AGENT_TOOL.input_schema, {
      reason: { type: "string", minLength: 1, maxLength: 4_096 },
    }),
    effect: "external",
    parallelSafe: false,
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      const request = target(discovery.sessionId, input);
      try {
        const before = options.supervisor.status(request);
        const record = await options.supervisor.stop({
          ...request,
          ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
        });
        const result: BackgroundAgentKillResult = {
          killed: !isTerminalRecord(before) && record.lifecycle === "cancelled",
          ...(record.partialOutput
            ? { partialOutput: record.partialOutput }
            : {}),
        };
        return toolResult(result);
      } catch (error) {
        const denial = denialFor(error, request, options);
        return denial
          ? toolResult({ killed: false, partialOutput: denial.error })
          : toolError(errorMessage(error));
      }
    },
  });
}

/** VS Code's status fields for a workspace child, plus its scope. */
export function workspaceBackgroundStatus(
  record: WorkspaceBackgroundRecord,
  timestamp: number,
): WorkspaceBackgroundStatus {
  const done = isTerminalRecord(record);
  const elapsedMs =
    record.startedAt === undefined
      ? 0
      : Math.max(
          0,
          (done ? (record.completedAt ?? record.updatedAt) : timestamp) -
            record.startedAt,
        );
  const canSteer =
    record.lifecycle === "running" || record.lifecycle === "awaiting_approval";
  return {
    status: STATUS_BY_LIFECYCLE[record.lifecycle](record),
    currentTool: record.currentTool,
    displayStatus: displayStatus(record),
    ...(!done && record.partialOutput
      ? {
          streamingPreview: record.partialOutput.slice(
            -STREAMING_PREVIEW_CHARS,
          ),
        }
      : {}),
    resolvedModel: record.model?.modelId,
    resolvedProvider: record.model?.providerId,
    reasoningEffort: record.reasoningEffort,
    resultState: record.resultState,
    terminalReason: record.terminalReason,
    retrySafe: done ? true : undefined,
    agentRetryable: done ? false : undefined,
    phase: record.phase,
    startedAt: record.startedAt,
    lastProgressAt: record.updatedAt,
    elapsedMs,
    idleMs: done ? undefined : Math.max(0, timestamp - record.updatedAt),
    canSteer,
    canKill: !done,
    done,
    partialOutput: done
      ? (record.partialOutput ?? record.resultText)
      : undefined,
    sessionId: record.childSessionId,
    task: record.task,
    scopes: record.scopes,
    ...(record.forbidden
      ? { forbiddenPaths: record.forbidden.map((entry) => entry.path) }
      : {}),
    ...(record.approval
      ? {
          pendingApproval: {
            toolName: record.approval.toolName,
            summary: record.approval.summary,
          },
        }
      : {}),
    ...(record.steeringQueued > 0
      ? { steeringQueued: record.steeringQueued }
      : {}),
  };
}

/**
 * What `get_background_result` returns for a finished workspace child: its
 * final text when it completed with some, otherwise VS Code's failure JSON.
 */
export function workspaceBackgroundOutcome(record: WorkspaceBackgroundRecord): {
  readonly result: string;
  readonly resultState: BackgroundResultState;
  readonly terminalReason?: string;
} {
  if (record.lifecycle === "completed" && record.resultText?.trim()) {
    return { result: record.resultText, resultState: "completed" };
  }
  if (record.lifecycle === "completed") {
    return {
      result: JSON.stringify(
        buildBackgroundFailurePayload({
          status: "incomplete_expected_result",
          terminalReason: "incomplete_expected_result",
          retrySafe: true,
          agentRetryable: false,
          expectedResultIssue:
            "The agent stopped without a completed final text result. Any partial output is evidence only, not a completed review.",
          ...(record.partialOutput
            ? { partialOutput: record.partialOutput }
            : {}),
        }),
      ),
      resultState: "incomplete_expected_result",
      terminalReason: "incomplete_expected_result",
    };
  }
  const terminalReason = record.terminalReason ?? record.resultState;
  return {
    result: JSON.stringify(
      buildBackgroundFailurePayload({
        status: record.resultState,
        terminalReason,
        retrySafe: true,
        agentRetryable: false,
        ...(record.partialOutput
          ? { partialOutput: record.partialOutput }
          : {}),
      }),
    ),
    resultState: record.resultState,
    terminalReason,
  };
}

const STATUS_BY_LIFECYCLE: Record<
  WorkspaceBackgroundRecord["lifecycle"],
  (record: WorkspaceBackgroundRecord) => BackgroundAgentStatusResult["status"]
> = {
  queued: () => "queued",
  running: (record) => (record.currentTool ? "tool_executing" : "streaming"),
  awaiting_approval: () => "awaiting_approval",
  completed: () => "idle",
  cancelled: () => "cancelled",
  failed: () => "error",
  interrupted: () => "error",
};

function displayStatus(record: WorkspaceBackgroundRecord): string {
  switch (record.lifecycle) {
    case "queued":
      return "Queued";
    case "running":
      return record.currentTool ? `Running ${record.currentTool}` : "Working";
    case "awaiting_approval":
      return record.approval
        ? `Waiting for approval: ${record.approval.toolName}`
        : "Waiting for approval";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
  }
}

function isTerminalRecord(record: WorkspaceBackgroundRecord): boolean {
  return (
    record.lifecycle === "completed" ||
    record.lifecycle === "failed" ||
    record.lifecycle === "cancelled" ||
    record.lifecycle === "interrupted"
  );
}

/**
 * VS Code's not-found and authorization denials for a child the caller cannot
 * manage. A not-found denial lists the caller's children so the model can
 * correct a mistyped ID.
 */
function denialFor(
  error: unknown,
  request: {
    readonly callerSessionId: string;
    readonly childSessionId: string;
  },
  options: CreateWorkspaceBackgroundToolsOptions,
): { notFound: boolean; terminalReason: string; error: string } | undefined {
  const message = errorMessage(error);
  if (message === "background_child_not_found") {
    return {
      notFound: true,
      terminalReason: "background_session_not_found",
      error: `Session ${request.childSessionId} is not a background agent of this session. ${describeChildren(request.callerSessionId, options)}`,
    };
  }
  if (message === "background_child_not_owned") {
    return {
      notFound: false,
      terminalReason: "background_session_not_owned",
      error: `Session ${request.childSessionId} is a background agent of another session; only the session that started it can manage it.`,
    };
  }
  return undefined;
}

function describeChildren(
  callerSessionId: string,
  options: CreateWorkspaceBackgroundToolsOptions,
): string {
  let children: readonly WorkspaceBackgroundRecord[];
  try {
    children = options.supervisor.list(callerSessionId);
  } catch {
    return "";
  }
  if (children.length === 0) return "This session has no background agents.";
  const shown = children
    .slice(-8)
    .map(
      (child) =>
        `${child.childSessionId} ("${child.task}") [${child.lifecycle}]`,
    );
  const omitted = children.length - shown.length;
  return `Background agents of this session: ${shown.join(", ")}${omitted > 0 ? ` and ${omitted} older` : ""}.`;
}

const LEGACY_CHILD_ID_PROPERTY = {
  type: "string",
  minLength: 1,
  description: "Deprecated: use sessionId.",
} as const;

/**
 * VS Code's schema for a single-agent tool, also accepting the
 * `child_session_id` field older workspace sessions used.
 */
function withSessionIdAlias(
  schema: CoreModelJsonSchema,
  overrides: Record<string, unknown> = {},
): CoreModelJsonSchema {
  const copy = structuredClone(schema) as Record<string, unknown>;
  const properties = copy.properties as Record<string, unknown>;
  copy.properties = {
    ...properties,
    sessionId: { ...(properties.sessionId as object), minLength: 1 },
    ...overrides,
    child_session_id: LEGACY_CHILD_ID_PROPERTY,
  };
  const required = (copy.required as string[]).filter(
    (name) => name !== "sessionId",
  );
  if (required.length > 0) copy.required = required;
  else delete copy.required;
  copy.anyOf = [
    {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
    {
      type: "object",
      properties: { child_session_id: { type: "string" } },
      required: ["child_session_id"],
    },
  ];
  return copy as CoreModelJsonSchema;
}

/** VS Code's `get_background_result` schema plus the legacy single form. */
function withResultSessionIdAlias(
  schema: CoreModelJsonSchema,
): CoreModelJsonSchema {
  const copy = structuredClone(schema) as Record<string, unknown>;
  copy.properties = {
    ...(copy.properties as Record<string, unknown>),
    child_session_id: LEGACY_CHILD_ID_PROPERTY,
  };
  copy.oneOf = [
    ...(copy.oneOf as unknown[]),
    {
      type: "object",
      properties: {
        child_session_id: LEGACY_CHILD_ID_PROPERTY,
        wait_seconds: { type: "integer", minimum: 1, maximum: 60 },
      },
      required: ["child_session_id", "wait_seconds"],
      additionalProperties: false,
    },
  ];
  return copy as CoreModelJsonSchema;
}

function pathScopeArraySchema() {
  return {
    type: "array" as const,
    maxItems: 64,
    items: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, minLength: 1 },
        kind: { type: "string" as const, enum: ["file", "directory"] },
      },
      required: ["path", "kind"],
      additionalProperties: false,
    },
  };
}

function parseScopes(
  value: unknown,
): Array<{ path: string; kind: "file" | "directory" }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("background_scopes_invalid");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("background_scope_invalid");
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.path !== "string" ||
      (record.kind !== "file" && record.kind !== "directory")
    ) {
      throw new Error("background_scope_invalid");
    }
    return { path: record.path, kind: record.kind };
  });
}

/** The child a single-agent call names, by `sessionId` or the legacy field. */
function target(callerSessionId: string, input: Record<string, unknown>) {
  return {
    callerSessionId,
    childSessionId: String(input.sessionId ?? input.child_session_id),
  };
}

function now(options: CreateWorkspaceBackgroundToolsOptions): number {
  return (options.now ?? Date.now)();
}

function toolResult(value: unknown) {
  const payload = structuredClone(value);
  return {
    modelContent: JSON.stringify(payload),
    displayContent: payload,
  };
}

function toolError(message: string) {
  return {
    modelContent: message,
    displayContent: { error: message },
    isError: true,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sameTurn<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  invocation: HostToolExecutionContext<TPrincipal>,
): boolean {
  return (
    discovery.principal.tenantId === invocation.principal.tenantId &&
    discovery.principal.subjectId === invocation.principal.subjectId &&
    discovery.sessionId === invocation.sessionId &&
    discovery.turnId === invocation.turnId
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
