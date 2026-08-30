import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ORDINARY_TURN_RETRIEVED_MEMORY_TOKEN_BUDGET,
  buildContextLedger,
  getContextLedgerLayer,
  type BuildContextLedgerRequest,
  type ContextLedgerLayer,
  type ContextLedgerModelCapabilities,
  type ContextLedgerSnapshot,
} from "./contextLedger.js";

const capabilities: ContextLedgerModelCapabilities = {
  contextWindow: 100_000,
  maxInputTokens: 80_000,
  maxOutputTokens: 20_000,
};

describe("context ledger protocol", () => {
  it("keeps model input, layer, request, and snapshot contracts stable", () => {
    expectTypeOf<ContextLedgerModelCapabilities>().toEqualTypeOf<{
      contextWindow: number;
      maxInputTokens?: number;
      maxOutputTokens: number;
    }>();
    expectTypeOf<ContextLedgerLayer>().toEqualTypeOf<
      | "system_prompt"
      | "workspace_instructions"
      | "mode_instructions"
      | "pinned_memory"
      | "tool_definitions"
      | "retrieved_context"
      | "conversation_history"
      | "working_set"
    >();
    expectTypeOf<BuildContextLedgerRequest["layers"]>().toEqualTypeOf<
      readonly import("./contextLedger.js").ContextLedgerLayerRequest[]
    >();
    expectTypeOf<ContextLedgerSnapshot>().toHaveProperty("layers");
  });

  it("uses the provider input ceiling without double-subtracting output reserve", () => {
    const ledger = buildContextLedger({
      capabilities,
      outputReservationTokens: 12_000,
      layers: [{ layer: "system_prompt", requestedTokens: 10_000 }],
    });

    expect(ledger).toMatchObject({
      contextWindowTokens: 100_000,
      maxInputTokens: 80_000,
      outputReservationTokens: 12_000,
      safetyBufferTokens: 4_000,
      hardInputLimitTokens: 76_000,
      allocatedInputTokens: 10_000,
      remainingInputTokens: 66_000,
      overflowTokens: 0,
    });
  });

  it("derives the input ceiling from the fixed context envelope", () => {
    const ledger = buildContextLedger({
      capabilities: {
        contextWindow: 32_000,
        maxOutputTokens: 8_000,
      },
      layers: [],
    });

    expect(ledger.maxInputTokens).toBe(24_000);
    expect(ledger.outputReservationTokens).toBe(8_000);
    expect(ledger.hardInputLimitTokens).toBe(22_800);
  });

  it("reports required-layer overflow instead of silently dropping context", () => {
    const ledger = buildContextLedger({
      capabilities,
      layers: [
        { layer: "system_prompt", requestedTokens: 20_000 },
        { layer: "tool_definitions", requestedTokens: 30_000 },
        { layer: "conversation_history", requestedTokens: 30_000 },
      ],
    });

    expect(ledger.allocatedInputTokens).toBe(80_000);
    expect(ledger.hardInputLimitTokens).toBe(76_000);
    expect(ledger.overflowTokens).toBe(4_000);
    expect(ledger.remainingInputTokens).toBe(0);
    expect(ledger.layers.every((layer) => layer.omittedTokens === 0)).toBe(
      true,
    );
  });

  it("allocates bounded layers by declared priority and hard cap", () => {
    const ledger = buildContextLedger({
      capabilities: {
        contextWindow: 20_000,
        maxInputTokens: 10_000,
        maxOutputTokens: 4_000,
      },
      safetyBufferRatio: 0,
      layers: [
        { layer: "system_prompt", requestedTokens: 7_500 },
        {
          layer: "retrieved_context",
          requestedTokens: 3_000,
          budgetTokens: ORDINARY_TURN_RETRIEVED_MEMORY_TOKEN_BUDGET,
          required: false,
        },
        {
          layer: "working_set",
          requestedTokens: 2_000,
          required: false,
        },
      ],
    });

    expect(getContextLedgerLayer(ledger, "retrieved_context")).toMatchObject({
      requestedTokens: 3_000,
      budgetTokens: 1_500,
      allocatedTokens: 1_500,
      omittedTokens: 1_500,
      required: false,
    });
    expect(getContextLedgerLayer(ledger, "working_set")).toMatchObject({
      requestedTokens: 2_000,
      allocatedTokens: 1_000,
      omittedTokens: 1_000,
    });
    expect(ledger).toMatchObject({
      requestedInputTokens: 12_500,
      allocatedInputTokens: 10_000,
      remainingInputTokens: 0,
      overflowTokens: 0,
    });
  });

  it("omits all-or-nothing structured context instead of truncating it", () => {
    const ledger = buildContextLedger({
      capabilities,
      layers: [
        { layer: "system_prompt", requestedTokens: 10_000 },
        {
          layer: "retrieved_context",
          requestedTokens: 1_501,
          budgetTokens: ORDINARY_TURN_RETRIEVED_MEMORY_TOKEN_BUDGET,
          required: false,
          allOrNothing: true,
        },
      ],
    });

    expect(getContextLedgerLayer(ledger, "retrieved_context")).toMatchObject({
      requestedTokens: 1_501,
      budgetTokens: 1_500,
      allocatedTokens: 0,
      omittedTokens: 1_501,
    });
  });

  it("normalizes invalid numeric inputs and returns an immutable snapshot", () => {
    const ledger = buildContextLedger({
      capabilities: {
        contextWindow: Number.POSITIVE_INFINITY,
        maxInputTokens: -1,
        maxOutputTokens: Number.NaN,
      },
      safetyBufferRatio: Number.POSITIVE_INFINITY,
      layers: [{ layer: "system_prompt", requestedTokens: Number.NaN }],
    });

    expect(ledger).toMatchObject({
      contextWindowTokens: 0,
      maxInputTokens: 0,
      outputReservationTokens: 0,
      allocatedInputTokens: 0,
    });
    expect(Object.isFrozen(ledger)).toBe(true);
    expect(Object.isFrozen(ledger.layers)).toBe(true);
    expect(Object.isFrozen(ledger.layers[0])).toBe(true);
  });
});
