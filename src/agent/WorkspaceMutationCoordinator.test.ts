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

  it("coordinates overlapping roots within one agent tree but isolates different trees", async () => {
    const coordinator = new WorkspaceMutationCoordinator();
    const firstTree = coordinator.createDomain(["/tmp/project"], "root-1");
    const sameTree = coordinator.createDomain(["/tmp/project"], "root-1");
    const otherTree = coordinator.createDomain(["/tmp/project"], "root-2");

    const first = await coordinator.acquire("session-1", firstTree);
    let sameTreeResolved = false;
    const queued = coordinator.acquire("session-2", sameTree).then((lease) => {
      sameTreeResolved = true;
      return lease;
    });
    const independent = await coordinator.acquire("session-3", otherTree);

    await Promise.resolve();
    expect(sameTreeResolved).toBe(false);
    await first.markMutation();
    await independent.markMutation();
    expect(first.snapshot("/tmp/project")).toMatchObject({
      generation: 1,
      scopeId: "root-1",
    });
    expect(independent.snapshot("/tmp/project")).toMatchObject({
      generation: 1,
      scopeId: "root-2",
    });
    expect(
      coordinator.findConflict(
        "/tmp/project",
        first.snapshot("/tmp/project"),
        "root-1",
      ),
    ).toBeUndefined();

    first.release();
    const sameTreeLease = await queued;
    sameTreeLease.release();
    independent.release();
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

  it("admits a path-delegated writer alongside the unrestricted tree writer", async () => {
    const coordinator = new WorkspaceMutationCoordinator();
    const treeDomain = coordinator.createDomain(["/tmp/project"], "root-1");
    const delegatedDomain = coordinator.createDomain(["/tmp/project"], {
      scopeId: "root-1",
      delegatedPaths: ["/tmp/project/src/feature.test.ts"],
    });

    const treeLease = await coordinator.acquire("session-parent", treeDomain);
    const delegatedLease = await coordinator.acquire(
      "session-child",
      delegatedDomain,
    );
    expect(delegatedLease.sessionId).toBe("session-child");

    delegatedLease.release();
    treeLease.release();
  });

  it("serializes delegated writers with overlapping paths and admits disjoint ones", async () => {
    const coordinator = new WorkspaceMutationCoordinator();
    const first = coordinator.createDomain(["/tmp/project"], {
      scopeId: "root-1",
      delegatedPaths: ["/tmp/project/src/agent"],
    });
    const overlapping = coordinator.createDomain(["/tmp/project"], {
      scopeId: "root-1",
      delegatedPaths: ["/tmp/project/src/agent/tools/adapter.ts"],
    });
    const disjoint = coordinator.createDomain(["/tmp/project"], {
      scopeId: "root-1",
      delegatedPaths: ["/tmp/project/src/util"],
    });

    const firstLease = await coordinator.acquire("session-1", first);
    let overlappingResolved = false;
    const queued = coordinator
      .acquire("session-2", overlapping)
      .then((lease) => {
        overlappingResolved = true;
        return lease;
      });
    const disjointLease = await coordinator.acquire("session-3", disjoint);

    await Promise.resolve();
    expect(overlappingResolved).toBe(false);

    firstLease.release();
    const overlappingLease = await queued;
    overlappingLease.release();
    disjointLease.release();
  });

  it("blocks delegated writers behind an exclusive checkpoint domain", async () => {
    const coordinator = new WorkspaceMutationCoordinator();
    const delegated = coordinator.createDomain(["/tmp/project"], {
      scopeId: "root-1",
      delegatedPaths: ["/tmp/project/src/feature.test.ts"],
    });
    const exclusive = coordinator.createDomain(["/tmp/project"], {
      scopeId: "root-1",
      exclusive: true,
    });

    const delegatedLease = await coordinator.acquire("session-1", delegated);
    let exclusiveResolved = false;
    const queuedExclusive = coordinator
      .acquire("session-2", exclusive)
      .then((lease) => {
        exclusiveResolved = true;
        return lease;
      });
    await Promise.resolve();
    expect(exclusiveResolved).toBe(false);

    delegatedLease.release();
    const exclusiveLease = await queuedExclusive;

    let delegatedBlocked = true;
    const queuedDelegated = coordinator
      .acquire("session-3", delegated)
      .then((lease) => {
        delegatedBlocked = false;
        return lease;
      });
    await Promise.resolve();
    expect(delegatedBlocked).toBe(true);
    exclusiveLease.release();
    (await queuedDelegated).release();
  });

  it("advances the generation on every delegated mutation so checkpoints stay conflict-aware", async () => {
    const coordinator = new WorkspaceMutationCoordinator(undefined, {
      createEpoch: () => "epoch-1",
    });
    const delegated = coordinator.createDomain(["/tmp/project"], {
      scopeId: "root-1",
      delegatedPaths: ["/tmp/project/src/feature.test.ts"],
    });
    const lease = await coordinator.acquire("session-child", delegated);

    await lease.markMutation();
    const checkpoint = coordinator.getSnapshot(
      "/tmp/project",
      "session-parent",
      "root-1",
    );
    expect(
      coordinator.findConflict("/tmp/project", checkpoint, "root-1"),
    ).toBeUndefined();

    await lease.markMutation();
    expect(
      coordinator.findConflict("/tmp/project", checkpoint, "root-1"),
    ).toMatchObject({
      conflictingSessionId: "session-child",
      conflictingGeneration: 2,
    });
    lease.release();
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
