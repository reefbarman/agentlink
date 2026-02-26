import { useState } from "preact/hooks";
import type { FindReplaceFileGroup } from "../types.js";
import { DiffBlock } from "./DiffBlock.js";

interface FileSectionProps {
  group: FindReplaceFileGroup;
  fileIndex: number;
  accepted: Map<string, boolean>;
  allAccepted: boolean;
  onToggleMatch: (matchId: string) => void;
  onToggleFile: (value: boolean) => void;
}

export function FileSection({
  group,
  accepted,
  allAccepted,
  onToggleMatch,
  onToggleFile,
}: FileSectionProps) {
  const [collapsed, setCollapsed] = useState(false);
  const acceptedCount = group.matches.filter((m) => accepted.get(m.id)).length;

  return (
    <div class="fr-file-section">
      <div class="fr-file-header">
        <button
          class="fr-collapse-btn"
          onClick={() => setCollapsed(!collapsed)}
        >
          <span
            class={`codicon ${collapsed ? "codicon-chevron-right" : "codicon-chevron-down"}`}
          />
        </button>
        <span class="codicon codicon-file fr-file-icon" />
        <span class="fr-file-path">{group.path}</span>
        <span class="fr-file-count">
          {acceptedCount}/{group.matches.length}
        </span>
        <button
          class={`fr-file-toggle ${allAccepted ? "fr-accepted" : "fr-excluded"}`}
          onClick={() => onToggleFile(!allAccepted)}
          title={allAccepted ? "Exclude all in file" : "Include all in file"}
        >
          <span
            class={`codicon ${allAccepted ? "codicon-check" : "codicon-close"}`}
          />
        </button>
      </div>
      {!collapsed && (
        <div class="fr-file-matches">
          {group.matches.map((match) => (
            <DiffBlock
              key={match.id}
              match={match}
              isAccepted={accepted.get(match.id) ?? true}
              onToggle={onToggleMatch}
            />
          ))}
        </div>
      )}
    </div>
  );
}
