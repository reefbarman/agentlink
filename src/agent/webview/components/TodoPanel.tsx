import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { TodoItem } from "../types";

interface TodoPanelProps {
  todos: TodoItem[];
}

export function TodoPanel({ todos }: TodoPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const counts = countTodos(todos);
  const allDone = counts.completed === counts.total;
  const activeTodo = findActiveTodo(todos);
  const activeTodoKey = activeTodo
    ? `${activeTodo.path}:${activeTodo.item.id}`
    : null;

  useLayoutEffect(() => {
    if (collapsed || activeTodoKey === null) return;

    const body = bodyRef.current;
    const activeItem = body?.querySelector<HTMLElement>(
      ".todo-item-in_progress > .todo-item-text",
    );
    if (!body || !activeItem || body.scrollHeight <= body.clientHeight) return;

    const bodyRect = body.getBoundingClientRect();
    const activeRect = activeItem.getBoundingClientRect();
    const centeredScrollTop =
      body.scrollTop +
      activeRect.top -
      bodyRect.top -
      (body.clientHeight - activeRect.height) / 2;
    const maxScrollTop = body.scrollHeight - body.clientHeight;
    body.scrollTop = Math.max(0, Math.min(centeredScrollTop, maxScrollTop));
  }, [activeTodoKey, collapsed]);

  return (
    <div class={`todo-panel ${allDone ? "todo-panel-done" : ""}`}>
      <button
        class="todo-panel-header"
        onClick={() => setCollapsed(!collapsed)}
      >
        <i class={`codicon codicon-${allDone ? "check-all" : "checklist"}`} />
        <span class="todo-panel-title">
          Tasks {counts.completed}/{counts.total}
        </span>
        {activeTodo && (
          <span class="todo-panel-active">{activeTodo.item.activeForm}</span>
        )}
        <i
          class={`codicon codicon-chevron-${collapsed ? "right" : "down"} todo-panel-chevron`}
        />
      </button>
      {!collapsed && (
        <div class="todo-panel-body" ref={bodyRef}>
          <TodoList items={todos} depth={0} />
        </div>
      )}
    </div>
  );
}

function TodoList({ items, depth }: { items: TodoItem[]; depth: number }) {
  return (
    <ul class={`todo-list ${depth > 0 ? "todo-list-nested" : ""}`}>
      {items.map((item) => (
        <li key={item.id} class={`todo-item todo-item-${item.status}`}>
          <span class="todo-item-icon">
            {item.status === "completed" && (
              <i class="codicon codicon-pass-filled" />
            )}
            {item.status === "in_progress" && (
              <i class="codicon codicon-loading codicon-modifier-spin" />
            )}
            {item.status === "pending" && (
              <i class="codicon codicon-circle-large-outline" />
            )}
          </span>
          <span class="todo-item-text">
            {item.status === "in_progress" ? item.activeForm : item.content}
          </span>
          {item.children && item.children.length > 0 && (
            <TodoList items={item.children} depth={depth + 1} />
          )}
        </li>
      ))}
    </ul>
  );
}

function findActiveTodo(
  todos: TodoItem[],
  parentPath = "",
): { item: TodoItem; path: string } | null {
  for (const [index, todo] of todos.entries()) {
    const path = parentPath ? `${parentPath}.${index}` : `${index}`;
    if (todo.status === "in_progress") return { item: todo, path };
    if (todo.children) {
      const child = findActiveTodo(todo.children, path);
      if (child) return child;
    }
  }
  return null;
}

function countTodos(items: TodoItem[]): {
  total: number;
  completed: number;
} {
  let total = 0;
  let completed = 0;
  for (const item of items) {
    total++;
    if (item.status === "completed") completed++;
    if (item.children) {
      const sub = countTodos(item.children);
      total += sub.total;
      completed += sub.completed;
    }
  }
  return { total, completed };
}
