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
  askUserToolDefinition,
  setTaskStatusToolDefinition,
  buildAskUserResultPayload,
  buildModeSwitchSkippedPayload,
  buildSwitchModeResultPayload,
  buildTaskStatusMarker,
  buildTaskStatusResultPayload,
  getAskUserModeSwitch,
  isTaskStatus,
  validateTaskStatusContinuation,
  parseAskUserInput,
  switchModeToolDefinition,
  type ModeSwitchOutcome,
} from "@agentlink/core/interaction-tools";
import {
  backgroundSetTaskStatusTool,
  checkBackgroundTaskStatusResult,
  formatFleetResultEnvelope,
  type BackgroundExpectedResult,
} from "@agentlink/core/background-results";
import type { TodoItem } from "@agentlink/protocol/chat-transcript";
import type { FleetResultEnvelope } from "@agentlink/protocol/fleet-result";
import type { FinalMessageMarker } from "@agentlink/protocol/final-status";
import type {
  UserQuestion,
  UserQuestionResponse,
} from "@agentlink/protocol/structured-question";

/** One `ask_user` call, validated as VS Code does. */
export interface WorkspaceQuestionsRequest {
  /** Shared intro shown above the questions; may be empty. */
  readonly context: string;
  /**
   * VS Code's question shapes. `modeSwitch` maps are kept only when the
   * session can change modes, so a host can show which answers switch.
   */
  readonly questions: readonly UserQuestion[];
}

/**
 * How a session changes mode, for VS Code's `switch_mode` and `ask_user`
 * `modeSwitch`. `silent` means the user already chose the switch (an
 * `ask_user` answer mapped to a mode), so no separate approval is asked.
 * An approved switch ends the turn; the host continues it in the new mode.
 */
export interface WorkspaceModeSwitcher {
  /** Whether this session can change modes (foreground sessions only). */
  readonly available: (sessionId: string) => boolean;
  readonly switchMode: (request: {
    readonly sessionId: string;
    readonly mode: string;
    readonly reason?: string;
    readonly silent: boolean;
    readonly signal?: AbortSignal;
  }) => Promise<ModeSwitchOutcome>;
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

/**
 * How background children report: VS Code's background `set_task_status`,
 * whose `result` envelope is typed to the child's `expectedResult`.
 */
export interface WorkspaceBackgroundFinalStatus {
  /** The child's delegation, or undefined for a foreground session. */
  readonly delegation: (
    sessionId: string,
  ) => { readonly expectedResult?: BackgroundExpectedResult } | undefined;
  /** Record a child's accepted status, which decides its result. */
  readonly record: (sessionId: string, marker: FinalMessageMarker) => void;
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
  /**
   * Offer VS Code's `switch_mode` and keep `ask_user` `modeSwitch` maps for
   * sessions this switcher says can change modes.
   */
  readonly modeSwitch?: WorkspaceModeSwitcher;
  /**
   * Background children get VS Code's background `set_task_status` (even
   * without `finalStatus`), so they can return a structured result.
   */
  readonly backgroundFinalStatus?: WorkspaceBackgroundFinalStatus;
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
    const modeSwitch = options.modeSwitch?.available(request.sessionId)
      ? options.modeSwitch
      : undefined;
    const delegation = options.backgroundFinalStatus?.delegation(
      request.sessionId,
    );
    return [
      ...(askQuestions
        ? [createAskUserTool(request, askQuestions, modeSwitch)]
        : []),
      createTodoWriteTool(request, todos, options),
      ...(options.finalStatus || delegation
        ? [createSetTaskStatusTool(request, todos, options, delegation)]
        : []),
      ...(modeSwitch ? [createSwitchModeTool(request, modeSwitch)] : []),
    ];
  };
  return { resolveTools, snapshot, restore };
}

/**
 * VS Code's `ask_user` without attachments, and with every question going
 * to the user: background children here have no coordinator to answer
 * first. `modeSwitch` only where the session can change modes.
 */
const STANDALONE_ASK_USER_TOOL = askUserToolDefinition({
  modeSwitch: false,
  backgroundCoordinator: false,
});
const STANDALONE_ASK_USER_MODE_SWITCH_TOOL = askUserToolDefinition({
  modeSwitch: true,
  backgroundCoordinator: false,
});

/** VS Code's `switch_mode`; here the user always approves the switch. */
const STANDALONE_SWITCH_MODE_TOOL = switchModeToolDefinition({
  approveForMe: false,
});

