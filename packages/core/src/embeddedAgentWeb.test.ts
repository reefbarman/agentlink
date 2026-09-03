import {
  decodeEmbeddedAgentNdjson,
  type EmbeddedAgentStreamFrame,
} from "@agentlink/protocol/embedded-agent-transport";
import { describe, expect, it, vi } from "vitest";

import {
  AgentEngineError,
  type AgentEngine,
  type AgentSessionHydration,
} from "./agentEngine.js";
import { createEmbeddedAgentWebHandler } from "./embeddedAgentWeb.js";
import type { AgentTurnEvent, AgentTurnResult } from "./turnContracts.js";

const principal = { tenantId: "tenant-a", subjectId: "subject-a" };

function inspection() {
  return {
    summary: {
      principal,
      sessionId: "session-1",
      createdAt: 1,
      updatedAt: 2,
      runState: { phase: "idle" as const },
      revision: "3",
    },
  };
}

function hydration(): AgentSessionHydration<typeof principal> {
  return {
    ...inspection(),
    record: {
      schemaVersion: 1,
      principal,
      sessionId: "session-1",
      createdAt: 1,
      updatedAt: 2,
      messages: [{ role: "user", content: "private transcript" }],
      runState: { phase: "idle" },
    },
  };
}

function stream(
  events: readonly AgentTurnEvent[],
  result: AgentTurnResult,
): AsyncGenerator<AgentTurnEvent, AgentTurnResult> {
  return (async function* () {
    yield* events;
    return result;
  })();
}

function engine(
  overrides: Partial<AgentEngine<typeof principal>["sessions"]> = {},
) {
  const sessions = {
    create: vi.fn(async () => ({
      record: hydration().record,
      revision: "1",
    })),
    read: vi.fn(),
    list: vi.fn(),
    inspect: vi.fn(async () => inspection()),
    hydrate: vi.fn(async () => hydration()),
    setModel: vi.fn(),
    setReasoningEffort: vi.fn(),
    runTurn: vi.fn(() =>
      stream(
        [
          {
            schemaVersion: 1,
            sessionId: "session-1",
            turnId: "turn-1",
            sequence: 0,
            emittedAt: 1,
            type: "turn.started",
          },
          {
            schemaVersion: 1,
            sessionId: "session-1",
            turnId: "turn-1",
            sequence: 1,
            emittedAt: 2,
            type: "text.delta",
            text: "Hello",
          },
          {
            schemaVersion: 1,
            sessionId: "session-1",
            turnId: "turn-1",
            sequence: 2,
            emittedAt: 3,
            type: "turn.completed",
            result: {
              status: "completed",
              sessionId: "session-1",
              turnId: "turn-1",
              sessionRevision: "3",
              text: "Hello",
              stopReason: "end_turn",
              usage: undefined,
              execution: {
                limits: {
                  maxModelCalls: 1,
                  maxToolCalls: 1,
                  maxElapsedMs: 1_000,
                  maxToolResultBytes: 1_000,
                },
                modelCalls: 1,
                toolCalls: 0,
                elapsedMs: 1,
                toolResultBytes: 0,
              },
              provenance: {
                requestedModel: undefined,
                resolvedModel: {
                  model: { providerId: "fixture", modelId: "model" },
                  source: "runtime",
                },
              },
            },
          },
        ],
        {
          status: "completed",
          sessionId: "session-1",
          turnId: "turn-1",
          sessionRevision: "3",
          text: "Hello",
          stopReason: "end_turn",
          usage: undefined,
          execution: {
            limits: {
              maxModelCalls: 1,
              maxToolCalls: 1,
              maxElapsedMs: 1_000,
              maxToolResultBytes: 1_000,
            },
            modelCalls: 1,
            toolCalls: 0,
            elapsedMs: 1,
            toolResultBytes: 0,
          },
          provenance: {
            requestedModel: undefined,
            resolvedModel: {
              model: { providerId: "fixture", modelId: "model" },
              source: "runtime",
            },
          },
        },
      ),
    ),
    resumeInteraction: vi.fn(),
    cancel: vi.fn(async () => ({
      status: "not_active" as const,
      revision: "3",
    })),
    recoverInterrupted: vi.fn(),
    delete: vi.fn(async () => undefined),
    ...overrides,
  };
  return {
    models: {} as AgentEngine<typeof principal>["models"],
    sessions,
  } as AgentEngine<typeof principal>;
}

