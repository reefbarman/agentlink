import type {
  CoreModelCatalogAuthAction,
  CoreModelCatalogReadiness,
} from "./modelCatalog.js";

/** Minimal model metadata needed to decide whether chat can be used. */
export interface ModelSetupModel {
  id: string;
  displayName: string;
  provider: string;
  providerDisplayName?: string;
  authenticated: boolean;
  readiness?: CoreModelCatalogReadiness;
  authAction?: CoreModelCatalogAuthAction;
  unavailableReason?: string;
}

export type ModelSetupState =
  | { kind: "checking"; selectedModelId: string }
  | { kind: "ready"; model: ModelSetupModel }
  | { kind: "credentials_required"; model: ModelSetupModel }
  | { kind: "configuration_required"; model: ModelSetupModel }
  | { kind: "model_unavailable"; selectedModelId: string; reason?: string };

/**
 * Derive setup state from the currently selected model and the extension-owned
 * model catalog. `authenticated` means credentials are configured, not that a
 * provider request has been verified.
 */
export function deriveModelSetupState(
  selectedModelId: string | undefined,
  models: readonly ModelSetupModel[],
): ModelSetupState {
  const normalizedSelectedModelId = selectedModelId?.trim() ?? "";
  if (!normalizedSelectedModelId || models.length === 0) {
    return { kind: "checking", selectedModelId: normalizedSelectedModelId };
  }

  const model = models.find(
    (candidate) => candidate.id === normalizedSelectedModelId,
  );
  if (!model) {
    return {
      kind: "model_unavailable",
      selectedModelId: normalizedSelectedModelId,
    };
  }

  const readiness =
    model.readiness ??
    (model.authenticated
      ? { status: "ready" as const }
      : { status: "credentials_required" as const });
  switch (readiness.status) {
    case "ready":
      return { kind: "ready", model };
    case "checking":
      return { kind: "checking", selectedModelId: normalizedSelectedModelId };
    case "credentials_required":
      return { kind: "credentials_required", model };
    case "configuration_required":
      return { kind: "configuration_required", model };
    case "unavailable":
      return {
        kind: "model_unavailable",
        selectedModelId: normalizedSelectedModelId,
        reason: readiness.reason ?? model.unavailableReason,
      };
  }
}
