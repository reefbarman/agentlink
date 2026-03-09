import { useState, useRef, useEffect } from "preact/hooks";

const WRITE_APPROVAL_OPTIONS = [
  { value: "prompt", label: "Prompt", icon: "shield" },
  { value: "session", label: "Session", icon: "clock" },
  { value: "project", label: "Project", icon: "folder" },
  { value: "global", label: "Always", icon: "globe" },
] as const;

interface WriteApprovalSelectorProps {
  current: string;
  disabled?: boolean;
  onSelect: (value: string) => void;
}

export function WriteApprovalSelector({
  current,
  disabled,
  onSelect,
}: WriteApprovalSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const currentOption =
    WRITE_APPROVAL_OPTIONS.find((o) => o.value === current) ??
    WRITE_APPROVAL_OPTIONS[0];
  const isActive = current !== "prompt";

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

  const handleSelect = (value: string) => {
    setOpen(false);
    if (value !== current) onSelect(value);
  };

  return (
    <div class="toolbar-selector" ref={ref}>
      <button
        class={`toolbar-control write-approval-toggle ${isActive ? "active" : ""}`}
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        title={`Writes: ${currentOption.label}`}
        type="button"
      >
        <i class="codicon codicon-edit" />
        <span>{currentOption.label}</span>
        <i
          class={`codicon codicon-chevron-${open ? "up" : "down"} toolbar-selector-chevron`}
        />
      </button>
      {open && (
        <div class="toolbar-selector-dropdown">
          {WRITE_APPROVAL_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              class={`toolbar-selector-option ${opt.value === current ? "active" : ""}`}
              onClick={() => handleSelect(opt.value)}
              type="button"
            >
              <i class={`codicon codicon-${opt.icon}`} />
              <span>{opt.label}</span>
              {opt.value === current && (
                <i class="codicon codicon-check toolbar-selector-check" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
