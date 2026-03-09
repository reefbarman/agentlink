export interface BgSessionInfoProps {
  id: string;
  task: string;
  status:
    | "streaming"
    | "tool_executing"
    | "awaiting_approval"
    | "idle"
    | "error";
  currentTool?: string;
}

interface Props {
  sessions: BgSessionInfoProps[];
  onStop: (sessionId: string) => void;
}

function statusIcon(status: BgSessionInfoProps["status"]): string {
  switch (status) {
    case "streaming":
    case "tool_executing":
      return "codicon-loading codicon-modifier-spin";
    case "awaiting_approval":
      return "codicon-bell";
    case "idle":
      return "codicon-check";
    case "error":
      return "codicon-error";
  }
}

export function BackgroundSessionStrip({ sessions, onStop }: Props) {
  if (sessions.length === 0) return null;

  return (
    <div class="bg-session-strip">
      {sessions.map((s) => (
        <div key={s.id} class={`bg-session-card bg-session-${s.status}`}>
          <i class={`codicon ${statusIcon(s.status)}`} />
          <span class="bg-session-task" title={s.task}>
            {s.task}
          </span>
          {s.currentTool && s.status !== "idle" && s.status !== "error" && (
            <span class="bg-session-tool">{s.currentTool}</span>
          )}
          {(s.status === "streaming" || s.status === "tool_executing") && (
            <button
              class="icon-button bg-session-stop"
              onClick={() => onStop(s.id)}
              title="Stop background agent"
            >
              <i class="codicon codicon-debug-stop" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
