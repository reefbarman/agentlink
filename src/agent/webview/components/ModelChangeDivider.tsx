import type { ReasoningEffort } from "../types";

interface ModelChangeDividerProps {
  modelChange?: {
    previousModel: string;
    model: string;
  };
  reasoningChange?: {
    previousReasoningEffort: ReasoningEffort;
    reasoningEffort: ReasoningEffort;
  };
}

const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

/** Marks where subsequent transcript responses changed model or thinking level. */
export function ModelChangeDivider({
  modelChange,
  reasoningChange,
}: ModelChangeDividerProps) {
  const accessibleChanges = [
    modelChange
      ? `Model changed from ${modelChange.previousModel} to ${modelChange.model}`
      : null,
    reasoningChange
      ? `Thinking level changed from ${REASONING_EFFORT_LABELS[reasoningChange.previousReasoningEffort]} to ${REASONING_EFFORT_LABELS[reasoningChange.reasoningEffort]}`
      : null,
  ].filter((change): change is string => Boolean(change));

  return (
    <div
      class="model-change-divider"
      role="separator"
      aria-label={accessibleChanges.join("; ")}
    >
      <span class="model-change-divider-line" aria-hidden="true" />
      <span
        class="model-change-divider-badge"
        title={accessibleChanges.join("; ")}
      >
        <i class="codicon codicon-arrow-swap" aria-hidden="true" />
        {modelChange && (
          <>
            <span>Model changed to</span>
            <span class="model-change-divider-model">{modelChange.model}</span>
          </>
        )}
        {modelChange && reasoningChange && <span aria-hidden="true">·</span>}
        {reasoningChange && (
          <>
            <span>Thinking level changed to</span>
            <span class="model-change-divider-model">
              {REASONING_EFFORT_LABELS[reasoningChange.reasoningEffort]}
            </span>
          </>
        )}
      </span>
      <span class="model-change-divider-line" aria-hidden="true" />
    </div>
  );
}
