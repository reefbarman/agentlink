import type { ReasoningEffort, WebviewModelInfo } from "../types";
import {
  ToolbarControlButton,
  ToolbarSelector,
} from "../../../shared/ui/ToolbarSelector";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

const EFFORT_ICONS: Record<ReasoningEffort, string> = {
  none: "circle-slash",
  minimal: "dash",
  low: "arrow-small-down",
  medium: "circle-large-outline",
  high: "arrow-small-up",
  xhigh: "flame",
  max: "rocket",
};

const DEFAULT_REASONING_EFFORTS: ReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
];

interface ReasoningEffortSelectorProps {
  current: ReasoningEffort;
  currentModel: string;
  models: WebviewModelInfo[];
  disabled?: boolean;
  onSelect: (value: ReasoningEffort) => void;
}

export function ReasoningEffortSelector({
  current,
  currentModel,
  models,
  disabled,
  onSelect,
}: ReasoningEffortSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const options = useMemo<ReasoningEffort[]>(() => {
    const model = models.find((m) => m.id === currentModel);
    if (model && !model.reasoningEfforts?.length) return ["none"];
    const efforts = model?.reasoningEfforts?.length
      ? model.reasoningEfforts
      : DEFAULT_REASONING_EFFORTS;
    return efforts.includes("none")
      ? efforts
      : (["none", ...efforts] as ReasoningEffort[]);
  }, [currentModel, models]);

  const normalizedCurrent = options.includes(current)
    ? current
    : (options[0] ?? "none");
  const isActive = normalizedCurrent !== "none";

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

  const handleSelect = (value: ReasoningEffort) => {
    setOpen(false);
    if (value !== current) onSelect(value);
  };

  return (
    <ToolbarSelector
      containerRef={ref}
      open={open}
      trigger={
        <ToolbarControlButton
          className="thinking-toggle"
          active={isActive}
          onClick={() => !disabled && setOpen((o) => !o)}
          disabled={disabled}
          title={`Reasoning: ${EFFORT_LABELS[normalizedCurrent]}`}
          type="button"
        >
          <i class="codicon codicon-lightbulb" />
          <span>{EFFORT_LABELS[normalizedCurrent]}</span>
          <i
            class={`codicon codicon-chevron-${open ? "up" : "down"} toolbar-selector-chevron`}
          />
        </ToolbarControlButton>
      }
    >
      {options.map((effort) => (
        <button
          key={effort}
          class={`toolbar-selector-option ${effort === normalizedCurrent ? "active" : ""}`}
          onClick={() => handleSelect(effort)}
          type="button"
        >
          <i class={`codicon codicon-${EFFORT_ICONS[effort]}`} />
          <span>{EFFORT_LABELS[effort]}</span>
          {effort === normalizedCurrent && (
            <i class="codicon codicon-check toolbar-selector-check" />
          )}
        </button>
      ))}
    </ToolbarSelector>
  );
}
