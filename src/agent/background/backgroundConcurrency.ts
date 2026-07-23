export const DEFAULT_BACKGROUND_MAX_CONCURRENT = 8;
export const DEFAULT_BACKGROUND_MAX_CHILDREN_PER_PARENT = 8;
export const MAX_BACKGROUND_MAX_CONCURRENT = 16;

export function normalizeBackgroundMaxConcurrent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_BACKGROUND_MAX_CONCURRENT;
  }
  return Math.min(
    MAX_BACKGROUND_MAX_CONCURRENT,
    Math.max(1, Math.floor(value)),
  );
}
