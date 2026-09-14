import {
  defineTool,
  type AgentPrincipal,
  type HostTool,
  type HostToolResolveRequest,
  type HostToolResolver,
} from "@agentlink/core";
import type { TodoItem } from "@agentlink/protocol/chat-transcript";

export type WorkspaceQuestionKind = "confirmation" | "multiple_choice" | "text";

export interface WorkspaceQuestionRequest {
  readonly id: string;
  readonly kind: WorkspaceQuestionKind;
  readonly question: string;
  readonly context?: string;
  readonly options: readonly string[];
  readonly recommended?: string;
}

export interface WorkspaceSessionInteractionSnapshot {
  readonly todos: readonly TodoItem[];
}

export interface CreateWorkspaceSessionInteractionToolsOptions {
  readonly askQuestion: (
    request: WorkspaceQuestionRequest,
    context: { readonly sessionId: string; readonly signal?: AbortSignal },
  ) => Promise<string>;
  readonly onTodosChanged?: (
    sessionId: string,
    todos: readonly TodoItem[],
  ) => void;
}

export interface WorkspaceSessionInteractionTools {
  readonly resolveTools: HostToolResolver;
  readonly snapshot: (sessionId: string) => WorkspaceSessionInteractionSnapshot;
}

export function createWorkspaceSessionInteractionTools(
  options: CreateWorkspaceSessionInteractionToolsOptions,
): WorkspaceSessionInteractionTools {
  const todos = new Map<string, readonly TodoItem[]>();
  const snapshot = (
    sessionId: string,
  ): WorkspaceSessionInteractionSnapshot => ({
    todos: structuredClone(todos.get(sessionId) ?? []),
  });
  const resolveTools: HostToolResolver = async (request) => [
    createAskUserTool(request, options),
    createTodoWriteTool(request, todos, options),
  ];
  return { resolveTools, snapshot };
}

function createAskUserTool<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  options: CreateWorkspaceSessionInteractionToolsOptions,
): HostTool<TPrincipal> {
  return defineTool({
    name: "ask_user",
    description:
      "Ask the user one structured confirmation, multiple-choice, or text question and wait for their answer before continuing.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, maxLength: 128 },
        kind: {
          type: "string",
          enum: ["confirmation", "multiple_choice", "text"],
        },
        question: { type: "string", minLength: 1, maxLength: 4_096 },
        context: { type: "string", maxLength: 8_192 },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 12,
          items: { type: "string", minLength: 1, maxLength: 512 },
        },
        recommended: { type: "string", minLength: 1, maxLength: 512 },
      },
      required: ["id", "kind", "question"],
      additionalProperties: false,
    },
    effect: "read",
    parallelSafe: false,
    displayInput: (input) => ({
      id: input.id,
      kind: input.kind,
      question: input.question,
    }),
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      const kind = input.kind as WorkspaceQuestionKind;
      if (
        kind !== "text" &&
        (!Array.isArray(input.options) || input.options.length < 2)
      ) {
        return toolError("Question choices require at least two options");
      }
      const request: WorkspaceQuestionRequest = {
        id: String(input.id),
        kind,
        question: String(input.question),
        ...(typeof input.context === "string"
          ? { context: input.context }
          : {}),
        options: Array.isArray(input.options)
          ? input.options.map((value) => String(value))
          : [],
        ...(typeof input.recommended === "string"
          ? { recommended: input.recommended }
          : {}),
      };
      try {
        const answer = await options.askQuestion(request, {
          sessionId: context.sessionId,
          signal: context.signal,
        });
        const payload = { id: request.id, answer };
        return {
          modelContent: JSON.stringify(payload),
          displayContent: payload,
        };
      } catch (error) {
        if (context.signal?.aborted || isAbortError(error)) throw error;
        return toolError(errorMessage(error));
      }
    },
  });
}

function createTodoWriteTool<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  todos: Map<string, readonly TodoItem[]>,
  options: CreateWorkspaceSessionInteractionToolsOptions,
): HostTool<TPrincipal> {
  return defineTool({
    name: "todo_write",
    description:
      "Replace the current session's visible task list. Keep exactly one task in progress while work remains.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          maxItems: 50,
          items: todoSchema(0),
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    effect: "read",
    parallelSafe: false,
    displayInput: (input) => ({
      count: Array.isArray(input.todos) ? input.todos.length : 0,
    }),
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      const next = structuredClone(input.todos as TodoItem[]);
      todos.set(context.sessionId, next);
      options.onTodosChanged?.(context.sessionId, next);
      const payload = { todos: next };
      return {
        modelContent: JSON.stringify({ updated: next.length }),
        displayContent: payload,
      };
    },
  });
}

function todoSchema(depth: number): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    id: { type: "string", minLength: 1, maxLength: 256 },
    content: { type: "string", minLength: 1, maxLength: 4_096 },
    activeForm: { type: "string", minLength: 1, maxLength: 4_096 },
    status: { type: "string", enum: ["pending", "in_progress", "completed"] },
  };
  if (depth < 3) {
    properties.children = {
      type: "array",
      maxItems: 50,
      items: todoSchema(depth + 1),
    };
  }
  return {
    type: "object",
    properties,
    required: ["id", "content", "activeForm", "status"],
    additionalProperties: false,
  };
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

function toolError(message: string) {
  return {
    modelContent: JSON.stringify({ error: message }),
    displayContent: { error: message },
    isError: true,
  } as const;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
