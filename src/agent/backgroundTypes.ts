export type {
  SpawnBackgroundRequest,
  SpawnBackgroundResult,
} from "../core/capabilities/background.js";

export type ProviderStrategy = "same" | "opposite" | "specific";
export type ModelTier = "cheap" | "balanced" | "deep_reasoning";

export interface BackgroundRouteResolution {
  resolvedMode: string;
  resolvedModel: string;
  resolvedProvider: string;
  taskClass: string;
  routingReason: string;
  fallbackUsed: boolean;
  /** Override thinking budget for this task class (undefined = inherit foreground). */
  thinkingBudget?: number;
  /** Tool profile name restricting available tools (e.g. "review"). */
  toolProfile?: string;
}
