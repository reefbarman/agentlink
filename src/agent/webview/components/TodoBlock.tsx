import type { TodoItem } from "../types";

interface TodoBlockProps {
  todos: TodoItem[];
}

/**
 * Inline todo block rendered inside an assistant message.
 * Shows a compact view of the todo list at that point in time.
 */
export function TodoBlock({ todos }: TodoBlockProps) {
  const counts = countTodos(todos);
  const allDone = counts.completed === counts.total;

  return (
    <div class={`todo-block ${allDone ? "todo-block-done" : ""}`}>
      <div class="todo-block-header">
        <i class={`codicon codicon-${allDone ? "check-all" : "checklist"}`} />
        <span>
          Tasks {counts.completed}/{counts.total}
        </span>
      </div>
      <ul class="todo-block-list">
        {todos.map((item) => (
          <TodoBlockItem key={item.id} item={item} depth={0} />
        ))}
      </ul>
    </div>
  );
}

function TodoBlockItem({ item, depth }: { item: TodoItem; depth: number }) {
  return (
    <>
      <li
        class={`todo-block-item todo-item-${item.status}`}
        style={depth > 0 ? { paddingLeft: `${depth * 16}px` } : undefined}
      >
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
      </li>
      {item.children?.map((child) => (
        <TodoBlockItem key={child.id} item={child} depth={depth + 1} />
      ))}
    </>
  );
}

function countTodos(items: TodoItem[]): { total: number; completed: number } {
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
