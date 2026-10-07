/**
 * AgentLink TUI palette, mirrored from the desktop app. Colours are hex; Ink's
 * chalk downsamples them to 256/16 colours (or strips them for NO_COLOR), so
 * no terminal capability detection is needed here.
 */
export const tuiTheme = {
  accent: "#4EC9B0",
  accentSoft: "#91EDDA",
  blue: "#71BAFF",
  violet: "#B59AFF",
  text: "#EDF6F4",
  muted: "#A2B8B7",
  faint: "#6B8381",
  border: "#2D4145",
  surface: "#223033",
  warn: "#E5C07B",
} as const;

/** Brand gradient used for the wordmark and composer strip (desktop Quick Ask glow). */
export const BRAND_GRADIENT = [
  tuiTheme.accent,
  tuiTheme.blue,
  tuiTheme.violet,
] as const;

export function gradientColor(
  stops: readonly string[],
  position: number,
): string {
  if (stops.length === 0) return tuiTheme.accent;
  if (stops.length === 1) return stops[0]!;
  const clamped = Math.min(1, Math.max(0, position));
  const scaled = clamped * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  return mixHex(stops[index]!, stops[index + 1]!, scaled - index);
}

/** One colour per cell across `count` cells, from the first to the last stop. */
export function gradientColors(
  count: number,
  stops: readonly string[] = BRAND_GRADIENT,
): string[] {
  if (count <= 0) return [];
  if (count === 1) return [gradientColor(stops, 0)];
  return Array.from({ length: count }, (_, index) =>
    gradientColor(stops, index / (count - 1)),
  );
}

function mixHex(from: string, to: string, amount: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  const channel = (index: number) =>
    Math.round(a[index]! + (b[index]! - a[index]!) * amount)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`.toUpperCase();
}

function parseHex(value: string): readonly [number, number, number] {
  const hex = value.replace(/^#/u, "");
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
