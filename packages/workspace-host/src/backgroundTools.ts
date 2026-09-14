import {
  defineTool,
  type AgentPrincipal,
  type HostTool,
  type HostToolExecutionContext,
  type HostToolResolveRequest,
  type HostToolResolver,
} from "@agentlink/core";

import {
  type SpawnWorkspaceBackgroundRequest,
  type WorkspaceBackgroundSupervisor,
} from "./backgroundSupervisor.js";

export interface CreateWorkspaceBackgroundToolsOptions {
  readonly supervisor: WorkspaceBackgroundSupervisor;
  readonly isForegroundSession: (sessionId: string) => boolean;
}

export interface WorkspaceBackgroundTools<
  TPrincipal extends AgentPrincipal = AgentPrincipal,
> {
  readonly resolveTools: HostToolResolver<TPrincipal>;
}

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
  return defineTool({
    name: "spawn_background_agent",
    description:
      "Start one native write-capable child session with explicit project-relative read and write scopes. At most two children may be active, write scopes must not overlap, and children cannot delegate.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", minLength: 1, maxLength: 8_192 },
        message: { type: "string", minLength: 1, maxLength: 65_536 },
        read_paths: pathScopeArraySchema(),
        write_paths: pathScopeArraySchema(),
        provider_id: { type: "string", minLength: 1 },
        model_id: { type: "string", minLength: 1 },
        reasoning_effort: {
          type: "string",
          enum: ["none", "minimal", "low", "medium", "high", "xhigh"],
        },
      },
      required: ["task", "message", "read_paths", "write_paths"],
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
      const readScopes = parseScopes(input.read_paths);
      const writeScopes = parseScopes(input.write_paths);
      try {
        const record = await options.supervisor.spawn({
          callerSessionId: discovery.sessionId,
          callerTurnId: discovery.turnId,
          task: String(input.task),
          message: String(input.message),
          readScopes,
          writeScopes,
          ...(providerId && modelId ? { model: { providerId, modelId } } : {}),
          ...(typeof input.reasoning_effort === "string"
            ? {
                reasoningEffort:
                  input.reasoning_effort as SpawnWorkspaceBackgroundRequest["reasoningEffort"],
              }
            : {}),
        });
        return toolResult(record);
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
    name: "get_background_status",
    description:
      "Read current lifecycle, phase, scope, bounded output preview, and pending-approval status for one directly owned child session.",
    inputSchema: childTargetSchema(),
    effect: "read",
    parallelSafe: true,
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      try {
        return toolResult(
          options.supervisor.status(target(discovery.sessionId, input)),
        );
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  });
}

function resultTool<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  options: CreateWorkspaceBackgroundToolsOptions,
): HostTool<TPrincipal> {
  return defineTool({
    name: "get_background_result",
    description:
      "Wait for at most wait_seconds for one directly owned child, without cancelling it on timeout. Returns its durable terminal outcome or still-running state.",
    inputSchema: {
      type: "object",
      properties: {
        child_session_id: { type: "string", minLength: 1 },
        wait_seconds: { type: "integer", minimum: 1, maximum: 60 },
      },
      required: ["child_session_id", "wait_seconds"],
      additionalProperties: false,
    },
    effect: "read",
    parallelSafe: true,
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      try {
        const result = await options.supervisor.wait({
          ...target(discovery.sessionId, input),
          timeoutMs: Number(input.wait_seconds) * 1_000,
          signal: context.signal,
        });
        return toolResult(result);
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  });
}

function steerTool<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  options: CreateWorkspaceBackgroundToolsOptions,
): HostTool<TPrincipal> {
  return defineTool({
    name: "steer_background_agent",
    description:
      "Queue one bounded instruction for a directly owned running child. It is applied at the next safe completed-turn boundary and does not interrupt an in-flight provider request or tool.",
    inputSchema: {
      type: "object",
      properties: {
        child_session_id: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1, maxLength: 65_536 },
      },
      required: ["child_session_id", "message"],
      additionalProperties: false,
    },
    effect: "external",
    parallelSafe: false,
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      try {
        return toolResult(
          await options.supervisor.steer({
            ...target(discovery.sessionId, input),
            message: String(input.message),
          }),
        );
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  });
}

function stopTool<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  options: CreateWorkspaceBackgroundToolsOptions,
): HostTool<TPrincipal> {
  return defineTool({
    name: "kill_background_agent",
    description:
      "Stop one directly owned child, release its write reservation, settle a durable cancelled outcome, and preserve bounded partial output.",
    inputSchema: {
      type: "object",
      properties: {
        child_session_id: { type: "string", minLength: 1 },
        reason: { type: "string", minLength: 1, maxLength: 4_096 },
      },
      required: ["child_session_id"],
      additionalProperties: false,
    },
    effect: "external",
    parallelSafe: false,
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      try {
        return toolResult(
          await options.supervisor.stop({
            ...target(discovery.sessionId, input),
            ...(typeof input.reason === "string"
              ? { reason: input.reason }
              : {}),
          }),
        );
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  });
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

function childTargetSchema() {
  return {
    type: "object" as const,
    properties: {
      child_session_id: { type: "string" as const, minLength: 1 },
    },
    required: ["child_session_id"],
    additionalProperties: false,
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

function target(callerSessionId: string, input: Record<string, unknown>) {
  return {
    callerSessionId,
    childSessionId: String(input.child_session_id),
  };
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
