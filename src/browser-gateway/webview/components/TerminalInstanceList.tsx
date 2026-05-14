import type { TerminalBuffer } from "../../../shared/terminalActivity";

interface TerminalInstanceListProps {
  buffers: TerminalBuffer[];
  selectedBufferId: string;
  onSelectBuffer: (id: string) => void;
}

function statusIcon(status: TerminalBuffer["lastStatus"]): string {
  switch (status) {
    case "running":
      return "codicon-loading codicon-modifier-spin";
    case "warning":
      return "codicon-warning";
    case "error":
      return "codicon-error";
    default:
      return "codicon-terminal";
  }
}

export function TerminalInstanceList({
  buffers,
  selectedBufferId,
  onSelectBuffer,
}: TerminalInstanceListProps) {
  return (
    <aside class="terminal-instance-list" aria-label="Terminal instances">
      <div class="terminal-instance-list-title">Terminals</div>
      {buffers.map((buffer) => {
        const active = buffer.id === selectedBufferId;
        return (
          <button
            key={buffer.id}
            class={`terminal-instance-item terminal-instance-status-${buffer.lastStatus ?? "completed"}${active ? " active" : ""}`}
            type="button"
            aria-pressed={active}
            onClick={() => onSelectBuffer(buffer.id)}
            title={buffer.terminalId ?? buffer.label}
          >
            <i
              class={`terminal-instance-icon codicon ${statusIcon(buffer.lastStatus)}`}
            />
            <span class="terminal-instance-label">{buffer.label}</span>
            {buffer.lastStatus === "warning" && (
              <i class="terminal-instance-warning codicon codicon-warning" />
            )}
          </button>
        );
      })}
    </aside>
  );
}
