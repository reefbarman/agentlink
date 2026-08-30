import type {
  PromptProfile,
  PromptProfileResolutionSource,
} from "./promptProfile.js";

import type { ContextLedgerSnapshot } from "./contextLedger.js";

export interface ContextBreakdownItem {
  label: string;
  chars: number;
  estimatedTokens: number;
  count?: number;
}

/** Privacy-safe size attribution for one tool result retained in model history. */
export interface ToolResultContextAttribution {
  toolCallId: string;
  toolName: string;
  /** Unicode code points in the canonical retained representation. */
  chars: number;
  /** Exact UTF-8 bytes in the canonical retained representation. */
  bytes: number;
  /** Provider-oriented estimate; media blocks use fixed token pressure, not base64 size. */
  estimatedTokens: number;
}

export interface McpServerToolBreakdown {
  serverName: string;
  chars: number;
  estimatedTokens: number;
  toolCount: number;
}

export interface ToolContextBreakdown {
  totalToolCount: number;
  totalChars: number;
  estimatedTokens: number;
  native: ContextBreakdownItem;
  mcp: {
    totalServerCount: number;
    totalToolCount: number;
    totalChars: number;
    estimatedTokens: number;
    servers: McpServerToolBreakdown[];
  };
}

export interface SkillCatalogContextBreakdown {
  revision: string;
  budgetChars: number;
  renderedChars: number;
  sourceChars: number;
  deferredChars: number;
  discoveredCount: number;
  enabledCount: number;
  advertisedCount: number;
  truncatedCount: number;
  omittedCount: number;
  retrievalFallbackRequired: boolean;
}

export interface RequestContextBreakdown {
  prompt: {
    sections: ContextBreakdownItem[];
    totalChars: number;
    estimatedTokens: number;
    profile?: PromptProfile;
    profileSource?: PromptProfileResolutionSource;
    profilePolicyRevision?: string;
    skillCatalog?: SkillCatalogContextBreakdown;
  };
  tools?: ToolContextBreakdown;
  contextLedger?: ContextLedgerSnapshot;
}

/** Provider-comparable projected input plus separate capacity reservations after condense. */
export interface PostCondenseProjection {
  estimatedInputTokens: number;
  promptTokens: number;
  historyTokens: number;
  modeInstructionTokens: number;
  toolTokens: number;
  nativeToolTokens: number;
  mcpToolTokens: number;
  pinnedMemoryTokens: number;
  retrievedMemoryTokens: number;
  outputReservationTokens: number;
  safetyBufferTokens: number;
  contextLedger: ContextLedgerSnapshot;
}

export interface CondenseForensicMetadata {
  inputMessageCount: number;
  sourceUserMessageCount: number;
  hadPriorSummaryInInput: boolean;
  sourceHash: string;
  providerId: string;
  condenseModel: string;
  modelCandidates: string[];
  skippedModelCandidates?: Array<{
    model: string;
    reason: string;
  }>;
  selectedModel: string;
  latestUserMessage: string;
  currentTask: string;
  pendingTasks: string[];
  canonicalUserMessages: string[];
  requestMessageCount: number;
  effectiveHistoryMessageCount: number;
  effectiveHistoryRoles: string[];
}

export type CondenseMetadata =
  | (CondenseForensicMetadata & {
      postCondenseProjection?: PostCondenseProjection;
    })
  | { postCondenseProjection: PostCondenseProjection };
