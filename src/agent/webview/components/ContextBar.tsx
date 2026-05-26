const DEFAULT_OUTPUT_RESERVATION = 128_000;

interface ContextBarProps {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  maxContextWindow: number;
  maxInputTokens?: number;
  usedInputTokens?: number;
  outputReservation?: number;
  safetyBufferTokens?: number;
  softThresholdBudget?: number;
  hardBudget?: number;
  condenseThreshold?: number;
  /** Running estimate of total context usage (from engine, includes tool results added between API calls). */
  estimatedTotalUsed?: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function ContextBar({
  inputTokens,
  outputTokens,
  cacheReadTokens = 0,
  maxContextWindow,
  maxInputTokens,
  usedInputTokens,
  outputReservation = DEFAULT_OUTPUT_RESERVATION,
  safetyBufferTokens = 0,
  softThresholdBudget,
  hardBudget,
  condenseThreshold,
  estimatedTotalUsed = 0,
}: ContextBarProps) {
  const derivedMaxInputTokens = Math.max(
    0,
    maxContextWindow - outputReservation,
  );
  const budgetLimit = maxInputTokens ?? derivedMaxInputTokens;
  const used = Math.max(
    usedInputTokens ?? inputTokens,
    Math.max(0, estimatedTotalUsed - outputTokens),
  );
  const available = Math.max(0, budgetLimit - used);

  const usedPct = budgetLimit > 0 ? (used / budgetLimit) * 100 : 0;
  const usedWidthPct = Math.min(100, Math.max(0, usedPct));
  const thresholdPct =
    budgetLimit > 0 && softThresholdBudget != null
      ? (softThresholdBudget / budgetLimit) * 100
      : condenseThreshold != null
        ? condenseThreshold * 100
        : null;
  const hardBudgetPct =
    hardBudget != null && budgetLimit > 0
      ? (hardBudget / budgetLimit) * 100
      : null;

  const tooltipParts = [
    `Input used: ${used.toLocaleString()} tokens`,
    `Input cap: ${budgetLimit.toLocaleString()} tokens`,
    `Total context envelope: ${maxContextWindow.toLocaleString()} tokens`,
    `Max/reserved output: ${outputReservation.toLocaleString()} tokens`,
    ...(safetyBufferTokens > 0
      ? [`Safety buffer: ${safetyBufferTokens.toLocaleString()}`]
      : []),
    `Available input before hard limit: ${available.toLocaleString()}`,
    ...(cacheReadTokens > 0
      ? [`Cached (0.1x): ${cacheReadTokens.toLocaleString()} tokens`]
      : []),
    ...(thresholdPct != null
      ? [`Auto-condense target: ${Math.round(thresholdPct)}%`]
      : []),
    ...(hardBudgetPct != null
      ? [`Hard input fit limit: ${Math.round(hardBudgetPct)}%`]
      : []),
  ];

  return (
    <div class="context-bar" title={tooltipParts.join("\n")}>
      <div class="context-bar-track">
        <div class="context-bar-used" style={{ width: `${usedWidthPct}%` }} />
        {thresholdPct != null && (
          <div
            class="context-bar-threshold"
            style={{ left: `${thresholdPct}%` }}
            title={
              hardBudgetPct != null
                ? `Auto-condense target: ${Math.round(thresholdPct)}% · Hard fit limit: ${Math.round(hardBudgetPct)}%`
                : `Auto-condense target: ${Math.round(thresholdPct)}%`
            }
          />
        )}
      </div>
      <span class="context-bar-label">
        {formatTokens(used)} / {formatTokens(budgetLimit)} input (
        {Math.round(usedPct)}%)
      </span>
    </div>
  );
}