function request(body: unknown, init: RequestInit = {}) {
  return new Request("https://app.example.test/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...init.headers },
    body: JSON.stringify(body),
    ...init,
  });
}

function timeout(milliseconds: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error("timed out")), milliseconds).unref();
  });
}

async function frames(response: Response): Promise<EmbeddedAgentStreamFrame[]> {
  const result: EmbeddedAgentStreamFrame[] = [];
  if (!response.body) throw new Error("Expected response body");
  for await (const frame of decodeEmbeddedAgentNdjson(response.body)) {
    result.push(frame);
  }
  return result;
}

describe("embedded agent Web handler", () => {
  it("enforces JSON, authentication, origin policy, and rate policy", async () => {
    const agent = engine();
    const unauthenticated = createEmbeddedAgentWebHandler({
      engine: agent,
      authenticate: () => null,
    });
    expect(
      (
        await unauthenticated(
          new Request("https://app.example.test/api/agent", {
            method: "POST",
            body: "{}",
          }),
        )
      ).status,
    ).toBe(415);
    expect((await unauthenticated(request({}))).status).toBe(401);

    const forbidden = createEmbeddedAgentWebHandler({
      engine: agent,
      authenticate: () => principal,
      authorizeRequest: () => false,
    });
    expect(
      (
        await forbidden(
          request({
            schemaVersion: 1,
            type: "inspect",
            sessionId: "session-1",
          }),
        )
      ).status,
    ).toBe(403);

    const limited = createEmbeddedAgentWebHandler({
      engine: agent,
      authenticate: () => principal,
      rateLimit: () => false,
    });
    expect(
      (
        await limited(
          request({
            schemaVersion: 1,
            type: "inspect",
            sessionId: "session-1",
          }),
        )
      ).status,
    ).toBe(429);
  });

  it("passes canonical requests to policy hooks and supports host validation", async () => {
    const agent = engine();
    const authorizeRequest = vi.fn(() => true);
    const rateLimit = vi.fn(() => true);
    const validateSessionId = vi.fn(
      ({ principal: currentPrincipal, sessionId }) =>
        currentPrincipal.tenantId === "tenant-a" &&
        sessionId.startsWith("tenant-"),
    );
    const validateMessage = vi.fn(({ message }) => message !== "blocked");
    const handler = createEmbeddedAgentWebHandler({
      engine: agent,
      authenticate: () => principal,
      authorizeRequest,
      rateLimit,
      validateSessionId,
      validateMessage,
      maxSessionIdLength: 32,
      maxMessageLength: 8,
    });

    const allowed = await handler(
      request({
        schemaVersion: 1,
        type: "turn",
        sessionId: "tenant-session",
        text: "hello",
      }),
    );
    expect(allowed.status).toBe(200);
    expect(authorizeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "turn",
        sessionId: "tenant-session",
        parsedRequest: {
          schemaVersion: 1,
          type: "turn",
          sessionId: "tenant-session",
          text: "hello",
        },
      }),
    );
    expect(rateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "tenant-session" }),
    );
    expect(validateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: "hello" }),
    );

    expect(
      (
        await handler(
          request({
            schemaVersion: 1,
            type: "turn",
            sessionId: "wrong-session",
            text: "hello",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handler(
          request({
            schemaVersion: 1,
            type: "turn",
            sessionId: "tenant-session",
            text: "blocked",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handler(
          request({
            schemaVersion: 1,
            type: "turn",
            sessionId: "tenant-session",
            text: "too long!",
          }),
        )
      ).status,
    ).toBe(400);
    expect(agent.sessions.runTurn).toHaveBeenCalledTimes(1);
  });

  it("returns only explicit hydration projection and lifecycle control state", async () => {
    const agent = engine();
    const handler = createEmbeddedAgentWebHandler({
      engine: agent,
      authenticate: () => principal,
      projectHydration: ({ hydration: value }) => ({
        messageCount: value.record.messages.length,
      }),
    });

    const response = await handler(
      request({ schemaVersion: 1, type: "hydrate", sessionId: "session-1" }),
    );
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('"messageCount":1');
    expect(text).not.toContain("private transcript");
  });

  it("streams least-disclosure ordered events and the terminal result as NDJSON", async () => {
    const agent = engine();
    const handler = createEmbeddedAgentWebHandler({
      engine: agent,
      authenticate: () => principal,
    });

    const response = await handler(
      request({
        schemaVersion: 1,
        type: "turn",
        sessionId: "session-1",
        text: "Hello",
        reasoningEffort: "high",
      }),
    );
    expect(response.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-transform",
    );
    const streamed = await frames(response);
    expect(streamed.map((frame) => frame.type)).toEqual([
      "event",
      "event",
      "event",
      "result",
    ]);
    expect(streamed).toContainEqual(
      expect.objectContaining({
        type: "event",
        event: expect.objectContaining({ type: "text.delta", text: "Hello" }),
      }),
    );
    expect(agent.sessions.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: "high" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("settles response-body cancellation while the agent generator is blocked", async () => {
    let observedSignal: AbortSignal | undefined;
    let resolveNext!: () => void;
    const blocked = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
    const blockedStream = (async function* (): AsyncGenerator<
      AgentTurnEvent,
      AgentTurnResult
    > {
      yield* [] as AgentTurnEvent[];
      await blocked;
      return undefined as never;
    })();
    const agent = engine({
      runTurn: vi.fn((_request, options) => {
        observedSignal = options?.signal;
        return blockedStream;
      }),
    });
    const handler = createEmbeddedAgentWebHandler({
      engine: agent,
      authenticate: () => principal,
    });
    const response = await handler(
      request({
        schemaVersion: 1,
        type: "turn",
        sessionId: "session-1",
        text: "wait",
      }),
    );
    const reader = response.body!.getReader();
    const cancelled = reader.cancel("client closed");

    await expect(
      Promise.race([cancelled, timeout(250)]),
    ).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
    resolveNext();
  });

  it("maps pre-stream engine conflicts and emits safe post-header errors", async () => {
    const missing = engine({
      inspect: vi.fn(async () => {
        throw new AgentEngineError(
          "session_not_found",
          "private database detail",
        );
      }),
    });
    const missingHandler = createEmbeddedAgentWebHandler({
      engine: missing,
      authenticate: () => principal,
    });
    const missingResponse = await missingHandler(
      request({ schemaVersion: 1, type: "inspect", sessionId: "missing" }),
    );
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.text()).not.toContain(
      "private database detail",
    );

    const broken = engine({
      runTurn: vi.fn(() =>
        (async function* (): AsyncGenerator<AgentTurnEvent, AgentTurnResult> {
          yield* [] as AgentTurnEvent[];
          throw new AgentEngineError(
            "turn_lease_held",
            "private owner detail",
            true,
          );
        })(),
      ),
    });
    const brokenHandler = createEmbeddedAgentWebHandler({
      engine: broken,
      authenticate: () => principal,
    });
    const streamed = await frames(
      await brokenHandler(
        request({
          schemaVersion: 1,
          type: "turn",
          sessionId: "session-1",
          text: "Hello",
        }),
      ),
    );
    expect(streamed).toEqual([
      {
        schemaVersion: 1,
        type: "error",
        error: {
          code: "turn_lease_held",
          category: "conflict",
          message: "The session is busy",
          retryable: true,
        },
      },
    ]);
  });

  it("dispatches cancel and delete through the high-level lifecycle API", async () => {
    const agent = engine();
    const handler = createEmbeddedAgentWebHandler({
      engine: agent,
      authenticate: () => principal,
    });
    expect(
      (
        await handler(
          request({
            schemaVersion: 1,
            type: "cancel",
            sessionId: "session-1",
            reason: "stop",
          }),
        )
      ).status,
    ).toBe(200);
    expect(agent.sessions.cancel).toHaveBeenCalledWith({
      principal,
      sessionId: "session-1",
      reason: "stop",
    });

    await handler(
      request({
        schemaVersion: 1,
        type: "delete",
        sessionId: "session-1",
        expectedRevision: "3",
      }),
    );
    expect(agent.sessions.delete).toHaveBeenCalledWith({
      principal,
      sessionId: "session-1",
      expectedRevision: "3",
    });
  });
});
