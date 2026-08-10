/** Minimal model metadata needed to decide whether chat can be used. */
export interface ModelSetupModel {
  id: string;
  displayName: string;
  provider: string;
  providerDisplayName?: string;
  authenticated: boolean;
}

export type ModelSetupState =
  | { kind: "checking"; selectedModelId: string }
  | { kind: "ready"; model: ModelSetupModel }
  | { kind: "credentials_required"; model: ModelSetupModel }
  | { kind: "model_unavailable"; selectedModelId: string };

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

  return model.authenticated
    ? { kind: "ready", model }
    : { kind: "credentials_required", model };
}
