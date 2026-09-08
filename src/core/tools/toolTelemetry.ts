/** One logical native request that reached provider dispatch, observed once at termination. */
export interface ToolRequestObservation {
  readonly inlineToolNames: readonly string[];
  readonly deferredToolNames: readonly string[];
  readonly eligibleToolNames: readonly string[];
  /** Canonical names used at top level; Compose children must not be included. */
  readonly usedToolNames: readonly string[];
  readonly mode: string;
  readonly profile: string;
  readonly background: boolean;
  /** False includes failed/cancelled requests and never contributes to adoption rates. */
  readonly completed: boolean;
  /** Transport attempts, not additional logical selection opportunities. */
  readonly providerAttempts: number;
}

export interface ToolInvocationDimensions {
  route: "direct" | "native_bridge" | "mcp_bridge" | "unresolved";
  nesting: "top_level" | "compose_child";
  profile: string;
  background: boolean;
}
