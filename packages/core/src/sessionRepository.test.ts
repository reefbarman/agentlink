import {
  InMemoryAgentStateRepository,
  type AgentSessionRecord,
} from "./sessionRepository.js";
import type { DurableToolInteractionRecord } from "./turnInteractions.js";
import { describe, expect, it } from "vitest";

const PRINCIPAL = { tenantId: "tenant-a", subjectId: "subject-a" };

function session(
  principal = PRINCIPAL,
  overrides: Partial<AgentSessionRecord> = {},
): AgentSessionRecord {
  return {
    schemaVersion: 1,
    principal,
    sessionId: "session-1",
    createdAt: 100,
    updatedAt: 100,
    messages: [{ role: "user", content: "hello" }],
    runState: { phase: "idle" },
    ...overrides,
  };
}

function interaction(
  principal = PRINCIPAL,
  overrides: Partial<DurableToolInteractionRecord> = {},
  turnFencingToken?: string,
): DurableToolInteractionRecord {
  return {
    schemaVersion: 1,
    interactionId: "interaction-1",
    state: "pending",
    principal,
    sessionId: "session-1",
    turnId: "turn-1",
    expectedSessionRevision: "1",
    createdAt: 200,
    request: {
      interactionId: "interaction-1",
      kind: "tool_authorization",
      summary: "Approve update?",
      toolCallId: "call-1",
      toolName: "update_record",
      effect: "write",
    },
    continuation: {
      prepared: {
        request: {
          principal,
          sessionId: "session-1",
          input: { text: "update", attachments: undefined },
          model: undefined,
        },
        turnId: "turn-1",
        history: [],
        sessionModel: undefined,
        runtimeDefaultModel: { providerId: "fake", modelId: "model" },
        systemPrompt: "system",
        maxOutputTokens: 128,
        reasoningEffort: undefined,
        limits: undefined,
        sessionRevision: "1",
        ...(turnFencingToken ? { turnFencingToken } : {}),
      },
      iterationMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "update_record",
              input: {},
            },
          ],
        },
      ],
      pendingToolCalls: [{ id: "call-1", name: "update_record", input: {} }],
      reservedToolCalls: [{ id: "call-1", name: "update_record", input: {} }],
      authorizedToolCallIds: [],
      model: {
        model: { providerId: "fake", modelId: "model" },
        source: "runtime",
      },
      execution: {
        limits: {
          maxModelCalls: 16,
          maxToolCalls: 64,
          maxElapsedMs: 300_000,
          maxToolResultBytes: 1_048_576,
        },
        modelCalls: 1,
        toolCalls: 1,
        elapsedMs: 100,
        toolResultBytes: 0,
      },
      nextSequence: 6,
    },
    ...overrides,
  };
}

