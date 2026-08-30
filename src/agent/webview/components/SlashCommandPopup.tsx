import { useEffect, useRef } from "preact/hooks";

import type { ChatSlashCommandInfo as SlashCommandInfo } from "@agentlink/protocol/chat-catalog";
import { forwardRef } from "preact/compat";
import { groupSlashCommandsForPicker } from "./slashCommandOrdering";

interface SlashCommandPopupProps {
  commands: SlashCommandInfo[];
  selectedIndex: number;
  query: string;
  anchor: { bottom: number; left: number };
  attachedToInput?: boolean;
  onSelect: (command: SlashCommandInfo) => void;
  onHover: (index: number) => void;
  onClose: () => void;
  /** If true, show a back button instead of section headers */
  isSubView?: boolean;
  subViewTitle?: string;
  onBack?: () => void;
}

export const SlashCommandPopup = forwardRef<
  HTMLDivElement,
  SlashCommandPopupProps
>(function SlashCommandPopup(
  {
    commands,
    selectedIndex,
    query,
    anchor,
    attachedToInput,
    onSelect,
    onHover,
    onClose: _onClose,
    isSubView,
    subViewTitle,
    onBack,
  },
  ref,
) {
  const listRef = useRef<HTMLDivElement>(null);
  const popupId = "slash-command-picker";

  useEffect(() => {
    const items = listRef.current?.querySelectorAll(".slash-cmd-option");
    items?.[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const renderItem = (cmd: SlashCommandInfo, index: number) => {
    const isSkillCommand = cmd.source === "skill";
    const displayName = cmd.displayName ?? cmd.name;
    const rightLabel = isSkillCommand ? "Skill" : cmd.rightLabel;
    const isSelected = index === selectedIndex;

    return (
      <button
        id={`${popupId}-option-${index}`}
        key={`${cmd.source}:${cmd.name}:${index}`}
        role="option"
        aria-selected={isSelected}
        class={`slash-cmd-option ${isSelected ? "selected" : ""}`}
        onMouseEnter={() => onHover(index)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onSelect(cmd)}
        type="button"
      >
        {cmd.icon ? (
          <i class={`codicon codicon-${cmd.icon} slash-cmd-icon`} />
        ) : (
          <i
            class={`codicon codicon-${cmd.builtin ? "symbol-event" : isSkillCommand ? "sparkle" : "file"} slash-cmd-icon`}
          />
        )}
        <span class="slash-cmd-copy">
          <span class="slash-cmd-name">/{displayName}</span>
          {cmd.description && (
            <span class="slash-cmd-desc">{cmd.description}</span>
          )}
        </span>
        {rightLabel && <span class="slash-cmd-right">{rightLabel}</span>}
        {cmd.isCurrent && <i class="codicon codicon-check slash-cmd-check" />}
      </button>
    );
  };

  if (isSubView) {
    return (
      <div
        ref={ref}
        class={`slash-cmd-popup ${attachedToInput ? "slash-cmd-popup-attached" : ""}`}
        id={popupId}
        style={{ bottom: `${anchor.bottom}px`, left: `${anchor.left}px` }}
      >
        <button class="slash-cmd-back" onClick={onBack} type="button">
          <i class="codicon codicon-arrow-left" />
          <span>{subViewTitle}</span>
        </button>
        <div class="slash-cmd-list" ref={listRef} role="listbox">
          {commands.map((command, index) => {
            const isSelected = index === selectedIndex;
            return (
              <button
                id={`${popupId}-option-${index}`}
                key={command.name}
                role="option"
                aria-selected={isSelected}
                class={`slash-cmd-option ${isSelected ? "selected" : ""}`}
                onMouseEnter={() => onHover(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(command)}
                type="button"
              >
                {command.icon && (
                  <i class={`codicon codicon-${command.icon} slash-cmd-icon`} />
                )}
                <span class="slash-cmd-name">{command.description}</span>
                {command.isCurrent && (
                  <i class="codicon codicon-check slash-cmd-check" />
                )}
              </button>
            );
          })}
        </div>
        <div class="slash-cmd-footer" aria-hidden="true">
          <span>↑↓ Navigate</span>
          <span>↵ Select</span>
          <span>Esc Back</span>
        </div>
      </div>
    );
  }

  const groups = groupSlashCommandsForPicker(commands);
  let itemIndex = 0;
  const indexedGroups = groups.map(({ label, commands: group }) => ({
    label,
    commands: group.map((command) => ({ command, index: itemIndex++ })),
  }));

  return (
    <div
      ref={ref}
      class={`slash-cmd-popup ${attachedToInput ? "slash-cmd-popup-attached" : ""}`}
      id={popupId}
      style={{ bottom: `${anchor.bottom}px`, left: `${anchor.left}px` }}
    >
      <div class="slash-cmd-header" aria-live="polite">
        <span class="slash-cmd-header-title">Commands</span>
        <span class="slash-cmd-header-meta">
          {commands.length} {commands.length === 1 ? "match" : "matches"}
          {query && ` for /${query}`}
        </span>
      </div>
      <div class="slash-cmd-list" ref={listRef} role="listbox">
        {commands.length === 0 ? (
          <div class="slash-cmd-empty" role="status">
            <i class="codicon codicon-search" />
            <span>
              No commands match <strong>/{query}</strong>
            </span>
          </div>
        ) : (
          indexedGroups.map(({ label, commands: group }) => (
            <div
              key={label}
              class="slash-cmd-group"
              role="group"
              aria-label={label}
            >
              <div class="slash-cmd-section">{label}</div>
              {group.map(({ command, index }) => renderItem(command, index))}
            </div>
          ))
        )}
      </div>
      <div class="slash-cmd-footer" aria-hidden="true">
        <span>↑↓ Navigate</span>
        <span>↵ Select</span>
        <span>Tab Complete</span>
        <span>Esc Close</span>
      </div>
    </div>
  );
});
