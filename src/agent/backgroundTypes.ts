export type {
  AgentBudget,
  ReviewScope,
  SpawnBackgroundRequest,
  SpawnBackgroundResult,
} from "../core/capabilities/background.js";

import type { AgentBudget } from "../core/capabilities/background.js";

export type ProviderStrategy = "same" | "opposite" | "specific";
export type ModelTier = "cheap" | "balanced" | "deep_reasoning";

export interface BackgroundRouteResolution {
  resolvedMode: string;
  resolvedModel: string;
  resolvedProvider: string;
  taskClass: string;
  /** Effective routing tier after caller and task-policy resolution. */
  modelTier?: ModelTier;
  routingReason: string;
  fallbackUsed: boolean;
  /** Override thinking budget for this task class (undefined = inherit foreground). */
  thinkingBudget?: number;
  /** Tool profile name restricting available tools (e.g. "review"). */
  toolProfile?: string;
  /** Automatic session budget used when the caller did not provide one. */
  defaultBudget?: AgentBudget;
}
