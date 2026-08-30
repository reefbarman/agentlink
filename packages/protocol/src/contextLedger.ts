export const DEFAULT_CONTEXT_SAFETY_BUFFER_RATIO = 0.05;
export const ORDINARY_TURN_RETRIEVED_MEMORY_TOKEN_BUDGET = 1_500;

export type ContextLedgerLayer =
  | "system_prompt"
  | "workspace_instructions"
  | "mode_instructions"
  | "pinned_memory"
  | "tool_definitions"
  | "retrieved_context"
  | "conversation_history"
  | "working_set";

export interface ContextLedgerLayerRequest {
  layer: ContextLedgerLayer;
  requestedTokens: number;
  /** Required layers are measured but never silently reduced by the allocator. */
  required?: boolean;
  /** Hard ceiling for safely reducible, request-local context. */
  budgetTokens?: number;
  /** Omit structured context whole when it cannot fit without truncation. */
  allOrNothing?: boolean;
}

export interface ContextLedgerLayerAllocation {
  layer: ContextLedgerLayer;
  requestedTokens: number;
  budgetTokens: number;
  allocatedTokens: number;
  omittedTokens: number;
  required: boolean;
}

export interface ContextLedgerSnapshot {
  contextWindowTokens: number;
  maxInputTokens: number;
  outputReservationTokens: number;
  safetyBufferTokens: number;
  hardInputLimitTokens: number;
  requestedInputTokens: number;
  allocatedInputTokens: number;
  remainingInputTokens: number;
  overflowTokens: number;
  layers: readonly ContextLedgerLayerAllocation[];
}

export interface ContextLedgerModelCapabilities {
  contextWindow: number;
  maxInputTokens?: number;
  maxOutputTokens: number;
}

export interface BuildContextLedgerRequest {
  capabilities: ContextLedgerModelCapabilities;
  outputReservationTokens?: number;
  safetyBufferRatio?: number;
  layers: readonly ContextLedgerLayerRequest[];
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * Build one immutable request-time context ledger.
 *
 * Required layers preserve exact request semantics even when they overflow the
 * model envelope. Bounded layers are reduced in caller-provided priority order,
 * first by their own hard cap and then by remaining request capacity.
 */
export function buildContextLedger(
  request: BuildContextLedgerRequest,
): Readonly<ContextLedgerSnapshot> {
  const contextWindowTokens = nonNegativeInteger(
    request.capabilities.contextWindow,
  );
  const outputReservationTokens = nonNegativeInteger(
    request.outputReservationTokens ?? request.capabilities.maxOutputTokens,
  );
  const maxInputTokens = nonNegativeInteger(
    request.capabilities.maxInputTokens ??
      contextWindowTokens - outputReservationTokens,
  );
  const safetyBufferRatio = Math.min(
    0.25,
    Math.max(
      0,
      Number.isFinite(request.safetyBufferRatio)
        ? request.safetyBufferRatio!
        : DEFAULT_CONTEXT_SAFETY_BUFFER_RATIO,
    ),
  );
  const safetyBufferTokens = Math.floor(maxInputTokens * safetyBufferRatio);
  const hardInputLimitTokens = Math.max(0, maxInputTokens - safetyBufferTokens);

  const requiredLayers = request.layers.filter(
    (layer) => layer.required !== false,
  );
  const boundedLayers = request.layers.filter(
    (layer) => layer.required === false,
  );
  const allocations: ContextLedgerLayerAllocation[] = [];
  let allocatedInputTokens = 0;
  let requestedInputTokens = 0;

  for (const layer of requiredLayers) {
    const requestedTokens = nonNegativeInteger(layer.requestedTokens);
    requestedInputTokens += requestedTokens;
    allocatedInputTokens += requestedTokens;
    allocations.push({
      layer: layer.layer,
      requestedTokens,
      budgetTokens: requestedTokens,
      allocatedTokens: requestedTokens,
      omittedTokens: 0,
      required: true,
    });
  }

  let remainingInputTokens = Math.max(
    0,
    hardInputLimitTokens - allocatedInputTokens,
  );
  for (const layer of boundedLayers) {
    const requestedTokens = nonNegativeInteger(layer.requestedTokens);
    const budgetTokens = nonNegativeInteger(
      layer.budgetTokens ?? requestedTokens,
    );
    const boundedTokens = Math.min(requestedTokens, budgetTokens);
    const allocatedTokens =
      layer.allOrNothing &&
      (boundedTokens < requestedTokens || boundedTokens > remainingInputTokens)
        ? 0
        : Math.min(boundedTokens, remainingInputTokens);
    requestedInputTokens += requestedTokens;
    allocatedInputTokens += allocatedTokens;
    remainingInputTokens -= allocatedTokens;
    allocations.push({
      layer: layer.layer,
      requestedTokens,
      budgetTokens,
      allocatedTokens,
      omittedTokens: requestedTokens - allocatedTokens,
      required: false,
    });
  }

  const overflowTokens = Math.max(
    0,
    allocatedInputTokens - hardInputLimitTokens,
  );
  remainingInputTokens = Math.max(
    0,
    hardInputLimitTokens - allocatedInputTokens,
  );

  return Object.freeze({
    contextWindowTokens,
    maxInputTokens,
    outputReservationTokens,
    safetyBufferTokens,
    hardInputLimitTokens,
    requestedInputTokens,
    allocatedInputTokens,
    remainingInputTokens,
    overflowTokens,
    layers: Object.freeze(
      allocations.map((allocation) => Object.freeze(allocation)),
    ),
  });
}

export function getContextLedgerLayer(
  ledger: Readonly<ContextLedgerSnapshot>,
  layer: ContextLedgerLayer,
): Readonly<ContextLedgerLayerAllocation> | undefined {
  return ledger.layers.find((allocation) => allocation.layer === layer);
}
