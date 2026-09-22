export type {
  AgentBudget,
  BackgroundModelTier as ModelTier,
  BackgroundModelTierRequest as ModelTierRequest,
  BackgroundModelTierSource as ModelTierSource,
  ReviewScope,
  SpawnBackgroundRequest,
  SpawnBackgroundResult,
} from "../core/capabilities/background.js";

import type {
  AgentBudget,
  BackgroundModelTier as ModelTier,
  BackgroundModelTierSource as ModelTierSource,
} from "../core/capabilities/background.js";

export type ProviderStrategy = "same" | "opposite" | "specific";

export interface BackgroundRouteResolution {
  resolvedMode: string;
  resolvedModel: string;
  resolvedProvider: string;
  taskClass: string;
  /** Effective routing tier after caller and task-policy resolution. */
  modelTier?: ModelTier;
  /** Classified tier of the model that was actually selected. */
  resolvedModelTier?: ModelTier | "unknown";
  resolvedModelTierSource?: ModelTierSource;
  modelGroup?: string;
  routingReason: string;
  fallbackUsed: boolean;
  /** Override thinking budget for this task class (undefined = inherit foreground). */
  thinkingBudget?: number;
  /** Tool profile name restricting available tools (e.g. "review"). */
  toolProfile?: string;
  /** Automatic session budget used when the caller did not provide one. */
  defaultBudget?: AgentBudget;
}
