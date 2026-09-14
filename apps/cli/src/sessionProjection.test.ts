import type { AgentTurnEvent, AgentTurnResult } from "@agentlink/core";
import { describe, expect, it } from "vitest";
import {
  initialStandaloneSessionProjection,
  reduceStandaloneSessionProjection,
} from "./sessionProjection.js";

const base = {
  schemaVersion: 1 as const,
  sessionId: "session-1",
  turnId: "turn-1",
  emittedAt: 1,
};

function event(value: object, sequence: number): AgentTurnEvent {
  return { ...base, sequence, ...value } as AgentTurnEvent;
}

function completed(): AgentTurnResult {
  return {
    status: "completed",
    sessionId: "session-1",
    turnId: "turn-1",
    sessionRevision: "2",
    execution: {} as never,
    provenance: {} as never,
    text: "Working now",
    stopReason: undefined,
    usage: undefined,
  };
}

describe("standalone session projection", () => {
  it("projects streaming transcript, tool activity, usage, and completion", () => {
    let state = initialStandaloneSessionProjection("/project");
    state = reduceStandaloneSessionProjection(state, {
      type: "session.new",
      sessionId: "session-1",
    });
    state = reduceStandaloneSessionProjection(state, {
      type: "user.submitted",
      text: "Fix it",
    });
    state = reduceStandaloneSessionProjection(state, {
      type: "turn.event",
      event: event({ type: "turn.started" }, 0),
    });
    state = reduceStandaloneSessionProjection(state, {
      type: "turn.event",
      event: event({ type: "thinking.started", thinkingId: "thinking-1" }, 1),
    });
    state = reduceStandaloneSessionProjection(state, {
      type: "turn.event",
      event: event(
        {
          type: "thinking.delta",
          thinkingId: "thinking-1",
          text: "Inspecting state",
        },
        2,
      ),
    });
    state = reduceStandaloneSessionProjection(state, {
      type: "turn.event",
      event: event({ type: "thinking.completed", thinkingId: "thinking-1" }, 3),
    });
    state = reduceStandaloneSessionProjection(state, {
      type: "turn.event",
      event: event({ type: "text.delta", text: "Working" }, 4),
    });
    state = reduceStandaloneSessionProjection(state, {
      type: "turn.event",
      event: event({ type: "text.delta", text: " now" }, 5),
    });
    state = reduceStandaloneSessionProjection(state, {
      type: "turn.event",
      event: event(
        {
          type: "tool.requested",
          toolCallId: "tool-1",
          toolName: "read_file",
          effect: "read",
          displayInput: { path: "src/index.ts" },
        },
        6,
      ),
    });
    state = reduceStandaloneSessionProjection(state, {
      type: "turn.event",
      event: event(
        {
          type: "tool.completed",
          toolCallId: "tool-1",
          toolName: "read_file",
          effect: "read",
          displayContent: { lines: 5 },
        },
        7,
      ),
    });
    state = reduceStandaloneSessionProjection(state, {
      type: "turn.result",
      result: completed(),
    });

    expect(state.phase).toBe("idle");
    expect(state.transcript).toEqual([
      expect.objectContaining({
        role: "user",
        text: "Fix it",
        turnId: "turn-1",
        streaming: false,
      }),
      expect.objectContaining({
        role: "assistant",
        text: "Working now",
        streaming: false,
      }),
    ]);
    expect(state.thinking).toEqual([
      {
        thinkingId: "thinking-1",
        turnId: "turn-1",
        sequence: 1,
        text: "Inspecting state",
        status: "completed",
      },
    ]);
    expect(state.tools).toEqual([
      expect.objectContaining({
        toolCallId: "tool-1",
        turnId: "turn-1",
        status: "completed",
        displayInput: { path: "src/index.ts" },
        displayContent: { lines: 5 },
      }),
    ]);
  });

  it("clears prior session activity when switching sessions", () => {
    const stale = {
      ...initialStandaloneSessionProjection("/project"),
      thinking: [
        {
          thinkingId: "old-thinking",
          turnId: "old-turn",
          sequence: 1,
          text: "old",
          status: "completed" as const,
        },
      ],
      tools: [
        {
          toolCallId: "old-tool",
          turnId: "old-turn",
          sequence: 2,
          toolName: "read_file",
          effect: "read" as const,
          status: "completed" as const,
        },
      ],
      execution: {} as never,
      lastResult: completed(),
    };

    const selected = reduceStandaloneSessionProjection(stale, {
      type: "session.selected",
      sessionId: "session-2",
      messages: [{ role: "user", content: "New session" }],
    });

    expect(selected).toMatchObject({
      sessionId: "session-2",
      thinking: [],
      tools: [],
    });
    expect(selected).not.toHaveProperty("execution");
    expect(selected).not.toHaveProperty("lastResult");
  });

  it("continues one assistant message when a suspended turn resumes", () => {
    const interaction = {
      interactionId: "approval-1",
      kind: "tool_authorization",
      summary: "Read file",
      toolCallId: "tool-1",
      toolName: "read_file",
      effect: "read",
    } as const;
    let state = reduceStandaloneSessionProjection(
      initialStandaloneSessionProjection("/project"),
      { type: "session.new", sessionId: "session-1" },
    );
    state = reduceStandaloneSessionProjection(state, {
      type: "user.submitted",
      text: "Continue after approval",
    });
    state = reduceStandaloneSessionProjection(state, {
      type: "turn.event",
      event: event({ type: "turn.started" }, 0),
    });
    state = reduceStandaloneSessionProjection(state, {
      type: "turn.event",
      event: event({ type: "text.delta", text: "Before " }, 1),
    });
    state = reduceStandaloneSessionProjection(state, {
      type: "turn.result",
      result: {
        status: "suspended",
        sessionId: "session-1",
        turnId: "turn-1",
        sessionRevision: "2",
        execution: {} as never,
        provenance: {} as never,
        interaction,
      },
    });
    state = reduceStandaloneSessionProjection(state, {
      type: "turn.event",
      event: event(
        {
          type: "interaction.resumed",
          interactionId: "approval-1",
          decision: "allow",
          sessionRevision: "3",
        },
        2,
      ),
    });
    state = reduceStandaloneSessionProjection(state, {
      type: "turn.event",
      event: event({ type: "text.delta", text: "after" }, 3),
    });

    expect(
      state.transcript.filter((message) => message.role === "assistant"),
    ).toEqual([
      expect.objectContaining({ text: "Before after", turnId: "turn-1" }),
    ]);
  });

  it("anchors restored suspended turns to the latest durable user message", () => {
    const state = reduceStandaloneSessionProjection(
      initialStandaloneSessionProjection("/project"),
      {
        type: "session.selected",
        sessionId: "session-1",
        activeTurnId: "turn-restored",
        messages: [
          { role: "user", content: "Earlier" },
          { role: "assistant", content: "Earlier answer" },
          { role: "user", content: "Pending approval" },
        ],
      },
    );

    expect(state.transcript.at(-1)).toMatchObject({
      role: "user",
      text: "Pending approval",
      turnId: "turn-restored",
    });
  });

  it("restores only displayable user and assistant text from durable history", () => {
    const providerReplay = { providerId: "private" } as never;
    const state = reduceStandaloneSessionProjection(
      initialStandaloneSessionProjection("/project"),
      {
        type: "session.selected",
        sessionId: "session-1",
        messages: [
          { role: "user", content: "Question", providerReplay },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "private", signature: "sig" },
              { type: "text", text: "Answer" },
              { type: "tool_result", tool_use_id: "tool-1", content: "secret" },
            ],
            providerReplay,
          },
          {
            role: "assistant",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "private",
                },
              },
            ],
          },
        ],
      },
    );

    expect(state.transcript).toEqual([
      expect.objectContaining({ role: "user", text: "Question" }),
      expect.objectContaining({ role: "assistant", text: "Answer" }),
    ]);
    expect(JSON.stringify(state.transcript)).not.toContain("private");
    expect(JSON.stringify(state.transcript)).not.toContain("secret");
  });

  it("projects pending interactions and refreshed activity independently of a renderer", () => {
    const interaction = {
      interactionId: "approval-1",
      kind: "tool_authorization",
      summary: "Write file",
      toolCallId: "tool-1",
      toolName: "write_file",
      effect: "write",
      displayContent: { path: "src/index.ts" },
    } as const;
    let state = reduceStandaloneSessionProjection(
      initialStandaloneSessionProjection("/project"),
      { type: "session.selected", sessionId: "session-1" },
    );
    state = reduceStandaloneSessionProjection(state, {
      type: "interaction.restored",
      interaction,
    });
    state = reduceStandaloneSessionProjection(state, {
      type: "activity.refreshed",
      commands: [{ commandId: "command-1", state: "running" } as never],
      backgroundAgents: [
        { childSessionId: "child-1", lifecycle: "running" } as never,
      ],
      backgroundApprovals: [
        {
          childSessionId: "child-2",
          lifecycle: "awaiting_approval",
          approval: { interactionId: "approval-2" },
        } as never,
      ],
    });

    state = reduceStandaloneSessionProjection(state, {
      type: "mcp.refreshed",
      servers: [
        { id: "linear", source: "project", transport: "streamable-http" },
      ],
    });

    expect(state).toMatchObject({
      phase: "awaiting_approval",
      pendingInteraction: { interactionId: "approval-1" },
      commands: [{ commandId: "command-1" }],
      backgroundAgents: [{ childSessionId: "child-1" }],
      backgroundApprovals: [{ childSessionId: "child-2" }],
      mcpServers: [{ id: "linear", transport: "streamable-http" }],
    });
  });
});
