import type { EmbeddedAgentTurnEvent } from "@agentlink/protocol";
import { TODO_AUTO_CONTINUE_PROMPT } from "@agentlink/protocol/todo-continuation";
import type { TodoItem } from "@agentlink/protocol/chat-transcript";
import { isProgressToolName } from "@agentlink/protocol/auto-continue-progress";

/**
 * Auto Continue, as VS Code's: a turn that ends with unfinished todos and
 * nothing waiting on the owner carries on by itself with the same prompt,
 * until the list is done, a turn makes no progress, or the owner stops it.
 */

/** The message that continues a session; the same one VS Code sends. */
export const AUTO_CONTINUE_PROMPT = TODO_AUTO_CONTINUE_PROMPT;

/** Tells the model how its todo list keeps it working. */
export const AUTO_CONTINUE_INSTRUCTIONS =
  "For work with several steps, keep a todo list with todo_write and keep it current: exactly one item in progress, and mark each item completed as soon as it is done. While items remain unfinished, the session carries on by itself after each of your turns, so there is no need to stop and ask whether to continue. When you need the owner (a decision, a sign-in, an approval you cannot get), say so plainly and stop making changes; when the work is done, mark every item completed.";

/** The list a successful `todo_write` call set, from its display content. */
export function todosFromToolResult(
  toolName: string,
  displayContent: unknown,
): TodoItem[] | undefined {
  if (toolName !== "todo_write") return undefined;
  const todos = (displayContent as { todos?: unknown } | null | undefined)
    ?.todos;
  if (!Array.isArray(todos) || !todos.every(isTodoItem)) return undefined;
  return structuredClone(todos);
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

  observe(event: EmbeddedAgentTurnEvent): void {
    if (event.type !== "tool.completed") return;
    if (isProgressToolName(event.toolName)) this.progressed = true;
    const todos = todosFromToolResult(event.toolName, event.displayContent);
    if (todos) this.latestTodos = todos;
  }

  get madeProgress(): boolean {
    return this.progressed;
  }

  /** The list as this turn last set it; undefined if it did not. */
  get todos(): TodoItem[] | undefined {
    return this.latestTodos;
  }
}

/**
 * Whether a finished turn should carry on: it completed (not stopped,
 * failed or waiting for an approval), made progress, and left todos
 * unfinished.
 */
export function shouldAutoContinue(input: {
  readonly completed: boolean;
  readonly madeProgress: boolean;
  readonly todos: readonly TodoItem[];
}): boolean {
  return (
    input.completed && input.madeProgress && hasUnfinishedTodos(input.todos)
  );
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
