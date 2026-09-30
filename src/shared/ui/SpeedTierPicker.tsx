import { ToolbarControlButton, ToolbarSelector } from "./ToolbarSelector";
import { useEffect, useRef, useState } from "preact/hooks";

import type { ChatModelInfo } from "@agentlink/protocol/chat-catalog";
import type { CoreServiceTierSelection } from "@agentlink/protocol/model-catalog";

const TIER_LABELS: Record<CoreServiceTierSelection, string> = {
  standard: "Standard",
  fast: "Fast",
  ultrafast: "Ultrafast",
};

const TIER_DESCRIPTIONS: Record<CoreServiceTierSelection, string> = {
  standard: "Normal speed and price.",
  fast: "Faster responses, uses more of your plan or API budget.",
  ultrafast: "Fastest responses at a premium price.",
};

interface SpeedTierPickerProps {
  current: CoreServiceTierSelection;
  currentModel: string;
  models: readonly ChatModelInfo[];
  disabled?: boolean;
  onSelect: (tier: CoreServiceTierSelection) => void;
}

/** Speed tiers selectable for the model: standard plus any premium tiers. */
export function getSpeedTierOptions(
  currentModel: string,
  models: readonly ChatModelInfo[],
): CoreServiceTierSelection[] {
  const tiers = models.find((model) => model.id === currentModel)?.serviceTiers;
  return tiers?.length ? ["standard", ...tiers] : [];
}

/**
 * Session speed control. Hidden for models without premium tiers, a single
 * on/off button when the model has one premium tier, and a dropdown otherwise.
 */
export function SpeedTierPicker({
  current,
  currentModel,
  models,
  disabled,
  onSelect,
}: SpeedTierPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const options = getSpeedTierOptions(currentModel, models);
  const effective = options.includes(current) ? current : "standard";
  const isActive = effective !== "standard";

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

  if (options.length === 0) return null;

  if (options.length === 2) {
    const premium = options[1];
    return (
      <ToolbarControlButton
        className="speed-tier-toggle"
        active={isActive}
        aria-pressed={isActive}
        disabled={disabled}
        title={
          isActive
            ? `${TIER_LABELS[premium]} is on: ${TIER_DESCRIPTIONS[premium]} Click to turn off.`
            : `Turn on ${TIER_LABELS[premium]}: ${TIER_DESCRIPTIONS[premium]}`
        }
        type="button"
        onClick={() => !disabled && onSelect(isActive ? "standard" : premium)}
      >
        <i class="codicon codicon-zap" />
        <span>{TIER_LABELS[premium]}</span>
      </ToolbarControlButton>
    );
  }

  const handleSelect = (tier: CoreServiceTierSelection) => {
    setOpen(false);
    if (tier !== effective) onSelect(tier);
  };

  return (
    <ToolbarSelector
      containerRef={ref}
      open={open}
      trigger={
        <ToolbarControlButton
          className="speed-tier-toggle"
          active={isActive}
          onClick={() => !disabled && setOpen((o) => !o)}
          disabled={disabled}
          title={`Speed: ${TIER_LABELS[effective]}`}
          type="button"
        >
          <i class="codicon codicon-zap" />
          <span>{TIER_LABELS[effective]}</span>
          <i
            class={`codicon codicon-chevron-${open ? "up" : "down"} toolbar-selector-chevron`}
          />
        </ToolbarControlButton>
      }
    >
      {options.map((tier) => (
        <button
          key={tier}
          class={`toolbar-selector-option ${tier === effective ? "active" : ""}`}
          title={TIER_DESCRIPTIONS[tier]}
          onClick={() => handleSelect(tier)}
          type="button"
        >
          <span>{TIER_LABELS[tier]}</span>
          {tier === effective && (
            <i class="codicon codicon-check toolbar-selector-check" />
          )}
        </button>
      ))}
    </ToolbarSelector>
  );
}
