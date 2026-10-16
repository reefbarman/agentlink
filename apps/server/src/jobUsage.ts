import type { JobRun } from "./jobStore.js";

/**
 * The usage guard for recurring jobs: notice-only, never stopping a run.
 * A finished run that used more than three times the job's usual tokens
 * (the median of its recent runs that used the model, with at least three
 * of them to go on) is worth telling the owner about.
 */

export const UNUSUAL_USAGE_FACTOR = 3;
const MIN_HISTORY = 3;
const HISTORY = 10;

export function runTokens(run: JobRun): number {
  return (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0);
}

/**
 * The job's usual tokens when `run` used more than three times that, or
 * undefined. `history` is the job's runs, newest first (it may include
 * `run` itself, which is skipped).
 */
export function unusualUsage(
  run: JobRun,
  history: readonly JobRun[],
): number | undefined {
  const tokens = runTokens(run);
  if (!run.usage || tokens === 0) return undefined;
  const earlier = history
    .filter(
      (other) =>
        other.runId !== run.runId &&
        other.usage !== undefined &&
        runTokens(other) > 0 &&
        (other.finishedAt ?? other.updatedAt) <=
          (run.finishedAt ?? run.updatedAt),
    )
    .slice(0, HISTORY)
    .map(runTokens)
    .sort((a, b) => a - b);
  if (earlier.length < MIN_HISTORY) return undefined;
  const middle = Math.floor(earlier.length / 2);
  const usual =
    earlier.length % 2 === 1
      ? earlier[middle]!
      : Math.round((earlier[middle - 1]! + earlier[middle]!) / 2);
  return tokens > usual * UNUSUAL_USAGE_FACTOR ? usual : undefined;
}
