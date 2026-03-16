import { useEffect, useRef } from "preact/hooks";
import type { SlashCommandInfo } from "../types.js";

interface SlashCommandPopupProps {
  commands: SlashCommandInfo[];
  selectedIndex: number;
  anchor: { bottom: number; left: number };
  onSelect: (command: SlashCommandInfo) => void;
  onClose: () => void;
  /** If true, show a back button instead of section headers */
  isSubView?: boolean;
  subViewTitle?: string;
  onBack?: () => void;
}

const SOURCE_SECTIONS: Array<{ source: string; label: string }> = [
  { source: "project", label: "Project" },
  { source: "global", label: "Global" },
  { source: "agentlink", label: "AgentLink" },
];

export function SlashCommandPopup({
  commands,
  selectedIndex,
  anchor,
  onSelect,
  onClose: _onClose,
  isSubView,
  subViewTitle,
  onBack,
}: SlashCommandPopupProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const items = listRef.current?.querySelectorAll(".slash-cmd-option");
    items?.[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (commands.length === 0) return null;

  // In sub-view (mode/model picker), render flat list
  if (isSubView) {
    return (
      <div
        class="slash-cmd-popup"
        style={{ bottom: `${anchor.bottom}px`, left: `${anchor.left}px` }}
      >
        <button class="slash-cmd-back" onClick={onBack} type="button">
          <i class="codicon codicon-arrow-left" />
          <span>{subViewTitle}</span>
        </button>
        <div class="slash-cmd-list" ref={listRef}>
          {commands.map((cmd, idx) => (
            <button
              key={cmd.name}
              class={`slash-cmd-option ${idx === selectedIndex ? "selected" : ""}`}
              onClick={() => onSelect(cmd)}
              type="button"
            >
              {cmd.icon && (
                <i class={`codicon codicon-${cmd.icon} slash-cmd-icon`} />
              )}
              <span class="slash-cmd-name">{cmd.description}</span>
              {cmd.isCurrent && (
                <i class="codicon codicon-check slash-cmd-check" />
              )}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Main view: split into builtin section + file command sections
  const builtins = commands.filter((c) => c.builtin);
  const fileCmds = commands.filter((c) => !c.builtin);

  // Index tracker for keyboard navigation across all items
  let flatIdx = 0;

  const renderItem = (cmd: SlashCommandInfo, navIdx: number) => (
    <button
      key={cmd.name}
      class={`slash-cmd-option ${navIdx === selectedIndex ? "selected" : ""}`}
      onClick={() => onSelect(cmd)}
      type="button"
    >
      {cmd.icon ? (
        <i class={`codicon codicon-${cmd.icon} slash-cmd-icon`} />
      ) : (
        <i
          class={`codicon codicon-${cmd.builtin ? "symbol-event" : "file"} slash-cmd-icon`}
        />
      )}
      <span class="slash-cmd-name">/{cmd.name}</span>
      {cmd.description && <span class="slash-cmd-desc">{cmd.description}</span>}
      {cmd.rightLabel && <span class="slash-cmd-right">{cmd.rightLabel}</span>}
      {cmd.isCurrent && <i class="codicon codicon-check slash-cmd-check" />}
    </button>
  );

  return (
    <div
      class="slash-cmd-popup"
      style={{ bottom: `${anchor.bottom}px`, left: `${anchor.left}px` }}
    >
      <div class="slash-cmd-list" ref={listRef}>
        {SOURCE_SECTIONS.map(({ source, label }) => {
          const cmds = fileCmds.filter((c) => c.source === source);
          if (cmds.length === 0) return null;
          return (
            <div key={source}>
              <div class="slash-cmd-section">{label}</div>
              {cmds.map((cmd) => {
                const idx = flatIdx++;
                return renderItem(cmd, idx);
              })}
            </div>
          );
        })}
        {builtins.length > 0 && (
          <>
            <div class="slash-cmd-section">Built-in</div>
            {builtins.map((cmd) => {
              const idx = flatIdx++;
              return renderItem(cmd, idx);
            })}
          </>
        )}
      </div>
    </div>
  );
}
