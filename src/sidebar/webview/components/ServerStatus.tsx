import type { SidebarState, PostCommand } from "../types.js";
import { CollapsibleSection } from "./common/CollapsibleSection.js";

interface Props {
  state: SidebarState;
  postCommand: PostCommand;
}

export function ServerStatus({ state, postCommand }: Props) {
  const { serverRunning, port, authEnabled, masterBypass, connectedAgents } =
    state;

  const agentCount = connectedAgents?.length ?? 0;

  return (
    <CollapsibleSection
      title="Server Status"
      titleExtra={
        serverRunning && agentCount > 0 ? (
          <span class="badge badge-ok">{agentCount}</span>
        ) : undefined
      }
    >
      <div class="status-header">
        <span class={`dot ${serverRunning ? "running" : "stopped"}`} />
        <span class="status-text">
          {serverRunning ? `Running on port ${port}` : "Stopped"}
        </span>
      </div>
      <div class="info-row">
        <span class="label">Auth:</span>
        <span class="value">{authEnabled ? "Enabled" : "Disabled"}</span>
      </div>
      <div class="info-row">
        <span class="label">Master Bypass:</span>
        <span class="value">{masterBypass ? "ON" : "Off"}</span>
      </div>
      <div class="button-group">
        {serverRunning ? (
          <button
            class="btn btn-secondary"
            onClick={() => postCommand("stopServer")}
          >
            Stop Server
          </button>
        ) : (
          <button
            class="btn btn-primary"
            onClick={() => postCommand("startServer")}
          >
            Start Server
          </button>
        )}
      </div>
      {serverRunning && (
        <div class="connected-agents">
          <div class="subsection-label">Connected Agents</div>
          {agentCount === 0 ? (
            <p class="help-text">No agents connected.</p>
          ) : (
            connectedAgents!.map((a) => (
              <div
                key={a.sessionId}
                class="connected-agent-row"
                title={`Session: ${a.sessionId}`}
              >
                <span
                  class={`agent-dot ${a.agentId ? "known" : "unknown"}`}
                />
                <span class="agent-name">
                  {a.agentDisplayName ??
                    a.clientName ??
                    `Session ${a.sessionId.substring(0, 8)}...`}
                </span>
                {a.clientVersion && (
                  <span class="agent-version">v{a.clientVersion}</span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </CollapsibleSection>
  );
}
