import { useState, useEffect } from "preact/hooks";
import type { TrackedCallInfo, PostCommand } from "../types.js";

interface Props {
  calls: TrackedCallInfo[];
  postCommand: PostCommand;
}

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

export function ActiveToolCalls({ calls, postCommand }: Props) {
  const [, setTick] = useState(0);

  const activeCalls = calls.filter((c) => c.status === "active");
  const completedCalls = calls.filter((c) => c.status === "completed");

  useEffect(() => {
    if (calls.length === 0) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [calls.length]);

  return (
    <div class="section tool-calls-section">
      <h3>
        Tool Calls{" "}
        {activeCalls.length > 0 && (
          <span class="badge badge-warn">{activeCalls.length}</span>
        )}
      </h3>
      {calls.length === 0 && (
        <p class="help-text">No active tool calls.</p>
      )}
      {activeCalls.map((c) => (
        <div key={c.id} class="tool-call-row">
          <div class="tool-call-header">
            <code class="tool-call-name">{c.toolName}</code>
            <span class="tool-call-elapsed">
              {formatElapsed(Date.now() - c.startedAt)}
            </span>
          </div>
          <div class="tool-call-args" title={c.displayArgs}>
            {c.displayArgs}
          </div>
          {c.lastHeartbeatAt && (
            <div class="tool-call-heartbeat" title="Time since last successful SSE heartbeat">
              heartbeat {formatElapsed(Date.now() - c.lastHeartbeatAt)} ago
            </div>
          )}
          <div class="tool-call-actions">
            <button
              class="btn btn-complete"
              onClick={() => postCommand("completeToolCall", { id: c.id })}
            >
              Complete
            </button>
            <button
              class="btn btn-cancel"
              onClick={() => postCommand("cancelToolCall", { id: c.id })}
            >
              Cancel
            </button>
          </div>
        </div>
      ))}
      {completedCalls.map((c) => (
        <div key={c.id} class="tool-call-row tool-call-completed">
          <div class="tool-call-header">
            <code class="tool-call-name">{c.toolName}</code>
            <span class="tool-call-elapsed tool-call-done">
              {formatElapsed((c.completedAt ?? Date.now()) - c.startedAt)}
            </span>
          </div>
          <div class="tool-call-args" title={c.displayArgs}>
            {c.displayArgs}
          </div>
        </div>
      ))}
    </div>
  );
}
