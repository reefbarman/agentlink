import type { WebviewModelInfo } from "../types";
import { ContextBar } from "./ContextBar";

export function ContextUsageRow({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  estimatedTotalUsed,
  models,
  modelId,
  contextBudget,
  condenseThreshold,
  defaultMaxTokens,
  className,
}: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  estimatedTotalUsed: number;
  models: WebviewModelInfo[];
  modelId: string;
  contextBudget?: {
    maxInputTokens?: number;
    usedInputTokens?: number;
    outputReservation?: number;
    safetyBufferTokens?: number;
    softThresholdBudget?: number;
    hardBudget?: number;
  };
  condenseThreshold?: number;
  defaultMaxTokens: number;
  className?: string;
}) {
  if (inputTokens <= 0 && outputTokens <= 0 && estimatedTotalUsed <= 0) {
    return null;
  }

  const currentModel = models.find((model) => model.id === modelId);
  const bar = (
    <ContextBar
      inputTokens={inputTokens}
      outputTokens={outputTokens}
      cacheReadTokens={cacheReadTokens}
      maxContextWindow={currentModel?.contextWindow ?? defaultMaxTokens}
      maxInputTokens={
        contextBudget?.maxInputTokens ?? currentModel?.maxInputTokens
      }
      usedInputTokens={contextBudget?.usedInputTokens}
      outputReservation={contextBudget?.outputReservation}
      safetyBufferTokens={contextBudget?.safetyBufferTokens}
      softThresholdBudget={contextBudget?.softThresholdBudget}
      hardBudget={contextBudget?.hardBudget}
      condenseThreshold={condenseThreshold}
      estimatedTotalUsed={estimatedTotalUsed}
    />
  );

  return className ? <div class={className}>{bar}</div> : bar;
}
