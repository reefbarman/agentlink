export const CORE_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
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

/**
 * Clamp a desired non-disabled effort to the nearest lower supported level.
 * `none` remains an explicit opt-out rather than an automatic clamp target; when
 * no lower active level exists, prefer the model default.
 */
export function resolveSupportedReasoningEffort(
  requested: CoreReasoningEffort,
  supported: readonly CoreReasoningEffort[] | undefined,
  defaultEffort: CoreReasoningEffort,
): CoreReasoningEffort {
  if (!supported?.length || supported.includes(requested)) return requested;
  const requestedIndex = CORE_REASONING_EFFORTS.indexOf(requested);
  for (let index = requestedIndex - 1; index > 0; index -= 1) {
    const candidate = CORE_REASONING_EFFORTS[index];
    if (candidate && supported.includes(candidate)) return candidate;
  }
  if (supported.includes(defaultEffort)) return defaultEffort;
  return (
    supported.find((effort) => effort !== "none") ?? supported[0] ?? "none"
  );
}

export type CoreModelCatalogAuthActionKind =
  | "oauth"
  | "api_key"
  | "configure_provider";

/** A host-owned setup action that can truthfully change model readiness. */
export interface CoreModelCatalogAuthAction {
  kind: CoreModelCatalogAuthActionKind;
  providerId: string;
}

/** Settled, principal-scoped model readiness published with a catalog entry. */
export type CoreModelCatalogReadiness =
  | { status: "ready" }
  | { status: "checking" }
  | {
      status: "credentials_required";
      action?: CoreModelCatalogAuthAction;
      reason?: string;
    }
  | {
      status: "configuration_required";
      action: CoreModelCatalogAuthAction & { kind: "configure_provider" };
      reason?: string;
    }
  | { status: "unavailable"; reason?: string };

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
  /** Compatibility field; readiness is the source of truth for new consumers. */
  authenticated: boolean;
  readiness?: CoreModelCatalogReadiness;
  condenseThreshold?: number;
}

/** Resolve richer readiness while preserving catalogs from older hosts. */
export function resolveCoreModelCatalogReadiness(
  model: Pick<CoreModelCatalogEntry, "authenticated" | "readiness">,
): CoreModelCatalogReadiness {
  return (
    model.readiness ??
    (model.authenticated
      ? { status: "ready" }
      : { status: "credentials_required" })
  );
}

export interface CoreModelCatalogSnapshot {
  models: CoreModelCatalogEntry[];
  publishedByOwnerId: string;
  publishedAt: number;
}
