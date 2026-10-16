/**
 * What a job tool's approval card shows: one plain-text description of the
 * exact change, carried in the interaction's display content. Kept apart
 * from the tools so the chat bridge can render it without importing them.
 */

export const JOB_CHANGE_DISPLAY_KIND = "assistant_job_change";

export interface JobChangeDisplay {
  readonly kind: typeof JOB_CHANGE_DISPLAY_KIND;
  readonly action: "create" | "update" | "delete";
  readonly jobName: string;
  /** Everything the owner approves: schedule, project, prompt, settings. */
  readonly text: string;
}

export function isJobChangeDisplay(value: unknown): value is JobChangeDisplay {
  if (!value || typeof value !== "object") return false;
  const display = value as Record<string, unknown>;
  return (
    display.kind === JOB_CHANGE_DISPLAY_KIND &&
    typeof display.text === "string" &&
    typeof display.jobName === "string"
  );
}
