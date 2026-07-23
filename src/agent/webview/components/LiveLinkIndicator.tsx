import type { ActivityMotion } from "./activityPresentation";

interface LiveLinkIndicatorProps {
  motion: ActivityMotion;
  className?: string;
  /** Supply a label only when no adjacent visible status text names the state. */
  label?: string;
}

/** AgentLink's interlocking mark, animated as a compact activity indicator. */
export function LiveLinkIndicator({
  motion,
  className,
  label,
}: LiveLinkIndicatorProps) {
  return (
    <span
      class={`live-link-indicator live-link-${motion}${className ? ` ${className}` : ""}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
        <path
          class="live-link-segment live-link-segment-first"
          d="M4.5 3C2.567 3 1 4.567 1 6.5S2.567 10 4.5 10H6V8.5H4.5C3.395 8.5 2.5 7.605 2.5 6.5S3.395 4.5 4.5 4.5H7C8.105 4.5 9 5.395 9 6.5c0 .538-.213 1.026-.559 1.384l1.072 1.057C10.146 8.29 10.5 7.44 10.5 6.5 10.5 4.567 8.933 3 7 3H4.5z"
        />
        <path
          class="live-link-segment live-link-segment-second"
          d="M11.5 13c1.933 0 3.5-1.567 3.5-3.5S13.433 6 11.5 6H10v1.5h1.5c1.105 0 2 .895 2 2s-.895 2-2 2H9c-1.105 0-2-.895-2-2 0-.538.213-1.026.559-1.384L6.487 7.059C5.854 7.71 5.5 8.56 5.5 9.5 5.5 11.433 7.067 13 9 13h2.5z"
        />
      </svg>
    </span>
  );
}
