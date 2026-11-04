import { useEffect, useRef } from "preact/hooks";

import type { ChatMcpPromptArgument } from "@agentlink/protocol/chat-catalog";

export function McpPromptArgumentPicker({
  argument,
  argumentIndex,
  argumentCount,
  values,
  selectedIndex,
  onSelect,
  onHover,
  pending,
  error,
}: {
  argument?: ChatMcpPromptArgument;
  argumentIndex: number;
  argumentCount: number;
  values: string[];
  selectedIndex: number;
  onSelect(value: string): void;
  onHover(index: number): void;
  pending: boolean;
  error: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelectorAll("[role=option]")
      [selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);
  return (
    <>
      {values.length > 0 && argument && (
        <div class="slash-cmd-popup slash-cmd-popup-attached">
          <div class="slash-cmd-header">
            <span class="slash-cmd-header-title">Choose {argument.name}</span>
            <span class="slash-cmd-header-meta">
              {argument.required ? "Required" : "Optional"} argument
            </span>
          </div>
          {argument.description && (
            <div class="slash-cmd-header">{argument.description}</div>
          )}
          <div
            class="slash-cmd-list"
            role="listbox"
            id="mcp-argument-picker"
            aria-label={`Suggestions for ${argument.name}`}
            ref={listRef}
          >
            {values.map((value, index) => (
              <button
                key={value}
                type="button"
                role="option"
                id={`mcp-argument-option-${index}`}
                aria-selected={index === selectedIndex}
                class={`slash-cmd-option ${index === selectedIndex ? "selected" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHover(index)}
                onClick={() => onSelect(value)}
              >
                <i class="codicon codicon-symbol-value slash-cmd-icon" />
                <span class="slash-cmd-copy">
                  <span class="slash-cmd-name">{value}</span>
                </span>
              </button>
            ))}
          </div>
          <div class="slash-cmd-footer">
            <span>↑↓ Navigate</span>
            <span>Tab / ↵ Select</span>
            <span>Esc Close</span>
          </div>
        </div>
      )}
      <div
        class="slash-cmd-header"
        aria-label="MCP prompt arguments"
        aria-live="polite"
      >
        {pending ? (
          <span role="status">Waiting for MCP prompt approval</span>
        ) : argument ? (
          <>
            <span class="slash-cmd-header-title">{argument.name}</span>
            <span>{argument.description || "Enter a value"}</span>
            <span class="slash-cmd-header-meta">
              {argumentIndex + 1}/{argumentCount} ·{" "}
              {argument.required ? "Required" : "Optional"}
            </span>
          </>
        ) : (
          <span>Enter arguments, then submit to review the prompt.</span>
        )}
      </div>
      {error && (
        <div class="slash-cmd-header" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
