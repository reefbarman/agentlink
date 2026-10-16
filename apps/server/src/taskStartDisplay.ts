/**
 * What the `start_task` approval card shows: the exact repository, base
 * branch, model and objective, in plain text. Kept apart from the tools so
 * the chat bridge can render it without importing them.
 */

export const TASK_START_DISPLAY_KIND = "assistant_task_start";

export interface TaskStartDisplay {
  readonly kind: typeof TASK_START_DISPLAY_KIND;
  readonly action: "create";
  readonly text: string;
}

export function isTaskStartDisplay(value: unknown): value is TaskStartDisplay {
  if (!value || typeof value !== "object") return false;
  const display = value as Record<string, unknown>;
  return (
    display.kind === TASK_START_DISPLAY_KIND && typeof display.text === "string"
  );
}
