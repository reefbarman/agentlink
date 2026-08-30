import { CollapsibleSection } from "./common/CollapsibleSection.js";
import type { PostCommand } from "@agentlink/protocol/sidebar-transport";

interface Props {
  postCommand: PostCommand;
}

export function ActivityShortcuts({ postCommand }: Props) {
  return (
    <CollapsibleSection title="Shortcuts">
      <div class="button-group">
        <button
          class="btn"
          title="Open AgentLink settings in VS Code"
          onClick={() => postCommand("openSettings")}
        >
          Settings
        </button>
        <button
          class="btn"
          title="Open the AgentLink Output panel for logs and diagnostics"
          onClick={() => postCommand("openOutput")}
        >
          Output
        </button>
        <button
          class="btn"
          title="Open AgentLink in your browser for remote or full-page access"
          onClick={() => postCommand("openBrowserGateway")}
        >
          Browser Gateway
        </button>
      </div>
    </CollapsibleSection>
  );
}
