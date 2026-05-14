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
  budgetBasis?: "input" | "total";
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
  budgetBasis = "total",
  estimatedTotalUsed = 0,
}: ContextBarProps) {
  // Use the higher of: last API total vs running estimate (which includes
  // tool results accumulated since the last API response).
  const totalUsed = Math.max(inputTokens + outputTokens, estimatedTotalUsed);
  const projectedInputUsed = Math.max(
    usedInputTokens ?? inputTokens,
    Math.max(0, estimatedTotalUsed - outputTokens),
  );
  const isInputBudget = budgetBasis === "input" && maxInputTokens != null;
  const budgetLimit = isInputBudget ? maxInputTokens : maxContextWindow;
  const used = isInputBudget ? projectedInputUsed : totalUsed;
  const reserved = isInputBudget
    ? 0
    : Math.min(outputReservation, Math.max(0, maxContextWindow - used));
  const available = Math.max(0, budgetLimit - used - reserved);

  const usedPct = budgetLimit > 0 ? (used / budgetLimit) * 100 : 0;
  const reservedPct = budgetLimit > 0 ? (reserved / budgetLimit) * 100 : 0;
  const thresholdPct =
    softThresholdBudget != null
      ? (softThresholdBudget / budgetLimit) * 100
      : condenseThreshold != null
        ? condenseThreshold * 100
        : null;
  const hardBudgetPct =
    hardBudget != null && budgetLimit > 0
      ? (hardBudget / budgetLimit) * 100
      : null;

  const tooltipParts = isInputBudget
    ? [
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
      ]
    : [
        `Used: ${used.toLocaleString()} (input ${inputTokens.toLocaleString()} + output ${outputTokens.toLocaleString()})`,
        `Reserved for response: ${reserved.toLocaleString()}`,
        ...(safetyBufferTokens > 0
          ? [`Safety buffer: ${safetyBufferTokens.toLocaleString()}`]
          : []),
        `Available before response reserve: ${Math.max(0, maxContextWindow - used).toLocaleString()}`,
        `Available after reserve: ${available.toLocaleString()}`,
        ...(cacheReadTokens > 0
          ? [`Cached (0.1x): ${cacheReadTokens.toLocaleString()} tokens`]
          : []),
        ...(thresholdPct != null
          ? [`Auto-condense target: ${Math.round(thresholdPct)}%`]
          : []),
        ...(hardBudgetPct != null
          ? [`Hard fit limit: ${Math.round(hardBudgetPct)}%`]
          : []),
      ];

  return (
    <div class="context-bar" title={tooltipParts.join("\n")}>
      <div class="context-bar-track">
        <div class="context-bar-used" style={{ width: `${usedPct}%` }} />
        <div
          class="context-bar-reserved"
          style={{ width: `${reservedPct}%` }}
        />
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
        {formatTokens(used)} / {formatTokens(budgetLimit)}
        {isInputBudget ? " input" : ""} ({Math.round(usedPct)}%)
      </span>
    </div>
  );
}
