import { useState } from "preact/hooks";
import type { TodoItem } from "../types";

interface TodoPanelProps {
  todos: TodoItem[];
}

export function TodoPanel({ todos }: TodoPanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  const counts = countTodos(todos);
  const allDone = counts.completed === counts.total;

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
        {counts.inProgress > 0 && (
          <span class="todo-panel-active">{getActiveLabel(todos)}</span>
        )}
        <i
          class={`codicon codicon-chevron-${collapsed ? "right" : "down"} todo-panel-chevron`}
        />
      </button>
      {!collapsed && (
        <div class="todo-panel-body">
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

function getActiveLabel(todos: TodoItem[]): string {
  for (const t of todos) {
    if (t.status === "in_progress") return t.activeForm;
    if (t.children) {
      const child = getActiveLabel(t.children);
      if (child) return child;
    }
  }
  return "";
}

function countTodos(items: TodoItem[]): {
  total: number;
  completed: number;
  inProgress: number;
} {
  let total = 0;
  let completed = 0;
  let inProgress = 0;
  for (const item of items) {
    total++;
    if (item.status === "completed") completed++;
    else if (item.status === "in_progress") inProgress++;
    if (item.children) {
      const sub = countTodos(item.children);
      total += sub.total;
      completed += sub.completed;
      inProgress += sub.inProgress;
    }
  }
  return { total, completed, inProgress };
}