describe("in-memory agent state repository", () => {
  it("creates, clones, lists, updates, and detects stale revisions", async () => {
    const repository = new InMemoryAgentStateRepository();
    const source = session();

    await expect(repository.createSession({ record: source })).resolves.toEqual(
      {
        ok: true,
        revision: "1",
      },
    );
    (source.messages as Array<{ role: "user"; content: string }>)[0] = {
      role: "user",
      content: "mutated outside",
    };
    const read = await repository.readSession({
      principal: PRINCIPAL,
      sessionId: "session-1",
    });
    expect(read).toMatchObject({
      ok: true,
      revision: "1",
      record: { messages: [{ content: "hello" }] },
    });
    if (!read.ok) throw new Error("expected session");

    const updated = { ...read.record, updatedAt: 200 };
    await expect(
      repository.saveSession({ record: updated, expectedRevision: "1" }),
    ).resolves.toEqual({ ok: true, revision: "2" });
    await expect(
      repository.saveSession({ record: updated, expectedRevision: "1" }),
    ).resolves.toEqual({
      ok: false,
      reason: "revision_conflict",
      currentRevision: "2",
    });
    await expect(
      repository.listSessions({ principal: PRINCIPAL }),
    ).resolves.toEqual([
      expect.objectContaining({ sessionId: "session-1", revision: "2" }),
    ]);
  });

  it("isolates identical session and interaction IDs across principals", async () => {
    const repository = new InMemoryAgentStateRepository();
    const other = { tenantId: "tenant-b", subjectId: "subject-a" };
    await repository.createSession({ record: session(PRINCIPAL) });
    await repository.createSession({ record: session(other) });
    await repository.createInteraction({
      record: interaction(PRINCIPAL),
      expectedSessionRevision: "1",
    });
    await repository.createInteraction({
      record: interaction(other),
      expectedSessionRevision: "1",
    });

    const [first, second] = await Promise.all([
      repository.readInteraction({
        principal: PRINCIPAL,
        sessionId: "session-1",
        interactionId: "interaction-1",
      }),
      repository.readInteraction({
        principal: other,
        sessionId: "session-1",
        interactionId: "interaction-1",
      }),
    ]);
    expect(first).toMatchObject({ ok: true, record: { principal: PRINCIPAL } });
    expect(second).toMatchObject({ ok: true, record: { principal: other } });
    await expect(
      repository.readInteraction({
        principal: { tenantId: "tenant-c", subjectId: "subject-a" },
        sessionId: "session-1",
        interactionId: "interaction-1",
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("atomically couples interaction create and consume to session revisions", async () => {
    const repository = new InMemoryAgentStateRepository();
    await repository.createSession({ record: session() });

    await expect(
      repository.createInteraction({
        record: interaction(),
        expectedSessionRevision: "1",
      }),
    ).resolves.toEqual({
      ok: true,
      interactionRevision: "1",
      sessionRevision: "2",
    });
    await expect(
      repository.readSession({ principal: PRINCIPAL, sessionId: "session-1" }),
    ).resolves.toMatchObject({
      ok: true,
      revision: "2",
      record: {
        pendingInteractionId: "interaction-1",
        runState: { phase: "suspended", turnId: "turn-1" },
      },
    });

    await expect(
      repository.consumeInteraction({
        principal: PRINCIPAL,
        sessionId: "session-1",
        interactionId: "interaction-1",
        expectedInteractionRevision: "1",
        expectedSessionRevision: "1",
        responseId: "response-stale",
        decision: "allow",
        consumedAt: 300,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "session_revision_conflict",
      currentSessionRevision: "2",
    });
    await expect(
      repository.consumeInteraction({
        principal: PRINCIPAL,
        sessionId: "session-1",
        interactionId: "interaction-1",
        expectedInteractionRevision: "1",
        expectedSessionRevision: "2",
        responseId: "response-1",
        decision: "allow",
        consumedAt: 300,
      }),
    ).resolves.toEqual({ ok: true, sessionRevision: "3" });
    await expect(
      repository.consumeInteraction({
        principal: PRINCIPAL,
        sessionId: "session-1",
        interactionId: "interaction-1",
        expectedInteractionRevision: "1",
        expectedSessionRevision: "2",
        responseId: "response-1",
        decision: "allow",
        consumedAt: 300,
      }),
    ).resolves.toEqual({ ok: false, reason: "consumed" });
    await expect(
      repository.readSession({ principal: PRINCIPAL, sessionId: "session-1" }),
    ).resolves.toMatchObject({
      ok: true,
      revision: "3",
      record: {
        runState: {
          phase: "resuming",
          responseId: "response-1",
          decision: "allow",
        },
      },
    });
  });

  it("rejects malformed fences, mismatched interaction revisions, and invalid decisions", async () => {
    const repository = new InMemoryAgentStateRepository();
    await repository.createSession({ record: session() });
    await expect(
      repository.saveSession({
        record: session(PRINCIPAL, { updatedAt: 200 }),
        expectedRevision: "1",
        fencingToken: "invalid",
      }),
    ).rejects.toThrow("positive decimal integer");
    await expect(
      repository.createInteraction({
        record: interaction(PRINCIPAL, { expectedSessionRevision: "stale" }),
        expectedSessionRevision: "1",
      }),
    ).rejects.toThrow("does not match its create precondition");
    await repository.createInteraction({
      record: interaction(),
      expectedSessionRevision: "1",
    });
    await expect(
      repository.createInteraction({
        record: interaction(PRINCIPAL, {
          interactionId: "interaction-2",
          request: {
            ...interaction().request,
            interactionId: "interaction-2",
          },
          createdAt: 50,
          expectedSessionRevision: "2",
        }),
        expectedSessionRevision: "2",
      }),
    ).resolves.toEqual({ ok: false, reason: "already_exists" });
    await expect(
      repository.consumeInteraction({
        principal: PRINCIPAL,
        sessionId: "session-1",
        interactionId: "interaction-1",
        expectedInteractionRevision: "1",
        expectedSessionRevision: "2",
        responseId: "response-invalid",
        decision: "prompt" as "allow",
        consumedAt: 300,
      }),
    ).rejects.toThrow("must be allow or deny");
  });

  it("rejects stale interaction fences and keeps timestamps monotonic", async () => {
    const repository = new InMemoryAgentStateRepository();
    await repository.createSession({ record: session() });
    await repository.saveSession({
      record: session(PRINCIPAL, { updatedAt: 500 }),
      expectedRevision: "1",
      fencingToken: "2",
    });
    await expect(
      repository.createInteraction({
        record: interaction(
          PRINCIPAL,
          {
            expectedSessionRevision: "2",
            createdAt: 200,
          },
          "1",
        ),
        expectedSessionRevision: "2",
        fencingToken: "1",
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "stale_fence",
      currentSessionRevision: "2",
      currentFencingToken: "2",
    });
    await expect(
      repository.createInteraction({
        record: interaction(
          PRINCIPAL,
          {
            expectedSessionRevision: "2",
            createdAt: 200,
          },
          "3",
        ),
        expectedSessionRevision: "2",
        fencingToken: "3",
      }),
    ).resolves.toMatchObject({ ok: true, sessionRevision: "3" });
    await expect(
      repository.readSession({ principal: PRINCIPAL, sessionId: "session-1" }),
    ).resolves.toMatchObject({
      ok: true,
      fencingToken: "3",
      record: { updatedAt: 500 },
    });
    await expect(
      repository.consumeInteraction({
        principal: PRINCIPAL,
        sessionId: "session-1",
        interactionId: "interaction-1",
        expectedInteractionRevision: "1",
        expectedSessionRevision: "3",
        fencingToken: "2",
        responseId: "response-stale-fence",
        decision: "allow",
        consumedAt: 300,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "stale_fence",
      currentFencingToken: "3",
    });
  });

  it("rejects stale fencing tokens and preserves interrupted recovery state", async () => {
    const repository = new InMemoryAgentStateRepository();
    await repository.createSession({ record: session() });
    const running = session(PRINCIPAL, {
      updatedAt: 200,
      runState: { phase: "running", turnId: "turn-1", startedAt: 200 },
    });
    await expect(
      repository.saveSession({
        record: running,
        expectedRevision: "1",
        fencingToken: "2",
      }),
    ).resolves.toEqual({ ok: true, revision: "2" });

    const interrupted = session(PRINCIPAL, {
      updatedAt: 300,
      runState: {
        phase: "interrupted",
        turnId: "turn-1",
        interruptedAt: 300,
        reason: "lease expired",
      },
    });
    await expect(
      repository.saveSession({
        record: interrupted,
        expectedRevision: "2",
        fencingToken: "1",
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "stale_fence",
      currentRevision: "2",
      currentFencingToken: "2",
    });
    await expect(
      repository.saveSession({
        record: interrupted,
        expectedRevision: "2",
        fencingToken: "3",
      }),
    ).resolves.toEqual({ ok: true, revision: "3" });
    await expect(
      repository.readSession({ principal: PRINCIPAL, sessionId: "session-1" }),
    ).resolves.toMatchObject({
      ok: true,
      revision: "3",
      fencingToken: "3",
      record: { runState: { phase: "interrupted", reason: "lease expired" } },
    });
  });
});
