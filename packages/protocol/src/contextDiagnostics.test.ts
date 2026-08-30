import type {
  CondenseForensicMetadata,
  CondenseMetadata,
  ContextBreakdownItem,
  McpServerToolBreakdown,
  PostCondenseProjection,
  RequestContextBreakdown,
  SkillCatalogContextBreakdown,
  ToolContextBreakdown,
  ToolResultContextAttribution,
} from "./contextDiagnostics.js";
import { describe, expect, expectTypeOf, it } from "vitest";

import { buildContextLedger } from "./contextLedger.js";

describe("context diagnostics protocol", () => {
  it("keeps prompt, tool, and retained-result attribution DTOs stable", () => {
    expectTypeOf<ContextBreakdownItem>().toEqualTypeOf<{
      label: string;
      chars: number;
      estimatedTokens: number;
      count?: number;
    }>();
    expectTypeOf<ToolResultContextAttribution>().toEqualTypeOf<{
      toolCallId: string;
      toolName: string;
      chars: number;
      bytes: number;
      estimatedTokens: number;
    }>();
    expectTypeOf<McpServerToolBreakdown>().toEqualTypeOf<{
      serverName: string;
      chars: number;
      estimatedTokens: number;
      toolCount: number;
    }>();
    expectTypeOf<
      ToolContextBreakdown["native"]
    >().toEqualTypeOf<ContextBreakdownItem>();
    expectTypeOf<ToolContextBreakdown["mcp"]["servers"]>().toEqualTypeOf<
      McpServerToolBreakdown[]
    >();
    expectTypeOf<SkillCatalogContextBreakdown>().toHaveProperty(
      "retrievalFallbackRequired",
    );
  });

  it("keeps request context linked only to protocol prompt and ledger evidence", () => {
    expectTypeOf<RequestContextBreakdown["prompt"]["profile"]>().toEqualTypeOf<
      import("./promptProfile.js").PromptProfile | undefined
    >();
    expectTypeOf<
      RequestContextBreakdown["prompt"]["profileSource"]
    >().toEqualTypeOf<
      import("./promptProfile.js").PromptProfileResolutionSource | undefined
    >();
    expectTypeOf<RequestContextBreakdown["contextLedger"]>().toEqualTypeOf<
      import("./contextLedger.js").ContextLedgerSnapshot | undefined
    >();
  });

  it("keeps post-condense and forensic metadata serializable", () => {
    const contextLedger = buildContextLedger({
      capabilities: {
        contextWindow: 100,
        maxInputTokens: 80,
        maxOutputTokens: 20,
      },
      safetyBufferRatio: 0,
      layers: [{ layer: "system_prompt", requestedTokens: 10 }],
    });
    const projection: PostCondenseProjection = {
      estimatedInputTokens: 10,
      promptTokens: 2,
      historyTokens: 3,
      modeInstructionTokens: 1,
      toolTokens: 1,
      nativeToolTokens: 1,
      mcpToolTokens: 0,
      pinnedMemoryTokens: 1,
      retrievedMemoryTokens: 1,
      outputReservationTokens: 20,
      safetyBufferTokens: 0,
      contextLedger,
    };
    const forensic: CondenseForensicMetadata = {
      inputMessageCount: 2,
      sourceUserMessageCount: 1,
      hadPriorSummaryInInput: false,
      sourceHash: "hash",
      providerId: "codex",
      condenseModel: "gpt-condense",
      modelCandidates: ["gpt-condense"],
      skippedModelCandidates: [{ model: "fallback", reason: "unavailable" }],
      selectedModel: "gpt-condense",
      latestUserMessage: "Continue",
      currentTask: "Extract protocol DTOs",
      pendingTasks: ["Verify"],
      canonicalUserMessages: ["Continue"],
      requestMessageCount: 2,
      effectiveHistoryMessageCount: 2,
      effectiveHistoryRoles: ["user", "assistant"],
    };
    const metadata: CondenseMetadata = {
      ...forensic,
      postCondenseProjection: projection,
    };

    expect(JSON.parse(JSON.stringify(metadata))).toEqual(metadata);
  });
});
