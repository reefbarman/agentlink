export type CoreReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface CoreModelCatalogEntry {
  id: string;
  displayName: string;
  providerId: string;
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
