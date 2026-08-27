import type { WorktreeSetupState } from "../types";
import { useState } from "preact/hooks";

interface WorktreeSetupPanelProps {
  state: WorktreeSetupState;
  onCancel: (requestId: string) => void;
  onDismiss: () => void;
  onLaunch: (requestId: string, autoSubmit: boolean) => void;
  onReply: (requestId: string, text: string) => void;
}

export function WorktreeSetupPanel({
  state,
  onCancel,
  onDismiss,
  onLaunch,
  onReply,
}: WorktreeSetupPanelProps) {
  const [reply, setReply] = useState("");
  const running = state.phase === "configuring";
  const awaitingInput = state.phase === "awaiting_input";
  const ready = state.phase === "ready" && state.config;
  const launching = state.phase === "launching";
  const lastTool = state.tools?.[state.tools.length - 1];

  return (
    <div class="btw-panel worktree-setup-panel">
      <div class="btw-header">
        <i class="codicon codicon-git-branch" />
        <span class="btw-question">Worktree setup</span>
        {state.budget &&
          (state.budget.apiTurns > 0 || state.budget.toolCalls > 0) && (
            <span
              class="btw-budget"
              title="API turns and tool calls used by the setup agent"
            >
              {state.budget.apiTurns}/{state.budget.maxApiTurns} turns ·{" "}
              {state.budget.toolCalls}/{state.budget.maxToolCalls} tools
            </span>
          )}
        {running && (
          <button
            class="icon-button btw-cancel"
            onClick={() => onCancel(state.requestId)}
            title="Cancel worktree setup"
          >
            <i class="codicon codicon-stop-circle" />
          </button>
        )}
        <button
          class="icon-button btw-close"
          onClick={onDismiss}
          title="Dismiss"
        >
          <i class="codicon codicon-close" />
        </button>
      </div>

      <div class={`btw-body${state.phase === "error" ? " btw-error" : ""}`}>
        {state.input && <div class="worktree-setup-input">{state.input}</div>}
        {(state.conversation?.length ?? 0) > 0 && (
          <div class="worktree-setup-conversation">
            {state.conversation?.map((message, index) => (
              <div
                class={`worktree-setup-message worktree-setup-message-${message.role}`}
                key={`${message.role}-${index}`}
              >
                {message.text}
              </div>
            ))}
          </div>
        )}
        {state.answer && !awaitingInput && (
          <div class="worktree-setup-answer">{state.answer}</div>
        )}
        {running && (
          <div class="btw-loading">
            <i class="codicon codicon-loading codicon-modifier-spin" />
            <span>
              {lastTool
                ? `Inspecting with ${lastTool}…`
                : "Preparing the worktree…"}
            </span>
          </div>
        )}
        {launching && (
          <div class="btw-loading">
            <i class="codicon codicon-loading codicon-modifier-spin" />
            <span>Creating and opening the worktree…</span>
          </div>
        )}
        {state.config && (
          <dl class="worktree-setup-summary">
            <div>
              <dt>Task</dt>
              <dd>{state.config.task}</dd>
            </div>
            <div>
              <dt>Prompt</dt>
              <dd>{state.config.prompt}</dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd>{state.config.branch ?? "AgentLink default"}</dd>
            </div>
            <div>
              <dt>Base</dt>
              <dd>
                {state.config.fetchRef
                  ? `${state.config.fetchRef.repository}:${state.config.fetchRef.ref}`
                  : (state.config.baseRef ?? "Current HEAD")}
              </dd>
            </div>
            <div>
              <dt>Location</dt>
              <dd>{state.config.worktreePath ?? "AgentLink default"}</dd>
            </div>
          </dl>
        )}
        {state.message && (
          <div class={`btw-notice worktree-setup-${state.phase}`}>
            {state.message}
          </div>
        )}
        {awaitingInput && (
          <form
            class="worktree-setup-reply"
            onSubmit={(event) => {
              event.preventDefault();
              const text = reply.trim();
              if (!text) return;
              setReply("");
              onReply(state.requestId, text);
            }}
          >
            <textarea
              aria-label="Reply to worktree setup agent"
              placeholder="Reply to the setup agent…"
              rows={2}
              value={reply}
              onInput={(event) => setReply(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey) return;
                event.preventDefault();
                const text = reply.trim();
                if (!text) return;
                setReply("");
                onReply(state.requestId, text);
              }}
            />
            <button type="submit" disabled={!reply.trim()}>
              Send
            </button>
          </form>
        )}
      </div>

      {ready && (
        <div class="btw-footer">
          {(state.warnings?.length ?? 0) > 0 && (
            <span class="btw-warnings" title={state.warnings?.join("\n")}>
              <i class="codicon codicon-warning" /> {state.warnings?.length}
            </span>
          )}
          <button
            class="btw-promote"
            onClick={() =>
              onLaunch(state.requestId, state.config?.autoSubmit !== false)
            }
          >
            <i class="codicon codicon-open-preview" />
            {state.config?.autoSubmit === false
              ? "Create & prefill"
              : "Create & start"}
          </button>
          <button
            class="worktree-setup-secondary-action"
            onClick={() =>
              onLaunch(state.requestId, state.config?.autoSubmit === false)
            }
          >
            {state.config?.autoSubmit === false
              ? "Create & start"
              : "Create & prefill"}
          </button>
        </div>
      )}
    </div>
  );
}
