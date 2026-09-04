import { describe, expect, it } from "vitest";

import {
  EmbeddedAgentProtocolError,
  createEmbeddedAgentClientController,
  createEmbeddedAgentClientState,
  decodeEmbeddedAgentNdjson,
  reduceEmbeddedAgentTurnEvent,
  type EmbeddedAgentClientState,
  type EmbeddedAgentTurnEvent,
} from "./embeddedAgentTransport.js";

type EventPayload = EmbeddedAgentTurnEvent extends infer TEvent
  ? TEvent extends EmbeddedAgentTurnEvent
    ? Omit<
        TEvent,
        "schemaVersion" | "sessionId" | "turnId" | "sequence" | "emittedAt"
      >
    : never
  : never;

function event(sequence: number, value: EventPayload): EmbeddedAgentTurnEvent {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    turnId: "turn-1",
    sequence,
    emittedAt: sequence,
    ...value,
  } as EmbeddedAgentTurnEvent;
}

function reduce(
  events: readonly EmbeddedAgentTurnEvent[],
): EmbeddedAgentClientState {
  return events.reduce(
    reduceEmbeddedAgentTurnEvent,
    createEmbeddedAgentClientState(),
  );
}

describe("embedded agent transport", () => {
  it("preserves ordered text and tool blocks and renders denial neutrally", () => {
    const state = reduce([
      event(0, { type: "turn.started" }),
      event(1, { type: "text.delta", text: "Before " }),
      event(2, {
        type: "tool.requested",
        toolCallId: "call-1",
        toolName: "write_record",
        effect: "write",
        presentation: { title: "Update record", destructive: true },
        displayInput: { title: "Update record" },
      }),
      event(3, {
        type: "tool.started",
        toolCallId: "call-1",
        toolName: "write_record",
        effect: "write",
      }),
      event(4, {
        type: "tool.failed",
        toolCallId: "call-1",
        toolName: "write_record",
        effect: "write",
        presentation: { title: "Update record", destructive: true },
        error: {
          code: "tool_authorization_denied",
          category: "authorization",
          message: "Denied",
          retryable: false,
        },
      }),
      event(5, { type: "text.delta", text: "after" }),
      event(6, {
        type: "turn.completed",
        result: {
          status: "completed",
          sessionId: "session-1",
          turnId: "turn-1",
          sessionRevision: "3",
          text: "Before after",
        },
      }),
    ]);

    expect(state.status).toBe("completed");
    expect(state.blocks).toEqual([
      { type: "text", text: "Before " },
      {
        type: "tool",
        toolCallId: "call-1",
        toolName: "write_record",
        effect: "write",
        presentation: { title: "Update record", destructive: true },
        status: "denied",
        displayInput: { title: "Update record" },
        error: {
          code: "tool_authorization_denied",
          category: "authorization",
          message: "Denied",
          retryable: false,
        },
      },
      { type: "text", text: "after" },
    ]);
  });

  it("tracks pending approval and every terminal state", () => {
    const pending = reduce([
      event(0, { type: "turn.started" }),
      event(1, {
        type: "interaction.required",
        interaction: {
          interactionId: "interaction-1",
          kind: "tool_authorization",
          summary: "Approve write",
          toolCallId: "call-1",
          toolName: "write_record",
          effect: "write",
        },
        interactionRevision: "1",
        sessionRevision: "3",
      }),
      event(2, {
        type: "turn.suspended",
        result: {
          status: "suspended",
          sessionId: "session-1",
          turnId: "turn-1",
          sessionRevision: "3",
        },
      }),
    ]);
    expect(pending).toMatchObject({
      status: "suspended",
      pendingInteraction: { interactionRevision: "1" },
    });

    for (const [type, status] of [
      ["turn.cancelled", "cancelled"],
      ["turn.failed", "failed"],
    ] as const) {
      const terminal = reduce([
        event(0, { type: "turn.started" }),
        event(1, {
          type,
          result: {
            status,
            sessionId: "session-1",
            turnId: "turn-1",
            sessionRevision: "2",
            ...(status === "failed"
              ? {
                  error: {
                    code: "provider_unavailable",
                    category: "provider" as const,
                    message: "Unavailable",
                    retryable: true,
                  },
                }
              : { reason: "Stopped" }),
          },
        }),
      ]);
      expect(terminal.status).toBe(status);
    }
  });

  it("restores the persisted sequence for approval resume after refresh", () => {
    const state = createEmbeddedAgentClientState({
      sessionId: "session-1",
      revision: "3",
      phase: "suspended",
      turnId: "turn-1",
      pendingInteraction: {
        request: {
          interactionId: "interaction-1",
          kind: "tool_authorization",
          summary: "Approve write",
          toolCallId: "call-1",
          toolName: "write_record",
          effect: "write",
          presentation: { title: "Update record", destructive: true },
          displayInput: { account: "Checking" },
        },
        interactionRevision: "1",
        sessionRevision: "3",
        nextSequence: 3,
      },
    });
    expect(state).toMatchObject({
      status: "suspended",
      nextSequence: 3,
      pendingInteraction: { interactionRevision: "1" },
      blocks: [
        {
          type: "tool",
          toolCallId: "call-1",
          toolName: "write_record",
          effect: "write",
          presentation: { title: "Update record", destructive: true },
          displayInput: { account: "Checking" },
          status: "requested",
        },
      ],
    });

    const resumed = reduceEmbeddedAgentTurnEvent(
      state,
      event(3, {
        type: "interaction.resumed",
        interactionId: "interaction-1",
        decision: "allow",
        sessionRevision: "4",
      }),
    );
    expect(resumed).toMatchObject({
      status: "running",
      nextSequence: 4,
      pendingInteraction: undefined,
      blocks: [{ toolCallId: "call-1", status: "requested" }],
    });
  });

  it("fails closed on sequence, turn, and unknown-tool violations", () => {
    expect(() =>
      reduceEmbeddedAgentTurnEvent(
        createEmbeddedAgentClientState(),
        event(1, { type: "turn.started" }),
      ),
    ).toThrow(EmbeddedAgentProtocolError);
    const started = reduce([event(0, { type: "turn.started" })]);
    expect(() =>
      reduceEmbeddedAgentTurnEvent(started, {
        ...event(1, { type: "text.delta", text: "wrong" }),
        turnId: "turn-2",
      }),
    ).toThrow(/different turn/);
    expect(() =>
      reduceEmbeddedAgentTurnEvent(
        started,
        event(1, {
          type: "tool.started",
          toolCallId: "missing",
          toolName: "missing",
          effect: "unknown",
        }),
      ),
    ).toThrow(/unknown call/);
    expect(() =>
      reduceEmbeddedAgentTurnEvent(started, {
        ...event(1, { type: "text.delta", text: "unknown" }),
        type: "future.event",
      } as unknown as EmbeddedAgentTurnEvent),
    ).toThrow(/Unknown embedded-agent event type/);
  });

  it("decodes chunked NDJSON and rejects malformed frames", async () => {
    const encoded = new TextEncoder().encode(
      `${JSON.stringify({ schemaVersion: 1, type: "event", event: event(0, { type: "turn.started" }) })}\n${JSON.stringify({ schemaVersion: 1, type: "result", result: { status: "cancelled", sessionId: "session-1", turnId: "turn-1", sessionRevision: "2" } })}\n`,
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 17));
        controller.enqueue(encoded.slice(17));
        controller.close();
      },
    });
    const frames = [];
    for await (const frame of decodeEmbeddedAgentNdjson(body))
      frames.push(frame);
    expect(frames.map((frame) => frame.type)).toEqual(["event", "result"]);

    const malformed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("not-json\n"));
        controller.close();
      },
    });
    await expect(async () => {
      for await (const _frame of decodeEmbeddedAgentNdjson(malformed)) {
        // Consume the stream.
      }
    }).rejects.toThrow(/invalid JSON/);
  });

  it("controls lifecycle requests and publishes hydrated state without a framework", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const snapshots = {
      create: {
        sessionId: "session-1",
        revision: "1",
        phase: "idle" as const,
      },
      hydrate: {
        sessionId: "session-1",
        revision: "2",
        phase: "suspended" as const,
        turnId: "turn-1",
        pendingInteraction: {
          request: {
            interactionId: "interaction-1",
            kind: "tool_authorization" as const,
            summary: "Approve write",
            toolCallId: "call-1",
            toolName: "write_record",
            effect: "write" as const,
          },
          interactionRevision: "3",
          sessionRevision: "2",
          nextSequence: 4,
        },
      },
    };
    const controller = createEmbeddedAgentClientController({
      endpoint: "https://example.test/agent",
      headers: async () => ({ Authorization: "Bearer token" }),
      fetch: async (_input, init) => {
        const headers = init?.headers as
          | Readonly<Record<string, string>>
          | undefined;
        expect(headers?.authorization).toBe("Bearer token");
        const request = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        requests.push(request);
        if (request.type === "delete") {
          return Response.json({ schemaVersion: 1, ok: true, type: "deleted" });
        }
        const session =
          request.type === "hydrate" ? snapshots.hydrate : snapshots.create;
        return Response.json({
          schemaVersion: 1,
          ok: true,
          type: "inspection",
          session,
          ...(request.type === "hydrate"
            ? { projection: { messages: [] } }
            : {}),
        });
      },
    });
    const published: string[] = [];
    const unsubscribe = controller.subscribe((state) =>
      published.push(state.status),
    );

    await controller.create({ sessionId: "session-1" });
    const hydration = await controller.hydrate({ sessionId: "session-1" });
    expect(hydration.projection).toEqual({ messages: [] });
    expect(controller.getState()).toMatchObject({
      status: "suspended",
      nextSequence: 4,
      blocks: [{ type: "tool", toolCallId: "call-1", status: "requested" }],
    });
    await controller.recover({ sessionId: "session-1", reason: "restart" });
    await controller.inspect({ sessionId: "session-1" });
    await controller.delete({ sessionId: "session-1", expectedRevision: "2" });
    unsubscribe();

    expect(requests.map((request) => request.type)).toEqual([
      "create",
      "hydrate",
      "recover",
      "inspect",
      "delete",
    ]);
    expect(published).toEqual(["idle", "suspended", "idle", "idle", "idle"]);
    expect(controller.getState()).toEqual(createEmbeddedAgentClientState());
  });

  it("rejects overlapping turns without corrupting the active stream", async () => {
    let release: (() => void) | undefined;
    const controller = createEmbeddedAgentClientController({
      endpoint: "/agent",
      fetch: async () =>
        await new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              new Response(
                [
                  JSON.stringify({
                    schemaVersion: 1,
                    type: "event",
                    event: event(0, { type: "turn.started" }),
                  }),
                  JSON.stringify({
                    schemaVersion: 1,
                    type: "event",
                    event: event(1, {
                      type: "turn.completed",
                      result: {
                        status: "completed",
                        sessionId: "session-1",
                        turnId: "turn-1",
                        sessionRevision: "2",
                        text: "done",
                      },
                    }),
                  }),
                  JSON.stringify({
                    schemaVersion: 1,
                    type: "result",
                    result: {
                      status: "completed",
                      sessionId: "session-1",
                      turnId: "turn-1",
                      sessionRevision: "2",
                      text: "done",
                    },
                  }),
                ].join("\n") + "\n",
              ),
            );
        }),
    });
    const first = controller.turn({ sessionId: "session-1", text: "first" });
    expect(controller.getState()).toMatchObject({
      sessionId: "session-1",
      status: "running",
      blocks: [],
    });
    await Promise.resolve();
    const before = controller.getState();
    await expect(
      controller.turn({ sessionId: "session-1", text: "second" }),
    ).rejects.toThrow(/already active/);
    expect(controller.getState()).toBe(before);
    release?.();
    await expect(first).resolves.toMatchObject({ status: "completed" });
  });

  it("streams a turn through strict NDJSON reduction", async () => {
    const frames = [
      {
        schemaVersion: 1,
        type: "event",
        event: event(0, { type: "turn.started" }),
      },
      {
        schemaVersion: 1,
        type: "event",
        event: event(1, { type: "text.delta", text: "Hello" }),
      },
      {
        schemaVersion: 1,
        type: "event",
        event: event(2, {
          type: "turn.completed",
          result: {
            status: "completed",
            sessionId: "session-1",
            turnId: "turn-1",
            sessionRevision: "2",
            text: "Hello",
          },
        }),
      },
      {
        schemaVersion: 1,
        type: "result",
        result: {
          status: "completed",
          sessionId: "session-1",
          turnId: "turn-1",
          sessionRevision: "2",
          text: "Hello",
        },
      },
    ];
    const controller = createEmbeddedAgentClientController({
      endpoint: "/agent",
      fetch: async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          type: "turn",
          sessionId: "session-1",
          text: "Hi",
        });
        return new Response(
          `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
          {
            headers: { "Content-Type": "application/x-ndjson" },
          },
        );
      },
    });

    await expect(
      controller.turn({ sessionId: "session-1", text: "Hi" }),
    ).resolves.toMatchObject({ status: "completed", text: "Hello" });
    expect(controller.getState()).toMatchObject({
      status: "completed",
      nextSequence: 3,
      blocks: [{ type: "text", text: "Hello" }],
    });
  });

  it("rejects cross-session events and result-only streams", async () => {
    const responses = [
      new Response(
        `${JSON.stringify({
          schemaVersion: 1,
          type: "event",
          event: { ...event(0, { type: "turn.started" }), sessionId: "other" },
        })}\n`,
      ),
      new Response(
        `${JSON.stringify({
          schemaVersion: 1,
          type: "result",
          result: {
            status: "completed",
            sessionId: "session-1",
            turnId: "unobserved-turn",
            sessionRevision: "2",
            text: "invalid",
          },
        })}\n`,
      ),
    ];
    const controller = createEmbeddedAgentClientController({
      endpoint: "/agent",
      fetch: async () => responses.shift()!,
    });
    await expect(
      controller.turn({ sessionId: "session-1", text: "first" }),
    ).rejects.toThrow(/different turn/);
    await expect(
      controller.turn({ sessionId: "session-1", text: "second" }),
    ).rejects.toThrow(/different turn/);
  });

  it("requires matching hydrated approval state before resume", async () => {
    const controller = createEmbeddedAgentClientController({
      endpoint: "/agent",
      fetch: async () => {
        throw new Error("fetch must not run");
      },
    });
    await expect(
      controller.resume({
        sessionId: "session-1",
        turnId: "turn-1",
        interactionId: "interaction-1",
        interactionRevision: "1",
        expectedSessionRevision: "2",
        decision: "allow",
      }),
    ).rejects.toThrow(/Hydrate the matching pending interaction/);
  });

  it("aborts an active stream before sending lifecycle cancellation", async () => {
    let calls = 0;
    const controller = createEmbeddedAgentClientController({
      endpoint: "/agent",
      fetch: async (_input, init) => {
        calls++;
        if (calls === 1) {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () =>
                reject(
                  init.signal?.reason ??
                    new DOMException("Aborted", "AbortError"),
                ),
              { once: true },
            );
          });
        }
        expect(JSON.parse(String(init?.body))).toMatchObject({
          type: "cancel",
        });
        return Response.json({
          schemaVersion: 1,
          ok: true,
          type: "cancelled",
          result: { status: "cancellation_requested" },
        });
      },
    });

    const running = controller.turn({ sessionId: "session-1", text: "wait" });
    await Promise.resolve();
    await expect(
      controller.cancel({ sessionId: "session-1", reason: "stop" }),
    ).resolves.toEqual({ status: "cancellation_requested" });
    await expect(running).rejects.toBeDefined();
    expect(controller.getState().status).toBe("cancelled");
    expect(calls).toBe(2);
  });

  it("surfaces stable endpoint errors without message parsing", async () => {
    const controller = createEmbeddedAgentClientController({
      endpoint: "/agent",
      fetch: async () =>
        Response.json(
          {
            schemaVersion: 1,
            ok: false,
            type: "error",
            error: {
              code: "rate_limited",
              category: "rate_limit",
              message: "Try later",
              retryable: true,
            },
          },
          { status: 429 },
        ),
    });
    await expect(
      controller.inspect({ sessionId: "session-1" }),
    ).rejects.toMatchObject({
      name: "EmbeddedAgentClientError",
      code: "rate_limited",
      category: "rate_limit",
      retryable: true,
    });
  });
});
