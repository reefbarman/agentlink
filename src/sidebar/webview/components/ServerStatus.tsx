import type { SidebarState, PostCommand } from "../types.js";

interface Props {
  state: SidebarState;
  postCommand: PostCommand;
}

export function ServerStatus({ state, postCommand }: Props) {
  const { serverRunning, port, sessions, authEnabled, masterBypass } = state;

  return (
    <div class="section">
      <h3>Server Status</h3>
      <div class="status-header">
        <span class={`dot ${serverRunning ? "running" : "stopped"}`} />
        <span class="status-text">
          {serverRunning ? `Running on port ${port}` : "Stopped"}
        </span>
      </div>
      {serverRunning && (
        <div class="info-row">
          <span class="label">Sessions:</span>
          <span class="value">{sessions}</span>
        </div>
      )}
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
      <div class="link-row" style={{ marginTop: "8px" }}>
        <a onClick={() => postCommand("openSettings")}>Settings</a> &middot;{" "}
        <a onClick={() => postCommand("openOutput")}>Output Log</a>
      </div>
      <div class="link-row">
        <a onClick={() => postCommand("openGlobalConfig")}>Global Config</a>{" "}
        &middot;{" "}
        <a onClick={() => postCommand("openProjectConfig")}>Project Config</a>
      </div>
    </div>
  );
}
