import type {
  BackgroundCompletionResult,
  InFlightAssistantBlock,
  RevertRecoveryNotice,
} from "./sessionHydration.js";
import { describe, expectTypeOf, it } from "vitest";

import type { BackgroundResultState } from "./backgroundResult.js";

describe("session hydration protocol", () => {
  it("keeps the in-flight assistant block union stable", () => {
    expectTypeOf<InFlightAssistantBlock>().toEqualTypeOf<
      | { type: "thinking"; id: string; text: string; complete: boolean }
      | { type: "text"; text: string }
      | {
          type: "tool_call";
          id: string;
          name: string;
          inputJson: string;
          complete: boolean;
        }
    >();
  });

  it("keeps durable background completion hydration stable", () => {
    expectTypeOf<BackgroundCompletionResult>().toEqualTypeOf<{
      sessionId: string;
      task: string;
      status: "completed" | "error" | "cancelled";
      resultState: BackgroundResultState;
      terminalReason?: string;
      resultText?: string;
      partialOutput?: string;
      summary?: string;
      retrySafe?: boolean;
      agentRetryable?: boolean;
      completedAt: number;
    }>();
  });

  it("keeps revert recovery hydration stable", () => {
    expectTypeOf<RevertRecoveryNotice>().toEqualTypeOf<{
      projectId: string;
      checkpointId: string;
      sessionRevision: string;
      workspaceRevision?: string;
      startedAt: number;
      title: string;
      message: string;
    }>();
  });
});
