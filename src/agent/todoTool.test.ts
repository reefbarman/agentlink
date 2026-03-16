import { describe, it, expect } from "vitest";
import { handleTodoWrite } from "./todoTool.js";
import type { TodoItem } from "./todoTool.js";

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

  it("handles all completed", () => {
    const todos: TodoItem[] = [
      makeItem({ id: "1", content: "A", status: "completed" }),
      makeItem({ id: "2", content: "B", status: "completed" }),
    ];
    const { content } = handleTodoWrite({ todos });
    expect(content).toBe("Updated: 2/2 complete, 0 in progress, 0 pending");
  });
});
