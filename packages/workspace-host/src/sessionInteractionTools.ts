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
  completeTodos,
  getLatestTodoState,
  handleTodoWrite,
  todoTool,
} from "@agentlink/core/todo-tool";
import {
  SET_TASK_STATUS_TOOL,
  askUserToolDefinition,
  buildAskUserResultPayload,
  buildTaskStatusMarker,
  buildTaskStatusResultPayload,
  isTaskStatus,
  parseAskUserInput,
} from "@agentlink/core/interaction-tools";
import type { TodoItem } from "@agentlink/protocol/chat-transcript";
import type { FinalMessageMarker } from "@agentlink/protocol/final-status";
import type {
  UserQuestion,
  UserQuestionResponse,
} from "@agentlink/protocol/structured-question";

/** One `ask_user` call, validated as VS Code does. */
export interface WorkspaceQuestionsRequest {
  /** Shared intro shown above the questions; may be empty. */
  readonly context: string;
  /** VS Code's question shapes, without `modeSwitch`. */
  readonly questions: readonly UserQuestion[];
}

/** Answers and optional notes keyed by question ID. */
export type WorkspaceQuestionsResponse = Pick<
  UserQuestionResponse,
  "answers" | "notes"
>;

export interface WorkspaceSessionInteractionSnapshot {
  readonly todos: readonly TodoItem[];
}

/** `set_task_status`'s `displayContent`: the final card, plus todos it completed. */
export interface WorkspaceFinalStatusDisplay {
  readonly finalStatus: FinalMessageMarker;
  readonly todos?: readonly TodoItem[];
}

export interface CreateWorkspaceSessionInteractionToolsOptions {
  /**
   * Answers VS Code's `ask_user`. Without it only `todo_write` is offered,
   * for hosts with no way to put a question to the user. Throw an
   * `AbortError` when the user cancels so the turn stops.
   */
  readonly askQuestions?: (
    request: WorkspaceQuestionsRequest,
    context: { readonly sessionId: string; readonly signal?: AbortSignal },
  ) => Promise<WorkspaceQuestionsResponse>;
  /**
   * Offer VS Code's `set_task_status`, which ends the turn with a final
   * summary and optional continue action unless a user message is queued.
   */
  readonly finalStatus?: boolean;
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
  const { askQuestions } = options;
  const resolveTools: HostToolResolver = async (request) => {
    if (!todos.has(request.sessionId) && options.readTranscript) {
      const messages = await options.readTranscript(request.sessionId);
      restore(request.sessionId, messages);
    }
    return [
      ...(askQuestions ? [createAskUserTool(request, askQuestions)] : []),
      createTodoWriteTool(request, todos, options),
      ...(options.finalStatus
        ? [createSetTaskStatusTool(request, todos, options)]
        : []),
    ];
  };
  return { resolveTools, snapshot, restore };
}

/**
 * VS Code's `ask_user` without `modeSwitch` (no modes yet) or attachments,
 * and with every question going to the user: background children here have
 * no coordinator to answer first.
 */
const STANDALONE_ASK_USER_TOOL = askUserToolDefinition({
  modeSwitch: false,
  backgroundCoordinator: false,
});

function createAskUserTool<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  askQuestions: NonNullable<
    CreateWorkspaceSessionInteractionToolsOptions["askQuestions"]
  >,
): HostTool<TPrincipal> {
  return defineTool({
    name: STANDALONE_ASK_USER_TOOL.name,
    description: STANDALONE_ASK_USER_TOOL.description,
    inputSchema: STANDALONE_ASK_USER_TOOL.input_schema,
    effect: "read",
    parallelSafe: false,
    displayInput: (input) => ({
      questions: Array.isArray(input.questions)
        ? input.questions.map((question: { question?: unknown }) =>
            String(question?.question ?? ""),
          )
        : [],
    }),
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      const parsed = parseAskUserInput(input);
      if (!parsed.ok) return toolError(parsed.error);
      // A modeSwitch map the model sent anyway is ignored, not applied.
      const questions = parsed.questions.map(
        ({ modeSwitch: _modeSwitch, ...question }) => question,
      );
      try {
        const response = await askQuestions(
          { context: parsed.context, questions },
          { sessionId: context.sessionId, signal: context.signal },
        );
        const payload = buildAskUserResultPayload({
          context: parsed.context,
          questions,
          response: { answers: response.answers, notes: response.notes },
        });
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

/**
 * VS Code's `set_task_status` without background `result` envelopes:
 * standalone background children report through their own runtime.
 */
function createSetTaskStatusTool<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  todos: Map<string, readonly TodoItem[]>,
  options: CreateWorkspaceSessionInteractionToolsOptions,
): HostTool<TPrincipal> {
  return defineTool({
    name: SET_TASK_STATUS_TOOL.name,
    description: SET_TASK_STATUS_TOOL.description,
    inputSchema: SET_TASK_STATUS_TOOL.input_schema,
    effect: "read",
    parallelSafe: false,
    displayInput: (input) => ({
      status: typeof input.status === "string" ? input.status : undefined,
    }),
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      const status = input.status;
      if (!isTaskStatus(status)) return toolError("Invalid status");
      const marker = buildTaskStatusMarker({ status, params: input });
      const completeTodosRequested = input.completeTodos === true;
      let completed: TodoItem[] | undefined;
      if (status === "completed" && completeTodosRequested) {
        completed = completeTodos(
          structuredClone([...(todos.get(context.sessionId) ?? [])]),
        );
        todos.set(context.sessionId, completed);
        options.onTodosChanged?.(context.sessionId, completed);
      }
      const display: WorkspaceFinalStatusDisplay = {
        finalStatus: marker,
        ...(completed ? { todos: completed } : {}),
      };
      return {
        modelContent: JSON.stringify(
          buildTaskStatusResultPayload({
            status,
            completeTodosRequested,
            completedTodos: completed,
          }),
        ),
        displayContent: display,
        endTurn: { finalText: marker.summary ?? "" },
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
