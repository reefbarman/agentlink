import type {
  AgentPrincipal,
  AgentTurnEvent,
  AgentTurnRequest,
  AgentTurnResult,
  AgentTurnRunOptions,
  PreparedAgentTurnRequest,
} from "./turnContracts.js";
import {
  agentModelReferenceKey,
  resolveAgentModelSelection,
} from "./turnContracts.js";
import { describe, expect, expectTypeOf, it } from "vitest";

interface TestPrincipal extends AgentPrincipal {
  roles: string[];
}

describe("turn contracts", () => {
  it("uses provider-qualified model identity", () => {
    expect(
      agentModelReferenceKey({ providerId: "codex", modelId: "gpt-5.6-sol" }),
    ).toBe('["codex","gpt-5.6-sol"]');
    expect(
      agentModelReferenceKey({
        providerId: "openai-compatible:local",
        modelId: "gpt-5.6-sol",
      }),
    ).toBe('["openai-compatible:local","gpt-5.6-sol"]');
  });

  it("resolves turn, session, and runtime model precedence deterministically", () => {
    const runtimeDefaultModel = { providerId: "runtime", modelId: "default" };
    const sessionModel = { providerId: "session", modelId: "selected" };
    const turnModel = { providerId: "turn", modelId: "override" };

    expect(
      resolveAgentModelSelection({
        turnModel,
        sessionModel,
        runtimeDefaultModel,
      }),
    ).toEqual({ model: turnModel, source: "turn" });
    expect(
      resolveAgentModelSelection({
        turnModel: undefined,
        sessionModel,
        runtimeDefaultModel,
      }),
    ).toEqual({ model: sessionModel, source: "session" });
    expect(
      resolveAgentModelSelection({
        turnModel: undefined,
        sessionModel: undefined,
        runtimeDefaultModel,
      }),
    ).toEqual({ model: runtimeDefaultModel, source: "runtime" });
    expect(
      resolveAgentModelSelection({
        turnModel: undefined,
        sessionModel: undefined,
        runtimeDefaultModel: undefined,
      }),
    ).toBeNull();
  });

  it("keeps serializable intent separate from execution and preparation", () => {
    expectTypeOf<keyof AgentTurnRequest<TestPrincipal>>().toEqualTypeOf<
      "principal" | "sessionId" | "input" | "model"
    >();
    expectTypeOf<keyof AgentTurnRunOptions>().toEqualTypeOf<"signal">();
    expectTypeOf<keyof PreparedAgentTurnRequest<TestPrincipal>>().toEqualTypeOf<
      | "request"
      | "turnId"
      | "history"
      | "sessionModel"
      | "runtimeDefaultModel"
      | "systemPrompt"
      | "maxOutputTokens"
      | "reasoningEffort"
      | "limits"
      | "sessionRevision"
      | "turnFencingToken"
    >();
    expectTypeOf<
      PreparedAgentTurnRequest<TestPrincipal>["request"]
    >().toEqualTypeOf<AgentTurnRequest<TestPrincipal>>();
  });

  it("defines one terminal event for every result state", () => {
    type ResultStatus = AgentTurnResult["status"];
    type TerminalEvent = Extract<
      AgentTurnEvent,
      {
        type:
          | "turn.completed"
          | "turn.cancelled"
          | "turn.failed"
          | "turn.suspended";
      }
    >;
    type TerminalEventStatus = TerminalEvent["result"]["status"];

    expectTypeOf<ResultStatus>().toEqualTypeOf<TerminalEventStatus>();
  });

  it("pins least-disclosure event payloads", () => {
    type EventBaseKeys =
      | "schemaVersion"
      | "sessionId"
      | "turnId"
      | "sequence"
      | "emittedAt"
      | "type";
    type Requested = Extract<AgentTurnEvent, { type: "tool.requested" }>;
    type Completed = Extract<AgentTurnEvent, { type: "tool.completed" }>;
    type Usage = Extract<AgentTurnEvent, { type: "usage.updated" }>;
    type Execution = Extract<AgentTurnEvent, { type: "execution.updated" }>;
    type Required = Extract<AgentTurnEvent, { type: "interaction.required" }>;
    type Resumed = Extract<AgentTurnEvent, { type: "interaction.resumed" }>;

    expectTypeOf<keyof Requested>().toEqualTypeOf<
      EventBaseKeys | "toolCallId" | "toolName" | "displayInput"
    >();
    expectTypeOf<keyof Completed>().toEqualTypeOf<
      EventBaseKeys | "toolCallId" | "toolName" | "displayContent"
    >();
    expectTypeOf<keyof Usage>().toEqualTypeOf<
      EventBaseKeys | "model" | "usage"
    >();
    expectTypeOf<keyof Execution>().toEqualTypeOf<EventBaseKeys | "event">();
    expectTypeOf<keyof Required>().toEqualTypeOf<
      EventBaseKeys | "interaction" | "interactionRevision" | "sessionRevision"
    >();
    expectTypeOf<keyof Resumed>().toEqualTypeOf<
      EventBaseKeys | "interactionId" | "decision" | "sessionRevision"
    >();
    expectTypeOf<{}>().toMatchTypeOf<Pick<Requested, "displayInput">>();
    expectTypeOf<{}>().toMatchTypeOf<Pick<Completed, "displayContent">>();
  });
});
