import {
  buildTaskStatusMarker,
  isTaskStatus,
} from "@agentlink/core/interaction-tools";

import type { EmbeddedAgentTurnEvent } from "@agentlink/protocol";
import type { FinalMessageMarker } from "@agentlink/protocol/final-status";
import { TODO_AUTO_CONTINUE_PROMPT } from "@agentlink/protocol/todo-continuation";
import type { TodoItem } from "@agentlink/protocol/chat-transcript";
import { isProgressToolName } from "@agentlink/protocol/auto-continue-progress";

/**
 * Auto Continue, as VS Code's: a turn that ends with unfinished todos and
 * nothing waiting on the owner carries on by itself with the same prompt,
 * until the list is done, a turn makes no progress, the turn sets a final
 * status with `set_task_status`, or the owner stops it.
 */

/** The message that continues a session; the same one VS Code sends. */
export const AUTO_CONTINUE_PROMPT = TODO_AUTO_CONTINUE_PROMPT;

/**
 * Tells the model how its todo list keeps it working. The shared guidance
 * already covers `todo_write` and `set_task_status`; this adds what only the
 * Assistant does: carrying on by itself while todos remain.
 */
export const AUTO_CONTINUE_INSTRUCTIONS =
  "While todo items remain unfinished, the session carries on by itself after each of your turns, so there is no need to stop and ask whether to continue. Use waiting_for_user or blocked when you need the owner (a decision, a sign-in, an approval you cannot get). Setting a final status with set_task_status stops the session carrying on by itself.";

/**
 * The list a successful `todo_write` call set, or the one `set_task_status`
 * completed with `completeTodos`, from the call's display content.
 */
export function todosFromToolResult(
  toolName: string,
  displayContent: unknown,
): TodoItem[] | undefined {
  if (toolName !== "todo_write" && toolName !== "set_task_status") {
    return undefined;
  }
  const todos = (displayContent as { todos?: unknown } | null | undefined)
    ?.todos;
  if (!Array.isArray(todos) || !todos.every(isTodoItem)) return undefined;
  return structuredClone(todos);
}

/** The final status a `set_task_status` call set, from its display content. */
export function finalStatusFromToolResult(
  toolName: string,
  displayContent: unknown,
): FinalMessageMarker | undefined {
  if (toolName !== "set_task_status") return undefined;
  const marker = (
    displayContent as { finalStatus?: unknown } | null | undefined
  )?.finalStatus;
  if (!marker || typeof marker !== "object") return undefined;
  return isTaskStatus((marker as { status?: unknown }).status)
    ? structuredClone(marker as FinalMessageMarker)
    : undefined;
}

/** Any item, at any depth, not yet completed. */
export function hasUnfinishedTodos(todos: readonly TodoItem[]): boolean {
  return todos.some(
    (todo) =>
      todo.status !== "completed" || hasUnfinishedTodos(todo.children ?? []),
  );
}

/**
 * Watches one turn's events for progress: a call to a tool that changes
 * things (writes, commands, background agents, the todo list), as VS Code
 * counts it. A turn with none would only repeat itself if continued.
 */
export class TurnProgress {
  private progressed = false;
  private latestTodos: TodoItem[] | undefined;
  private latestFinalStatus: FinalMessageMarker | undefined;

  observe(event: EmbeddedAgentTurnEvent): void {
    if (event.type !== "tool.completed") return;
    if (isProgressToolName(event.toolName)) this.progressed = true;
    const todos = todosFromToolResult(event.toolName, event.displayContent);
    if (todos) this.latestTodos = todos;
    const finalStatus = finalStatusFromToolResult(
      event.toolName,
      event.displayContent,
    );
    if (finalStatus) this.latestFinalStatus = finalStatus;
  }

  get madeProgress(): boolean {
    return this.progressed;
  }

  /** The final status this turn set with `set_task_status`, if any. */
  get finalStatus(): FinalMessageMarker | undefined {
    return this.latestFinalStatus;
  }

  /** The list as this turn last set it; undefined if it did not. */
  get todos(): TodoItem[] | undefined {
    return this.latestTodos;
  }
}

/**
 * Whether a finished turn should carry on: it completed (not stopped,
 * failed or waiting for an approval), made progress, set no final status
 * (VS Code's explicit final marker ends Auto Continue), and left todos
 * unfinished.
 */
export function shouldAutoContinue(input: {
  readonly completed: boolean;
  readonly madeProgress: boolean;
  readonly finalStatus: boolean;
  readonly todos: readonly TodoItem[];
}): boolean {
  return (
    input.completed &&
    input.madeProgress &&
    !input.finalStatus &&
    hasUnfinishedTodos(input.todos)
  );
}

/**
 * Stored messages with each `set_task_status` call's final card as the
 * `uiHint` VS Code records, so a reloaded chat shows the card.
 */
export function withFinalStatusHints(messages: readonly unknown[]): unknown[] {
  return messages.map((raw) => {
    const message = raw as {
      readonly role?: unknown;
      readonly content?: unknown;
    } | null;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) {
      return raw;
    }
    let finalMarker: FinalMessageMarker | undefined;
    for (const block of message.content as unknown[]) {
      const call = block as {
        type?: unknown;
        name?: unknown;
        input?: unknown;
      };
      if (call.type !== "tool_use" || call.name !== "set_task_status") continue;
      const input = (call.input ?? {}) as Record<string, unknown>;
      if (isTaskStatus(input.status)) {
        finalMarker = buildTaskStatusMarker({
          status: input.status,
          params: input,
        });
      }
    }
    if (!finalMarker) return raw;
    const uiHint = (message as { uiHint?: Record<string, unknown> }).uiHint;
    return { ...message, uiHint: { ...uiHint, finalMarker } };
  });
}

/** A loaded transcript without the continuation messages, as VS Code hides them. */
export function withoutAutoContinuePrompts<
  T extends { readonly role: string; readonly content?: unknown },
>(messages: T[]): T[] {
  return messages.filter(
    (message) =>
      !(message.role === "user" && message.content === AUTO_CONTINUE_PROMPT),
  );
}

function isTodoItem(value: unknown): value is TodoItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.content === "string" &&
    typeof item.activeForm === "string" &&
    (item.status === "pending" ||
      item.status === "in_progress" ||
      item.status === "completed") &&
    (item.children === undefined ||
      (Array.isArray(item.children) && item.children.every(isTodoItem)))
  );
}
