import { CollapsibleSection } from "./common/CollapsibleSection.js";
import type { PostCommand } from "../types.js";

interface Props {
  postCommand: PostCommand;
}

export function ActivityShortcuts({ postCommand }: Props) {
  return (
    <CollapsibleSection title="Shortcuts">
      <div class="button-group">
        <button class="btn" onClick={() => postCommand("openSettings")}>
          Settings
        </button>
        <button class="btn" onClick={() => postCommand("openOutput")}>
          Output
        </button>
        <button class="btn" onClick={() => postCommand("openBrowserGateway")}>
          Browser Gateway
        </button>
      </div>
    </CollapsibleSection>
  );
}
