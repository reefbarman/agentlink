import { TOOL_REGISTRY } from "../../../shared/toolRegistry.js";
import { CollapsibleSection } from "./common/CollapsibleSection.js";

export function AvailableTools() {
  const tools = Object.entries(TOOL_REGISTRY).filter(
    ([, t]) => !t.devOnly || __DEV_BUILD__,
  );

  return (
    <CollapsibleSection title="Available Tools" defaultOpen={false}>
      <ul class="tools-list">
        {tools.map(([name, t]) => (
          <li key={name} title={t.description}>
            <code>{name}</code> — {t.label}
          </li>
        ))}
      </ul>
    </CollapsibleSection>
  );
}
