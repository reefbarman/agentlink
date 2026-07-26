import type { MessageParam, ToolDefinition } from "./providers/types.js";

/**
 * Agent-internal todo tracking tool.
 * Not exposed via MCP — handled directly in the AgentEngine execution loop.
 */

// ── Types ──

export interface TodoItem {
  id: string;
  content: string;
  /** Present participle form shown when in_progress (e.g. "Running tests") */
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
  children?: TodoItem[];
}

// ── Tool definition for Claude SDK ──

export const TODO_TOOL_NAME = "todo_write";
export const TODO_COMPACTION_THRESHOLD = 10;
export const TODO_RECENT_COMPLETED_LIMIT = 3;
export const TODO_COMPLETED_HISTORY_ID = "completed-history";
export const TODO_COMPACTION_GUIDANCE = `When the top-level list exceeds ${TODO_COMPACTION_THRESHOLD} items, compact older completed work: keep every unfinished item and the ${TODO_RECENT_COMPLETED_LIMIT} most recent ordinary completed items (excluding the history summary), then replace earlier completed items with one concise completed summary item whose id is "${TODO_COMPLETED_HISTORY_ID}". Reuse and update that summary on later calls. It must state how many tasks it represents and briefly describe their outcomes; do not retain the replaced items as children. Count only top-level items for this limit.`;

export const todoTool: ToolDefinition = {
  name: TODO_TOOL_NAME,
  description: `Create and manage a structured task list to track your progress on complex tasks. The entire todo list is replaced each call — always include all items (completed, in-progress, and pending).

Use this when:
- A task requires 3+ distinct steps
- The user provides multiple tasks
- You need to show progress on complex work

Task rules:
- Exactly ONE task should be in_progress at a time
- Treat the list as user-visible execution state, not a loose plan or end-of-turn recap
- Before starting substantive work, make sure the list reflects the actual scope and current item
- Before moving from one item to the next, call todo_write in the same transition: mark the finished item completed and the next item in_progress
- Mark an item completed immediately after its outcome is achieved and verified; do not batch status updates until the end
- After new evidence, user direction, or scope changes, promptly add, revise, reorder, or remove items so descriptions and statuses remain true
- Never silently drop unfinished items. Remove one only when it is no longer part of the user's ask or is explicitly superseded, and preserve completed items as progress history
- ${TODO_COMPACTION_GUIDANCE}
- If the list looks stale after condensing or resuming, reconcile it against the conversation and current workspace before continuing. Update stale statuses; do not redo completed work merely because an item still says pending
- When finishing the turn and all visible todos are complete, use set_task_status with status="completed" and completeTodos=true instead of a final todo_write only to mark todos complete
- Use nested children to break complex tasks into sub-steps
- content: imperative form ("Run tests")
- activeForm: present continuous ("Running tests")`,
  input_schema: {
    type: "object" as const,
    properties: {
      todos: {
        type: "array",
        description: "The complete todo list (replaces previous state)",
        items: {
          $ref: "#/$defs/todoItem",
        },
      },
    },
    required: ["todos"],
    $defs: {
      todoItem: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Unique identifier for this task",
          },
          content: {
            type: "string",
            description:
              "Imperative description of the task (e.g. 'Run tests')",
          },
          activeForm: {
            type: "string",
            description:
              "Present continuous form (e.g. 'Running tests'). Shown when task is in_progress.",
          },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "completed"],
          },
          children: {
            type: "array",
            description: "Optional sub-tasks",
            items: { $ref: "#/$defs/todoItem" },
          },
        },
        required: ["id", "content", "activeForm", "status"],
      },
    },
  },
};

// ── Internal handler ──

export interface TodoToolInput {
  todos: TodoItem[];
}

/**
 * Handle a todo_write tool call. Returns the tool result content
 * and the parsed todo list for the webview.
 */
export function handleTodoWrite(input: TodoToolInput): {
  content: string;
  todos: TodoItem[];
} {
  const todos = Array.isArray(input.todos) ? input.todos : [];

  const counts = countTodos(todos);
  const summary = `Updated: ${counts.completed}/${counts.total} complete, ${counts.inProgress} in progress, ${counts.pending} pending`;
  const guidance: string[] = [];
  if (counts.inProgress > 1) {
    guidance.push(
      `Warning: ${counts.inProgress} items are in_progress; reconcile the complete list so exactly one actual current item is in_progress before continuing.`,
    );
  }

  const olderCompletedCount = countOlderCompletedItems(todos);
  if (olderCompletedCount > 0) {
    guidance.push(
      `Cleanup required: this list has ${todos.length} top-level items. Fold the ${olderCompletedCount} older completed ${olderCompletedCount === 1 ? "item" : "items"} into the completed summary with id "${TODO_COMPLETED_HISTORY_ID}" before continuing; reuse and update that item if it already exists, otherwise create it. Keep every unfinished item and the ${TODO_RECENT_COMPLETED_LIMIT} most recent ordinary completed items, excluding the history summary. Do not keep the replaced items as children.`,
    );
  }

  return {
    content: [summary, ...guidance].join(" "),
    todos,
  };
}

function countOlderCompletedItems(todos: TodoItem[]): number {
  if (todos.length <= TODO_COMPACTION_THRESHOLD) return 0;

  const hasCompletedHistory = todos.some(
    (todo) =>
      todo.id === TODO_COMPLETED_HISTORY_ID && todo.status === "completed",
  );
  const completedCount = todos.reduce(
    (count, todo) =>
      count +
      (todo.status === "completed" && todo.id !== TODO_COMPLETED_HISTORY_ID
        ? 1
        : 0),
    0,
  );
  const olderCompletedCount = Math.max(
    0,
    completedCount - TODO_RECENT_COMPLETED_LIMIT,
  );
  return hasCompletedHistory || olderCompletedCount >= 2
    ? olderCompletedCount
    : 0;
}

export function hasPendingTodos(todos: TodoItem[]): boolean {
  return todos.some(
    (t) =>
      t.status === "pending" ||
      t.status === "in_progress" ||
      (t.children ? hasPendingTodos(t.children) : false),
  );
}

export function completeTodos(todos: TodoItem[]): TodoItem[] {
  return todos.map((todo) => ({
    ...todo,
    status: "completed" as const,
    ...(todo.children?.length
      ? { children: completeTodos(todo.children) }
      : {}),
  }));
}

/**
 * Rebuild the latest todo state from persisted provider messages.
 *
 * Keeping this projection next to the todo tool lets foreground restores,
 * background transcript snapshots, and the engine all use the same rules.
 */
export function getLatestTodoState(messages: MessageParam[]): TodoItem[] {
  let todos: TodoItem[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      const input =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : null;
      if (block.name === TODO_TOOL_NAME && Array.isArray(input?.todos)) {
        todos = input.todos as TodoItem[];
      } else if (
        block.name === "set_task_status" &&
        input?.status === "completed" &&
        input.completeTodos === true
      ) {
        todos = completeTodos(todos);
      }
    }
  }
  return todos;
}

function countTodos(items: TodoItem[]): {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
} {
  let total = 0;
  let completed = 0;
  let inProgress = 0;
  let pending = 0;

  for (const item of items) {
    total++;
    if (item.status === "completed") completed++;
    else if (item.status === "in_progress") inProgress++;
    else pending++;

    if (item.children?.length) {
      const sub = countTodos(item.children);
      total += sub.total;
      completed += sub.completed;
      inProgress += sub.inProgress;
      pending += sub.pending;
    }
  }

  return { total, completed, inProgress, pending };
}
