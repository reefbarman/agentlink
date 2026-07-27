import {
  completeTodos,
  getLatestTodoState,
  handleTodoWrite,
  todoTool,
} from "./todoTool.js";
import { describe, expect, it } from "vitest";

import type { TodoItem } from "./todoTool.js";

describe("todoTool", () => {
  it("points final completion to set_task_status", () => {
    expect(todoTool.description).toContain("completeTodos=true");
    expect(todoTool.description).toContain("instead of a final todo_write");
  });

  it("requires continuous reconciliation and completed-history compaction", () => {
    expect(todoTool.description).toContain(
      "Treat the list as user-visible execution state",
    );
    expect(todoTool.description).toContain(
      "Before moving from one item to the next",
    );
    expect(todoTool.description).toContain(
      "Never silently drop unfinished items",
    );
    expect(todoTool.description).toContain(
      "do not redo completed work merely because an item still says pending",
    );
    expect(todoTool.description).toContain(
      "When the top-level list exceeds 10 items",
    );
    expect(todoTool.description).toContain(
      "keep every unfinished item and the 3 most recent ordinary completed items",
    );
  });
});

function makeItem(
  overrides: Partial<TodoItem> & { id: string; content: string },
): TodoItem {
  return {
    activeForm: overrides.content + "ing",
    status: "pending",
    ...overrides,
  };
}

describe("handleTodoWrite", () => {
  it("returns the todos unchanged", () => {
    const todos: TodoItem[] = [
      makeItem({ id: "1", content: "Do thing", status: "completed" }),
      makeItem({ id: "2", content: "Do other", status: "pending" }),
    ];
    const { todos: out } = handleTodoWrite({ todos });
    expect(out).toBe(todos);
  });

  it("produces correct summary with all statuses", () => {
    const todos: TodoItem[] = [
      makeItem({ id: "1", content: "A", status: "completed" }),
      makeItem({ id: "2", content: "B", status: "in_progress" }),
      makeItem({ id: "3", content: "C", status: "pending" }),
    ];
    const { content } = handleTodoWrite({ todos });
    expect(content).toBe("Updated: 1/3 complete, 1 in progress, 1 pending");
  });

  it("warns when multiple items are simultaneously in progress", () => {
    const todos: TodoItem[] = [
      makeItem({ id: "1", content: "A", status: "in_progress" }),
      makeItem({ id: "2", content: "B", status: "in_progress" }),
    ];
    const { content } = handleTodoWrite({ todos });
    expect(content).toContain("2 items are in_progress");
    expect(content).toContain(
      "exactly one actual current item is in_progress before continuing",
    );
  });

  it("produces correct summary with empty list", () => {
    const { content } = handleTodoWrite({ todos: [] });
    expect(content).toBe("Updated: 0/0 complete, 0 in progress, 0 pending");
  });

  it("counts nested children recursively", () => {
    const todos: TodoItem[] = [
      makeItem({
        id: "1",
        content: "Parent",
        status: "in_progress",
        children: [
          makeItem({ id: "1a", content: "Child A", status: "completed" }),
          makeItem({ id: "1b", content: "Child B", status: "pending" }),
        ],
      }),
    ];
    const { content } = handleTodoWrite({ todos });
    // total=3 (parent + 2 children), completed=1, inProgress=1, pending=1
    expect(content).toBe("Updated: 1/3 complete, 1 in progress, 1 pending");
  });

  it("counts deeply nested children", () => {
    const todos: TodoItem[] = [
      makeItem({
        id: "1",
        content: "Root",
        status: "pending",
        children: [
          makeItem({
            id: "1a",
            content: "Mid",
            status: "completed",
            children: [
              makeItem({ id: "1a1", content: "Leaf", status: "completed" }),
            ],
          }),
        ],
      }),
    ];
    const { content } = handleTodoWrite({ todos });
    // total=3, completed=2 (Mid+Leaf), inProgress=0, pending=1 (Root)
    expect(content).toBe("Updated: 2/3 complete, 0 in progress, 1 pending");
  });

  it("requests cleanup when older completed top-level items can be grouped", () => {
    const todos = [
      ...Array.from({ length: 8 }, (_, index) =>
        makeItem({
          id: `done-${index}`,
          content: `Done ${index}`,
          status: "completed",
        }),
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        makeItem({ id: `pending-${index}`, content: `Pending ${index}` }),
      ),
    ];

    const { content, todos: out } = handleTodoWrite({ todos });

    expect(content).toContain(
      "Cleanup required: this list has 11 top-level items",
    );
    expect(content).toContain(
      'Fold the 5 older completed items into the completed summary with id "completed-history"',
    );
    expect(content).toContain(
      "Keep every unfinished item and the 3 most recent ordinary completed items",
    );
    expect(out).toBe(todos);
  });

  it("ignores nested subtasks and avoids a new one-task summary", () => {
    const nestedTodos = [
      makeItem({
        id: "parent",
        content: "Parent",
        children: Array.from({ length: 11 }, (_, index) =>
          makeItem({
            id: `child-${index}`,
            content: `Child ${index}`,
            status: "completed",
          }),
        ),
      }),
    ];
    const singleReplaceable = [
      ...Array.from({ length: 4 }, (_, index) =>
        makeItem({
          id: `done-${index}`,
          content: `Done ${index}`,
          status: "completed",
        }),
      ),
      ...Array.from({ length: 7 }, (_, index) =>
        makeItem({ id: `pending-${index}`, content: `Pending ${index}` }),
      ),
    ];

    expect(handleTodoWrite({ todos: nestedTodos }).content).not.toContain(
      "Cleanup required",
    );
    expect(handleTodoWrite({ todos: singleReplaceable }).content).not.toContain(
      "Cleanup required",
    );
  });

  it("requests the reserved summary id and excludes it from recent completed items", () => {
    const todos = [
      makeItem({
        id: "completed-history",
        content: "Earlier work (5 tasks): prepared the implementation",
        status: "completed",
      }),
      ...Array.from({ length: 4 }, (_, index) =>
        makeItem({
          id: `done-${index}`,
          content: `Done ${index}`,
          status: "completed",
        }),
      ),
      ...Array.from({ length: 6 }, (_, index) =>
        makeItem({ id: `pending-${index}`, content: `Pending ${index}` }),
      ),
    ];

    const { content } = handleTodoWrite({ todos });

    expect(content).toContain(
      'Fold the 1 older completed item into the completed summary with id "completed-history"',
    );
    expect(content).toContain(
      "reuse and update that item if it already exists",
    );
    expect(content).toContain(
      "3 most recent ordinary completed items, excluding the history summary",
    );
    expect(todoTool.description).toContain('id is "completed-history"');
    expect(todoTool.description).toContain("Reuse and update that summary");
  });

  it("handles all completed", () => {
    const todos: TodoItem[] = [
      makeItem({ id: "1", content: "A", status: "completed" }),
      makeItem({ id: "2", content: "B", status: "completed" }),
    ];
    const { content } = handleTodoWrite({ todos });
    expect(content).toBe("Updated: 2/2 complete, 0 in progress, 0 pending");
  });
});

