const DEFAULT_OUTPUT_RESERVATION = 8192;

interface ContextBarProps {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  maxContextWindow: number;
  outputReservation?: number;
  condenseThreshold?: number;
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
  outputReservation = DEFAULT_OUTPUT_RESERVATION,
  condenseThreshold,
}: ContextBarProps) {
  const used = inputTokens + outputTokens;
  const reserved = Math.min(outputReservation, maxContextWindow - used);
  const available = Math.max(0, maxContextWindow - used - reserved);

  const usedPct = maxContextWindow > 0 ? (used / maxContextWindow) * 100 : 0;
  const reservedPct =
    maxContextWindow > 0 ? (reserved / maxContextWindow) * 100 : 0;
  const thresholdPct =
    condenseThreshold != null ? condenseThreshold * 100 : null;

  const tooltipParts = [
    `Used: ${used.toLocaleString()} (input ${inputTokens.toLocaleString()} + output ${outputTokens.toLocaleString()})`,
    `Reserved for response: ${reserved.toLocaleString()}`,
    `Available: ${available.toLocaleString()}`,
    ...(cacheReadTokens > 0
      ? [`Cached (0.1x): ${cacheReadTokens.toLocaleString()} tokens`]
      : []),
    ...(condenseThreshold != null
      ? [`Auto-condense at: ${Math.round(condenseThreshold * 100)}%`]
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
            title={`Auto-condense threshold: ${Math.round(thresholdPct)}%`}
          />
        )}
      </div>
      <span class="context-bar-label">
        {formatTokens(used)} / {formatTokens(maxContextWindow)}
      </span>
    </div>
  );
}
