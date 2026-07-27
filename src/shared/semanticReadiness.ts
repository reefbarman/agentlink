export type SemanticReadinessReason =
  | "missing_embeddings_auth"
  | "missing_index"
  | "store_unavailable"
  | "no_workspace"
  | "disabled"
  | "generic_error";

export interface SemanticReadinessSnapshot {
  semanticEnabled: boolean;
  hasWorkspace: boolean;
  retrievalStoreAvailable?: boolean;
  hasIndex?: boolean;
}

export function classifySemanticReadiness(
  snapshot: SemanticReadinessSnapshot,
): SemanticReadinessReason | "ready" {
  if (!snapshot.semanticEnabled) return "disabled";
  if (!snapshot.hasWorkspace) return "no_workspace";
  if (snapshot.retrievalStoreAvailable === false) return "store_unavailable";
  if (snapshot.hasIndex === false) return "missing_index";
  return "ready";
}

export function getSemanticReadinessMessage(
  reason: SemanticReadinessReason,
): string {
  switch (reason) {
    case "disabled":
      return "Semantic search is not enabled. Set agentlink.semanticSearchEnabled to true.";
    case "missing_embeddings_auth":
      return "OpenAI embedding auth is not configured. Lexical indexing and search remain available; set OPENAI_API_KEY or run 'AgentLink: Set OpenAI API Key for Embeddings' to add vector and hybrid ranking.";
    case "no_workspace":
      return "No workspace folder open.";
    case "store_unavailable":
      return "The retrieval store is unavailable.";
    case "missing_index":
      return "No codebase index found for this workspace. Run 'AgentLink: Rebuild Codebase Index' or click 'Index Codebase' in the AgentLink sidebar.";
    case "generic_error":
      return "Semantic search is not ready.";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}
