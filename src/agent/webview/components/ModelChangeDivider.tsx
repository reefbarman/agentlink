interface ModelChangeDividerProps {
  previousModel: string;
  model: string;
}

/** Marks the point in a transcript where subsequent responses changed model. */
export function ModelChangeDivider({
  previousModel,
  model,
}: ModelChangeDividerProps) {
  return (
    <div
      class="model-change-divider"
      role="separator"
      aria-label={`Model changed from ${previousModel} to ${model}`}
    >
      <span class="model-change-divider-line" aria-hidden="true" />
      <span
        class="model-change-divider-badge"
        title={`${previousModel} → ${model}`}
      >
        <i class="codicon codicon-arrow-swap" aria-hidden="true" />
        <span>Model changed to</span>
        <span class="model-change-divider-model">{model}</span>
      </span>
      <span class="model-change-divider-line" aria-hidden="true" />
    </div>
  );
}
