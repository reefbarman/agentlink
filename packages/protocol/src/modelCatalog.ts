export const CORE_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type CoreReasoningEffort = (typeof CORE_REASONING_EFFORTS)[number];

export function isCoreReasoningEffort(
  value: unknown,
): value is CoreReasoningEffort {
  return (
    typeof value === "string" &&
    (CORE_REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

export interface CoreModelCatalogEntry {
  id: string;
  displayName: string;
  providerId: string;
  providerDisplayName?: string;
  supportsToolUse?: boolean;
  supportsImages?: boolean;
  contextWindow: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  reasoningEfforts?: CoreReasoningEffort[];
  defaultReasoningEffort?: CoreReasoningEffort;
  authenticated: boolean;
  condenseThreshold?: number;
}

export interface CoreModelCatalogSnapshot {
  models: CoreModelCatalogEntry[];
  publishedByOwnerId: string;
  publishedAt: number;
}
