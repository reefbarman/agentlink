import {
  defineTool,
  type AgentPrincipal,
  type CoreModelMessage,
  type HostTool,
  type HostToolResolveRequest,
  type HostToolResolver,
} from "@agentlink/core";
import {
  TODO_WRITE_INPUT_SCHEMA,
  getLatestTodoState,
  handleTodoWrite,
  todoTool,
} from "@agentlink/core/todo-tool";
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
  /**
   * Answers `ask_user`. Without it only `todo_write` is offered, for hosts
   * with no way to put a question to the user.
   */
  readonly askQuestion?: (
    request: WorkspaceQuestionRequest,
    context: { readonly sessionId: string; readonly signal?: AbortSignal },
  ) => Promise<string>;
  readonly onTodosChanged?: (
    sessionId: string,
    todos: readonly TodoItem[],
  ) => void;
  /**
   * The session's stored transcript. A session's todo list is rebuilt from
   * it, as VS Code does, the first time this process sees the session.
   */
  readonly readTranscript?: (
    sessionId: string,
  ) => Promise<readonly CoreModelMessage[]>;
}

export interface WorkspaceSessionInteractionTools {
  readonly resolveTools: HostToolResolver;
  readonly snapshot: (sessionId: string) => WorkspaceSessionInteractionSnapshot;
  /**
   * Seed a session's todo list from its transcript unless this process
   * already holds one. A list the model wrote in this process always wins.
   */
  readonly restore: (
    sessionId: string,
    messages: readonly CoreModelMessage[],
  ) => void;
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
  const restore = (
    sessionId: string,
    messages: readonly CoreModelMessage[],
  ): void => {
    if (todos.has(sessionId)) return;
    todos.set(sessionId, getLatestTodoState([...messages]));
  };
  const { askQuestion } = options;
  const resolveTools: HostToolResolver = async (request) => {
    if (!todos.has(request.sessionId) && options.readTranscript) {
      const messages = await options.readTranscript(request.sessionId);
      restore(request.sessionId, messages);
    }
    return [
      ...(askQuestion ? [createAskUserTool(request, askQuestion)] : []),
      createTodoWriteTool(request, todos, options),
    ];
  };
  return { resolveTools, snapshot, restore };
}

function createAskUserTool<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  askQuestion: NonNullable<
    CreateWorkspaceSessionInteractionToolsOptions["askQuestion"]
  >,
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
        const answer = await askQuestion(request, {
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
  // VS Code's todo_write: same description, schema and guidance result.
  return defineTool({
    name: todoTool.name,
    description: todoTool.description,
    inputSchema: TODO_WRITE_INPUT_SCHEMA,
    effect: "read",
    parallelSafe: false,
    displayInput: (input) => ({
      count: Array.isArray(input.todos) ? input.todos.length : 0,
    }),
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      const result = handleTodoWrite({
        todos: structuredClone(input.todos as TodoItem[]),
      });
      const next = result.todos;
      todos.set(context.sessionId, next);
      options.onTodosChanged?.(context.sessionId, next);
      return {
        modelContent: result.content,
        displayContent: { todos: next },
      };
    },
  });
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
