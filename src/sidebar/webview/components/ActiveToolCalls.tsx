import type { PostCommand, TrackedCallInfo } from "../types.js";
import { useEffect, useState } from "preact/hooks";

import { CollapsibleSection } from "./common/CollapsibleSection.js";

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

  const hasActiveCalls = activeCalls.length > 0;
  useEffect(() => {
    if (!hasActiveCalls) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [hasActiveCalls]);

  return (
    <CollapsibleSection
      title="Tool Calls"
      className="tool-calls-section"
      titleExtra={
        activeCalls.length > 0 ? (
          <span class="badge badge-warn" style={{ marginLeft: "6px" }}>
            {activeCalls.length}
          </span>
        ) : undefined
      }
    >
      {calls.length === 0 && <p class="help-text">No active tool calls.</p>}
      {activeCalls.map((c) => (
        <div key={c.id} class="tool-call-row">
          <div class="tool-call-header">
            <code class="tool-call-name">{c.toolName}</code>
            <span class="tool-call-elapsed">
              {formatElapsed(Date.now() - c.startedAt)}
            </span>
          </div>
          {c.displayArgs && (
            <div class="tool-call-args" title={c.displayArgs}>
              {c.displayArgs}
            </div>
          )}
          {c.params && (
            <details class="tool-call-params">
              <summary>params</summary>
              <pre>{c.params}</pre>
            </details>
          )}
          <div class="tool-call-actions">
            {c.canContinueInBackground && (
              <button
                class="btn"
                title={
                  c.toolName === "get_background_result"
                    ? "Return control to the agent while the background agent keeps running"
                    : "Return control to the agent while the command keeps running"
                }
                onClick={() =>
                  postCommand("continueToolCallInBackground", { id: c.id })
                }
              >
                Continue in background
              </button>
            )}
            <button
              class="btn btn-complete"
              title="Mark this tool call as complete and return control to the agent"
              onClick={() => postCommand("completeToolCall", { id: c.id })}
            >
              Complete
            </button>
            <button
              class="btn btn-cancel"
              title="Stop this tool call and report its cancellation to the agent"
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
          {c.displayArgs && (
            <div class="tool-call-args" title={c.displayArgs}>
              {c.displayArgs}
            </div>
          )}
          {c.params && (
            <details class="tool-call-params">
              <summary>params</summary>
              <pre>{c.params}</pre>
            </details>
          )}
        </div>
      ))}
    </CollapsibleSection>
  );
}
