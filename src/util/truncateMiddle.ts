import { estimateTokensFromChars } from "./tokenEstimation.js";

export interface TruncateMiddleOptions {
  lineBoundarySnapRatio?: number;
  omissionSuffix?: string;
}

function headSlice(text: string, maxChars: number, snapRatio: number): string {
  const raw = text.slice(0, maxChars);
  if (snapRatio <= 0) return raw;
  const newlineIdx = raw.lastIndexOf("\n");
  if (newlineIdx > 0 && maxChars - newlineIdx <= maxChars * snapRatio) {
    return raw.slice(0, newlineIdx + 1);
  }
  return raw;
}

function tailSlice(text: string, maxChars: number, snapRatio: number): string {
  const raw = text.slice(text.length - maxChars);
  if (snapRatio <= 0) return raw;
  const newlineIdx = raw.indexOf("\n");
  if (newlineIdx >= 0 && newlineIdx <= maxChars * snapRatio) {
    return raw.slice(newlineIdx + 1);
  }
  return raw;
}

/**
 * Retains up to `maxChars` UTF-16 code units from the start and end of `text`.
 * The omission notice is additional and is not included in `maxChars`.
 */
export function truncateMiddle(
  text: string,
  maxChars: number,
  options: TruncateMiddleOptions = {},
): string {
  if (text.length <= maxChars) return text;

  const headChars = Math.floor(maxChars * 0.5);
  const snapRatio = options.lineBoundarySnapRatio ?? 0;
  const head = headSlice(text, headChars, snapRatio);
  const tail = tailSlice(text, maxChars - headChars, snapRatio);
  const omittedChars = text.length - head.length - tail.length;
  const omittedTokens = estimateTokensFromChars(omittedChars);
  const notice = `\n\n[... ~${omittedTokens.toLocaleString()} tokens (~${omittedChars.toLocaleString()} chars) omitted from middle ...]${options.omissionSuffix ?? ""}`;

  return `${head}${notice}\n\n${tail}`;
}
