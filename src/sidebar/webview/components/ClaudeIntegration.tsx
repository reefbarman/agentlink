import type { SidebarState, PostCommand } from "../types.js";

interface Props {
  state: SidebarState;
  postCommand: PostCommand;
}

export function ClaudeIntegration({ state, postCommand }: Props) {
  const { serverRunning, claudeConfigured } = state;

  if (!serverRunning) {
    return (
      <div class="section">
        <h3>Claude Code Integration</h3>
        <p class="help-text">
          Start the server to configure Claude Code integration.
        </p>
      </div>
    );
  }

  return (
    <div class="section">
      <h3>Claude Code Integration</h3>
      <div class="info-row">
        <span class="label">~/.claude.json:</span>
        {claudeConfigured ? (
          <span class="badge badge-ok">Configured</span>
        ) : (
          <span class="badge badge-warn">Not configured</span>
        )}
      </div>
      <p class="help-text">
        The extension auto-configures Claude Code on startup. If you need to set
        it up manually:
      </p>
      <div class="button-group">
        <button
          class="btn btn-secondary"
          onClick={() => postCommand("installCli")}
        >
          Run CLI Setup
        </button>
        <button
          class="btn btn-secondary"
          onClick={() => postCommand("copyCliCommand")}
        >
          Copy CLI Command
        </button>
        <button
          class="btn btn-secondary"
          onClick={() => postCommand("copyConfig")}
        >
          Copy JSON Config
        </button>
      </div>
    </div>
  );
}
