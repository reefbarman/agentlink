import {
  FileAgentStateRepository,
  createFileNodeHostPersistence,
} from "./fileStateRepository.js";
import {
  InMemoryAgentTurnLeaseProvider,
  runAgentSessionRepositoryContract,
  runAgentTurnLeaseProviderContract,
  runHostApprovalContract,
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
    const first = new FileAgentStateRepository({ directory, now: () => 4 });
    const second = new FileAgentStateRepository({ directory, now: () => 4 });
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

    const persisted = await fs.readFile(
      path.join(directory, "agent-state.json"),
      "utf8",
    );
    expect(persisted).toContain("response-a");
    expect(persisted).not.toContain("Approve update");
    expect(persisted).not.toContain('"continuation"');

    await fs.rm(directory, { recursive: true, force: true });
  });

  it("enforces bounded record and byte capacity without damaging committed state", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "node-host-state-"),
    );
    const bounded = new FileAgentStateRepository({
      directory,
      maxSessions: 1,
      maxStateBytes: 1_024,
    });
    await bounded.createSession({ record: session("first") });

    await expect(
      bounded.createSession({ record: session("second") }),
    ).rejects.toMatchObject({
      name: "FileAgentStateCapacityError",
      code: "session_limit",
    });
    await expect(
      bounded.saveSession({
        record: {
          ...session("first"),
          updatedAt: 2,
          messages: [{ role: "user", content: "x".repeat(2_000) }],
        },
        expectedRevision: "1",
      }),
    ).rejects.toMatchObject({
      name: "FileAgentStateCapacityError",
      code: "state_too_large",
    });
    await expect(
      bounded.readSession({ principal, sessionId: "first" }),
    ).resolves.toMatchObject({ ok: true, revision: "1" });

    const oversized = JSON.stringify({
      schemaVersion: 2,
      sessions: {
        '["tenant-a","subject-a","oversized"]': {
          record: {
            ...session("oversized"),
            messages: [{ role: "user", content: "x".repeat(1_025) }],
          },
          revisionNumber: 1,
        },
      },
      interactions: {},
    });
    await fs.writeFile(path.join(directory, "agent-state.json"), oversized, {
      mode: 0o600,
    });
    await expect(
      bounded.readSession({ principal, sessionId: "oversized" }),
    ).resolves.toMatchObject({ ok: true, revision: "1" });

    const recoveryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "node-host-state-"),
    );
    const broad = new FileAgentStateRepository({
      directory: recoveryDirectory,
      maxSessions: 2,
    });
    await broad.createSession({ record: session("keep") });
    await broad.createSession({ record: session("remove") });
    const narrow = new FileAgentStateRepository({
      directory: recoveryDirectory,
      maxSessions: 1,
    });
    await expect(
      narrow.createSession({ record: session("blocked-growth") }),
    ).rejects.toMatchObject({ code: "session_limit" });
    await expect(
      narrow.deleteSession({
        principal,
        sessionId: "remove",
        expectedRevision: "1",
      }),
    ).resolves.toEqual({ ok: true });
    await expect(narrow.listSessions({ principal })).resolves.toHaveLength(1);

    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(recoveryDirectory, { recursive: true, force: true });
  });

  it("prunes only expired consumed-interaction tombstones", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "node-host-state-"),
    );
    let now = 100;
    const repository = new FileAgentStateRepository({
      directory,
      consumedInteractionRetentionMs: 10,
      now: () => now,
    });
    await repository.createSession({ record: session("consumed-session") });
    await repository.createInteraction({
      record: interaction("consumed-session", "consumed-interaction"),
      expectedSessionRevision: "1",
      fencingToken: "1",
    });
    await repository.consumeInteraction({
      principal,
      sessionId: "consumed-session",
      interactionId: "consumed-interaction",
      expectedInteractionRevision: "1",
      expectedSessionRevision: "2",
      fencingToken: "2",
      responseId: "response-a",
      decision: "allow",
      consumedAt: now,
    });
    await repository.createSession({ record: session("pending-session") });
    await repository.createInteraction({
      record: interaction("pending-session", "pending-interaction"),
      expectedSessionRevision: "1",
      fencingToken: "1",
    });

    now = 111;
    await repository.createSession({ record: session("prune-trigger") });
    const raw = JSON.parse(
      await fs.readFile(path.join(directory, "agent-state.json"), "utf8"),
    ) as { interactions: Record<string, unknown> };
    expect(Object.keys(raw.interactions)).not.toContainEqual(
      expect.stringContaining("consumed-interaction"),
    );
    expect(Object.keys(raw.interactions)).toContainEqual(
      expect.stringContaining("pending-interaction"),
    );
    await expect(
      repository.readInteraction({
        principal,
        sessionId: "pending-session",
        interactionId: "pending-interaction",
      }),
    ).resolves.toMatchObject({ ok: true });
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("migrates v1 snapshots, rejects future schemas, and recovers definitely dead local locks", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "node-host-state-"),
    );
    await fs.writeFile(
      path.join(directory, "agent-state.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        sessions: {},
        interactions: {},
      })}\n`,
      { mode: 0o600 },
    );
    const lockPath = path.join(directory, ".agent-state.lock");
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        token: "dead-owner",
        pid: 2_147_483_647,
        hostId: "test-host",
      })}\n`,
      { mode: 0o600 },
    );
    const orphan = path.join(directory, ".agent-state.json.1.orphan.tmp");
    await fs.writeFile(orphan, "orphan", { mode: 0o600 });

    const repository = new FileAgentStateRepository({
      directory,
      lockHostId: "test-host",
    });
    await repository.createSession({ record: session("migrated") });
    const migrated = JSON.parse(
      await fs.readFile(path.join(directory, "agent-state.json"), "utf8"),
    ) as { schemaVersion: number };
    expect(migrated.schemaVersion).toBe(2);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);

    await fs.writeFile(
      path.join(directory, "agent-state.json"),
      `${JSON.stringify({
        schemaVersion: 3,
        sessions: {},
        interactions: {},
      })}\n`,
      { mode: 0o600 },
    );
    await expect(repository.listSessions({ principal })).rejects.toThrow(
      "malformed or unsupported",
    );
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("fails closed rather than reclaiming an ambiguous local lock", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "node-host-state-"),
    );
    await fs.writeFile(
      path.join(directory, ".agent-state.lock"),
      `${JSON.stringify({
        token: "ambiguous-owner",
        pid: 2_147_483_647,
        hostId: "other-host",
      })}\n`,
      { mode: 0o600 },
    );
    const repository = new FileAgentStateRepository({
      directory,
      lockRetryMs: 1,
      maxLockAttempts: 2,
    });

    await expect(
      repository.createSession({ record: session("blocked") }),
    ).rejects.toThrow("File agent state lock is held");
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("persists lease ownership and monotonic fencing across repository restarts", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "node-host-state-"),
    );
    let now = 100;
    let leaseId = 0;
    const first = new FileAgentStateRepository({
      directory,
      now: () => now,
      createLeaseId: () => `lease-${++leaseId}`,
    });
    let sessionId = 0;
    await runAgentTurnLeaseProviderContract({
      provider: first,
      principal,
      otherPrincipal,
      createSessionId: (label) => `${label}-${++sessionId}`,
      advanceTime(milliseconds) {
        now += milliseconds;
      },
    });

    const persistedSession = session("persisted-fence");
    await first.createSession({ record: persistedSession });
    const firstLease = await first.acquireTurnLease({
      principal,
      sessionId: persistedSession.sessionId,
      turnId: "turn-before-restart",
      ownerId: "owner-before-restart",
      ttlMs: 10,
    });
    if (!firstLease.ok) throw new Error("Expected first durable lease");
    const current = await first.readSession({
      principal,
      sessionId: persistedSession.sessionId,
    });
    if (!current.ok) throw new Error("Expected persisted session");
    await first.saveSession({
      record: { ...current.record, updatedAt: 2 },
      expectedRevision: current.revision,
      fencingToken: firstLease.lease.fencingToken,
    });

    now += 10;
    const restarted = new FileAgentStateRepository({
      directory,
      now: () => now,
      createLeaseId: () => `lease-${++leaseId}`,
    });
    const afterRestart = await restarted.acquireTurnLease({
      principal,
      sessionId: persistedSession.sessionId,
      turnId: "turn-after-restart",
      ownerId: "owner-after-restart",
      ttlMs: 10,
    });
    if (!afterRestart.ok) throw new Error("Expected restart takeover lease");
    expect(BigInt(afterRestart.lease.fencingToken)).toBeGreaterThan(
      BigInt(firstLease.lease.fencingToken),
    );
    await expect(
      restarted.saveSession({
        record: { ...current.record, updatedAt: 3 },
        expectedRevision: "2",
        fencingToken: afterRestart.lease.fencingToken,
      }),
    ).resolves.toEqual({ ok: true, revision: "3" });

    await fs.rm(directory, { recursive: true, force: true });
  });

  it("passes the reusable host approval contract across repository restarts", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "node-host-state-"),
    );
    const turnLeases = new InMemoryAgentTurnLeaseProvider({ now: () => 100 });
    let id = 0;

    await expect(
      runHostApprovalContract({
        principal,
        otherPrincipal,
        createPersistence: () => {
          const state = new FileAgentStateRepository({
            directory,
            now: () => 100,
          });
          return { sessions: state, interactions: state, turnLeases };
        },
        createSessionId: (label) => `${label}-${++id}`,
        now: () => 100,
      }),
    ).resolves.toMatchObject({
      allowedWriteCount: 1,
      deniedWriteCount: 0,
      replayRejected: true,
      principalIsolation: true,
      restartResume: true,
    });

    await fs.rm(directory, { recursive: true, force: true });
  });

  it("uses restart-stable local leases by default and permits an explicit distributed override", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "node-host-state-"),
    );
    const local = createFileNodeHostPersistence({ state: { directory } });
    expect(local.sessions).toBe(local.interactions);
    expect(local.turnLeases).toBe(local.sessions);

    const turnLeases = new InMemoryAgentTurnLeaseProvider();
    const overridden = createFileNodeHostPersistence({
      state: { directory },
      turnLeases,
    });
    expect(overridden.sessions).toBe(overridden.interactions);
    expect(overridden.turnLeases).toBe(turnLeases);

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
