import {
  FileAgentStateRepository,
  createFileNodeHostPersistence,
} from "./fileStateRepository.js";
import {
  InMemoryAgentTurnLeaseProvider,
  runAgentSessionRepositoryContract,
  type DurableToolInteractionRecord,
} from "@agentlink/core";
import { describe, expect, it } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const principal = { tenantId: "tenant-a", subjectId: "subject-a" };
const otherPrincipal = { tenantId: "tenant-a", subjectId: "subject-b" };

function session(sessionId: string) {
  return {
    schemaVersion: 1 as const,
    principal,
    sessionId,
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    runState: { phase: "idle" as const },
  };
}

function interaction(
  sessionId: string,
  interactionId: string,
): DurableToolInteractionRecord {
  return {
    schemaVersion: 1,
    interactionId,
    state: "pending",
    principal,
    sessionId,
    turnId: "turn-a",
    expectedSessionRevision: "1",
    createdAt: 2,
    request: {
      interactionId,
      kind: "tool_authorization",
      summary: "Approve update",
      toolCallId: "call-a",
      toolName: "update",
      effect: "write",
    },
    continuation: {
      prepared: {
        request: {
          principal,
          sessionId,
          input: { text: "update", attachments: undefined },
          model: undefined,
        },
        turnId: "turn-a",
        history: [],
        sessionModel: undefined,
        runtimeDefaultModel: undefined,
        systemPrompt: "test",
        maxOutputTokens: 1,
        reasoningEffort: undefined,
        limits: undefined,
        sessionRevision: "1",
        turnFencingToken: "1",
      },
      iterationMessages: [],
      pendingToolCalls: [],
      reservedToolCalls: [],
      authorizedToolCallIds: [],
      model: {
        model: { providerId: "fixture", modelId: "fixture-model" },
        source: "runtime",
      },
      execution: {
        limits: {
          maxModelCalls: 0,
          maxToolCalls: 0,
          maxElapsedMs: 0,
          maxToolResultBytes: 0,
        },
        modelCalls: 0,
        toolCalls: 0,
        elapsedMs: 0,
        toolResultBytes: 0,
      },
      nextSequence: 1,
    },
  };
}

describe("file agent state repository", () => {
  it("satisfies the core session adapter contract with durable cross-instance CAS", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "node-host-state-"),
    );
    const first = new FileAgentStateRepository({ directory });
    const second = new FileAgentStateRepository({ directory });
    let id = 0;

    await runAgentSessionRepositoryContract({
      repository: first,
      principal,
      otherPrincipal,
      createSessionId: (label) => `${label}-${++id}`,
      now: () => 100,
    });

    const record = session("shared-session");
    const created = await first.createSession({ record });
    expect(created).toEqual({ ok: true, revision: "1" });
    const current = await second.readSession({
      principal,
      sessionId: record.sessionId,
    });
    if (!current.ok) throw new Error("Expected durable session");
    const saved = await second.saveSession({
      record: { ...current.record, updatedAt: 2 },
      expectedRevision: current.revision,
      fencingToken: "2",
    });
    expect(saved).toEqual({ ok: true, revision: "2" });
    await expect(
      first.saveSession({
        record: { ...record, updatedAt: 3 },
        expectedRevision: "1",
        fencingToken: "1",
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "revision_conflict",
      currentRevision: "2",
    });

    const stateFile = await fs.stat(path.join(directory, "agent-state.json"));
    expect(stateFile.mode & 0o777).toBe(0o600);

    await fs.rm(directory, { recursive: true, force: true });
  });

  it("atomically persists and single-use consumes principal-scoped interactions", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "node-host-state-"),
    );
    const first = new FileAgentStateRepository({ directory });
    const second = new FileAgentStateRepository({ directory });
    const sessionId = "interaction-session";
    const record = interaction(sessionId, "interaction-a");
    await first.createSession({ record: session(sessionId) });

    await expect(
      first.createInteraction({
        record,
        expectedSessionRevision: "1",
        fencingToken: "1",
      }),
    ).resolves.toEqual({
      ok: true,
      interactionRevision: "1",
      sessionRevision: "2",
    });
    await expect(
      second.readInteraction({
        principal: otherPrincipal,
        sessionId,
        interactionId: record.interactionId,
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    const pending = await second.readInteraction({
      principal,
      sessionId,
      interactionId: record.interactionId,
    });
    if (!pending.ok) throw new Error("Expected persisted interaction");
    await expect(
      second.consumeInteraction({
        principal,
        sessionId,
        interactionId: record.interactionId,
        expectedInteractionRevision: pending.interactionRevision,
        expectedSessionRevision: pending.sessionRevision,
        fencingToken: "2",
        responseId: "response-a",
        decision: "allow",
        consumedAt: 3,
      }),
    ).resolves.toEqual({ ok: true, sessionRevision: "3" });
    await expect(
      first.consumeInteraction({
        principal,
        sessionId,
        interactionId: record.interactionId,
        expectedInteractionRevision: "1",
        expectedSessionRevision: "2",
        fencingToken: "1",
        responseId: "response-b",
        decision: "allow",
        consumedAt: 4,
      }),
    ).resolves.toEqual({ ok: false, reason: "consumed" });

    await fs.rm(directory, { recursive: true, force: true });
  });

  it("pairs one durable state repository with an explicitly host-supplied lease provider", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "node-host-state-"),
    );
    const turnLeases = new InMemoryAgentTurnLeaseProvider();
    const persistence = createFileNodeHostPersistence({
      state: { directory },
      turnLeases,
    });

    expect(persistence.sessions).toBe(persistence.interactions);
    expect(persistence.turnLeases).toBe(turnLeases);

    await fs.rm(directory, { recursive: true, force: true });
  });
});