describe("completeTodos", () => {
  it("marks nested todos completed without mutating the original list", () => {
    const todos: TodoItem[] = [
      makeItem({
        id: "1",
        content: "Parent",
        status: "in_progress",
        children: [makeItem({ id: "1a", content: "Child", status: "pending" })],
      }),
    ];

    const completed = completeTodos(todos);

    expect(completed).toEqual([
      expect.objectContaining({
        id: "1",
        status: "completed",
        children: [expect.objectContaining({ id: "1a", status: "completed" })],
      }),
    ]);
    expect(todos[0].status).toBe("in_progress");
    expect(todos[0].children?.[0]?.status).toBe("pending");
  });
});

describe("getLatestTodoState", () => {
  it("rebuilds the latest list and applies final completion", () => {
    const todos = [
      makeItem({ id: "1", content: "Inspect", status: "completed" }),
      makeItem({ id: "2", content: "Report", status: "in_progress" }),
    ];

    expect(
      getLatestTodoState([
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "todo-1",
              name: "todo_write",
              input: { todos },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "done-1",
              name: "set_task_status",
              input: { status: "completed", completeTodos: true },
            },
          ],
        },
      ]),
    ).toEqual([
      expect.objectContaining({ id: "1", status: "completed" }),
      expect.objectContaining({ id: "2", status: "completed" }),
    ]);
  });
});