function createAskUserTool<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  askQuestions: NonNullable<
    CreateWorkspaceSessionInteractionToolsOptions["askQuestions"]
  >,
  modeSwitch: WorkspaceModeSwitcher | undefined,
): HostTool<TPrincipal> {
  const definition = modeSwitch
    ? STANDALONE_ASK_USER_MODE_SWITCH_TOOL
    : STANDALONE_ASK_USER_TOOL;
  return defineTool({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.input_schema,
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
      // Without mode switching, a modeSwitch map the model sent anyway is
      // ignored, not applied.
      const questions = modeSwitch
        ? parsed.questions
        : parsed.questions.map(
            ({ modeSwitch: _modeSwitch, ...question }) => question,
          );
      try {
        const answered = await askQuestions(
          { context: parsed.context, questions },
          { sessionId: context.sessionId, signal: context.signal },
        );
        const response = { answers: answered.answers, notes: answered.notes };
        // As in VS Code, the chosen answer is the consent: switch silently.
        const selected = modeSwitch
          ? getAskUserModeSwitch(questions, response)
          : undefined;
        let switched: ModeSwitchOutcome | undefined;
        if (selected && modeSwitch) {
          try {
            const outcome = await modeSwitch.switchMode({
              sessionId: context.sessionId,
              mode: selected.mode,
              reason: selected.reason,
              silent: true,
              signal: context.signal,
            });
            if (outcome.approved) switched = outcome;
          } catch (error) {
            // As in VS Code: no switch; the model can call switch_mode.
            if (context.signal?.aborted || isAbortError(error)) throw error;
          }
        }
        const payload = buildAskUserResultPayload({
          context: parsed.context,
          questions,
          response,
          ...(switched ? { modeSwitched: switched.mode } : {}),
          ...(switched?.followUp ? { followUp: switched.followUp } : {}),
        });
        return {
          modelContent: JSON.stringify(payload),
          displayContent: payload,
          ...(switched
            ? {
                endTurn: {
                  finalText: "",
                  // As in VS Code, a queued message waits for the next turn.
                  ignoreInterjections: true,
                  skippedResult: buildModeSwitchSkippedPayload(switched.mode),
                },
              }
            : {}),
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
 * VS Code's `set_task_status`. A background child gets the background
 * variant: a `result` envelope checked against its `expectedResult` (a
 * refused one leaves the turn running so the child can correct it), and an
 * accepted status recorded as the child's result.
 */
function createSetTaskStatusTool<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  todos: Map<string, readonly TodoItem[]>,
  options: CreateWorkspaceSessionInteractionToolsOptions,
  delegation?: { readonly expectedResult?: BackgroundExpectedResult },
): HostTool<TPrincipal> {
  // With ask_user the agent asks instead of ending the turn to wait.
  const askUser = Boolean(options.askQuestions);
  const baseDefinition = setTaskStatusToolDefinition({ askUser });
  const definition = delegation
    ? backgroundSetTaskStatusTool(delegation.expectedResult, { askUser })
    : baseDefinition;
  const tool = defineTool({
    name: definition.name,
    description: definition.description,
    // A child's `result` is accepted by the schema check and judged by VS
    // Code's own check below, so a malformed envelope gets VS Code's
    // bounded diagnostics rather than a schema error.
    inputSchema: delegation
      ? {
          ...baseDefinition.input_schema,
          properties: {
            ...baseDefinition.input_schema.properties,
            result: {},
          },
        }
      : definition.input_schema,
    effect: "read",
    parallelSafe: false,
    displayInput: (input) => ({
      status: typeof input.status === "string" ? input.status : undefined,
    }),
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      const status = input.status;
      if (!isTaskStatus(status)) return toolError("Invalid status");
      const continuationError = validateTaskStatusContinuation(status, input, {
        askUser,
      });
      if (continuationError) return toolError(continuationError);
      let result: FleetResultEnvelope | undefined;
      if (delegation) {
        const rejection = checkBackgroundTaskStatusResult({
          status,
          result: input.result,
          ...(delegation.expectedResult
            ? { expectedResult: delegation.expectedResult }
            : {}),
        });
        // As in VS Code: an ordinary result the child reads and corrects.
        if (rejection) return { modelContent: JSON.stringify(rejection) };
        result = input.result as FleetResultEnvelope | undefined;
      }
      const marker = buildTaskStatusMarker({
        status,
        params: input,
        ...(result ? { result } : {}),
      });
      if (delegation) {
        options.backgroundFinalStatus!.record(context.sessionId, marker);
      }
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
        endTurn: {
          finalText:
            marker.summary ??
            (marker.result ? formatFleetResultEnvelope(marker.result) : ""),
        },
      };
    },
  });
  // The model is offered VS Code's typed background schema.
  return delegation
    ? Object.freeze({
        ...tool,
        definition: Object.freeze({
          ...tool.definition,
          input_schema: definition.input_schema,
        }),
      })
    : tool;
}

function createSwitchModeTool<TPrincipal extends AgentPrincipal>(
  discovery: HostToolResolveRequest<TPrincipal>,
  modeSwitch: WorkspaceModeSwitcher,
): HostTool<TPrincipal> {
  return defineTool({
    name: STANDALONE_SWITCH_MODE_TOOL.name,
    description: STANDALONE_SWITCH_MODE_TOOL.description,
    inputSchema: STANDALONE_SWITCH_MODE_TOOL.input_schema,
    effect: "read",
    parallelSafe: false,
    displayInput: (input) => ({
      mode: typeof input.mode === "string" ? input.mode : undefined,
    }),
    handler: async (input, context) => {
      if (!sameTurn(discovery, context)) return toolError("tool_turn_mismatch");
      const mode = String(input.mode ?? "");
      const reason =
        typeof input.reason === "string" && input.reason
          ? input.reason
          : undefined;
      let outcome: ModeSwitchOutcome;
      try {
        outcome = await modeSwitch.switchMode({
          sessionId: context.sessionId,
          mode,
          ...(reason ? { reason } : {}),
          silent: false,
          signal: context.signal,
        });
      } catch (error) {
        if (context.signal?.aborted || isAbortError(error)) throw error;
        // As in VS Code, a switch that fails is reported as not approved.
        outcome = {
          approved: false,
          mode,
          rejectionReason: `Mode switch to "${mode}" failed: ${errorMessage(error)}`,
        };
      }
      const payload = buildSwitchModeResultPayload(outcome);
      return {
        modelContent: JSON.stringify(payload),
        displayContent: payload,
        // An approved switch is a turn boundary, as in VS Code.
        ...(outcome.approved
          ? {
              endTurn: {
                finalText: "",
                // As in VS Code, a queued message waits for the next turn.
                ignoreInterjections: true,
                skippedResult: buildModeSwitchSkippedPayload(outcome.mode),
              },
            }
          : {}),
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
