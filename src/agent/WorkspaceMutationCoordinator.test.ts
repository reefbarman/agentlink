import { describe, expect, it, vi } from "vitest";

import {
  WORKSPACE_MUTATION_STATE_KEY,
  WorkspaceMutationCoordinator,
  type WorkspaceMutationStateStore,
} from "./WorkspaceMutationCoordinator.js";

function createStore(initial?: unknown): WorkspaceMutationStateStore & {
  values: Map<string, unknown>;
} {
  const values = new Map<string, unknown>();
  if (initial !== undefined) values.set(WORKSPACE_MUTATION_STATE_KEY, initial);
  return {
    values,
    get: vi.fn((key: string) =>
      values.get(key),
    ) as WorkspaceMutationStateStore["get"],
    update: vi.fn(async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    }),
  };
}

describe("WorkspaceMutationCoordinator", () => {
  it("serializes overlapping domains in FIFO order while admitting disjoint roots", async () => {
    const coordinator = new WorkspaceMutationCoordinator(undefined, {
      createEpoch: () => "epoch-1",
    });
    const rootA = coordinator.createDomain(["/tmp/project-a"]);
    const rootAB = coordinator.createDomain([
      "/tmp/project-a",
      "/tmp/project-b",
    ]);
    const rootB = coordinator.createDomain(["/tmp/project-b"]);
    const rootC = coordinator.createDomain(["/tmp/project-c"]);

    const first = await coordinator.acquire("session-1", rootA);
    let secondResolved = false;
    const second = coordinator.acquire("session-2", rootAB).then((lease) => {
      secondResolved = true;
      return lease;
    });
    let thirdResolved = false;
    const third = coordinator.acquire("session-3", rootB).then((lease) => {
      thirdResolved = true;
      return lease;
    });
    const disjoint = await coordinator.acquire("session-4", rootC);

    await Promise.resolve();
    expect(secondResolved).toBe(false);
    expect(thirdResolved).toBe(false);

    first.release();
    const secondLease = await second;
    expect(secondResolved).toBe(true);
    expect(thirdResolved).toBe(false);

    secondLease.release();
    const thirdLease = await third;
    expect(thirdResolved).toBe(true);

    thirdLease.release();
    disjoint.release();
  });

  it("removes an aborted waiter without blocking the next request", async () => {
    const coordinator = new WorkspaceMutationCoordinator();
    const domain = coordinator.createDomain(["/tmp/project"]);
    const active = await coordinator.acquire("session-1", domain);
    const controller = new AbortController();
    const aborted = coordinator.acquire("session-2", domain, controller.signal);
    const next = coordinator.acquire("session-3", domain);

    controller.abort();
    await expect(aborted).rejects.toThrow("workspace_mutation_lease_aborted");
    active.release();

    const nextLease = await next;
    expect(nextLease.sessionId).toBe("session-3");
    nextLease.release();
  });

  it("advances each covered root once per lease and persists session ownership", async () => {
    const store = createStore();
    const coordinator = new WorkspaceMutationCoordinator(store, {
      createEpoch: () => "epoch-1",
    });
    const domain = coordinator.createDomain([
      "/tmp/project-b",
      "/tmp/project-a",
    ]);
    const lease = await coordinator.acquire("session-1", domain);

    const first = await lease.markMutation();
    const second = await lease.markMutation();
    expect(second).toBe(first);
    expect([...first.values()]).toEqual([
      { epoch: "epoch-1", generation: 1, ownerSessionId: "session-1" },
      { epoch: "epoch-1", generation: 1, ownerSessionId: "session-1" },
    ]);
    await coordinator.whenPersisted();

    const persisted = store.values.get(WORKSPACE_MUTATION_STATE_KEY) as {
      epoch: string;
      roots: Record<
        string,
        {
          generation: number;
          latestGenerationBySession: Record<string, number>;
        }
      >;
    };
    expect(persisted.epoch).toBe("epoch-1");
    expect(Object.values(persisted.roots)).toEqual([
      {
        generation: 1,
        latestGenerationBySession: { "session-1": 1 },
      },
      {
        generation: 1,
        latestGenerationBySession: { "session-1": 1 },
      },
    ]);
    lease.release();
  });

  it("restores generations and detects later mutations by another session", async () => {
    const store = createStore();
    const firstCoordinator = new WorkspaceMutationCoordinator(store, {
      createEpoch: () => "epoch-1",
    });
    const domain = firstCoordinator.createDomain(["/tmp/project"]);
    const firstLease = await firstCoordinator.acquire("session-1", domain);
    await firstLease.markMutation();
    const checkpoint = firstLease.snapshot("/tmp/project");
    firstLease.release();
    await firstCoordinator.whenPersisted();

    const restored = new WorkspaceMutationCoordinator(store, {
      createEpoch: () => "unexpected-epoch",
    });
    expect(restored.findConflict("/tmp/project", checkpoint)).toBeUndefined();

    const secondLease = await restored.acquire("session-2", domain);
    await secondLease.markMutation();
    secondLease.release();

    expect(restored.findConflict("/tmp/project", checkpoint)).toMatchObject({
      checkpoint,
      currentEpoch: "epoch-1",
      currentGeneration: 2,
      conflictingSessionId: "session-2",
      conflictingGeneration: 2,
    });
  });

  it("fails closed when checkpoint epoch differs from current durable state", () => {
    const coordinator = new WorkspaceMutationCoordinator(undefined, {
      createEpoch: () => "epoch-new",
    });
    expect(
      coordinator.findConflict("/tmp/project", {
        epoch: "epoch-old",
        generation: 10,
        ownerSessionId: "session-1",
      }),
    ).toMatchObject({
      currentEpoch: "epoch-new",
      currentGeneration: 0,
    });
  });
});
