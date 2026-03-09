import { useState, useRef, useEffect } from "preact/hooks";
import type { ModeInfo } from "../types";

interface ModeSelectorProps {
  currentMode: string;
  modes: ModeInfo[];
  disabled?: boolean;
  onSelect: (slug: string) => void;
}

export function ModeSelector({
  currentMode,
  modes,
  disabled,
  onSelect,
}: ModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = modes.find((m) => m.slug === currentMode) ?? modes[0];

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSelect = (slug: string) => {
    setOpen(false);
    if (slug !== currentMode) onSelect(slug);
  };

  return (
    <div class="toolbar-selector" ref={ref}>
      <button
        class="toolbar-control"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        title={`Mode: ${current?.name ?? currentMode}`}
        type="button"
      >
        {current && <i class={`codicon codicon-${current.icon}`} />}
        <span>{current?.name ?? currentMode}</span>
        <i
          class={`codicon codicon-chevron-${open ? "up" : "down"} toolbar-selector-chevron`}
        />
      </button>
      {open && (
        <div class="toolbar-selector-dropdown">
          {modes.map((m) => (
            <button
              key={m.slug}
              class={`toolbar-selector-option ${m.slug === currentMode ? "active" : ""}`}
              onClick={() => handleSelect(m.slug)}
              type="button"
            >
              <i class={`codicon codicon-${m.icon}`} />
              <span>{m.name}</span>
              {m.slug === currentMode && (
                <i class="codicon codicon-check toolbar-selector-check" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
