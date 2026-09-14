import { describe, expect, it } from "vitest";

import { WorkspaceMutationCoordinator } from "./mutationCoordinator.js";

describe("WorkspaceMutationCoordinator", () => {
  it("admits parallel commits and waits for all of them before exclusivity", async () => {
    const coordinator = new WorkspaceMutationCoordinator();
    const first = await coordinator.acquireCommit();
    const second = await coordinator.acquireCommit();
    let exclusiveResolved = false;
    const exclusive = coordinator.acquireExclusive().then((lease) => {
      exclusiveResolved = true;
      return lease;
    });

    await Promise.resolve();
    expect(exclusiveResolved).toBe(false);
    first.release();
    await Promise.resolve();
    expect(exclusiveResolved).toBe(false);
    second.release();
    (await exclusive).release();
  });

  it("does not admit later commits ahead of a queued exclusive operation", async () => {
    const coordinator = new WorkspaceMutationCoordinator();
    const active = await coordinator.acquireCommit();
    const order: string[] = [];
    const exclusive = coordinator.acquireExclusive().then((lease) => {
      order.push("exclusive");
      return lease;
    });
    const laterCommit = coordinator.acquireCommit().then((lease) => {
      order.push("commit");
      return lease;
    });

    active.release();
    const exclusiveLease = await exclusive;
    expect(order).toEqual(["exclusive"]);
    exclusiveLease.release();
    (await laterCommit).release();
    expect(order).toEqual(["exclusive", "commit"]);
  });

  it("releases exclusivity while awaiting approval and reacquires it before execution continues", async () => {
    const coordinator = new WorkspaceMutationCoordinator();
    let releaseApproval!: () => void;
    const approval = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    let enteredApproval = false;
    let resumedExclusive = false;
    const operation = coordinator.withExclusive(async () => {
      await coordinator.outsideExclusive(async () => {
        enteredApproval = true;
        await approval;
      });
      resumedExclusive = true;
    });

    while (!enteredApproval) await Promise.resolve();
    const commit = await coordinator.acquireCommit();
    releaseApproval();
    await Promise.resolve();
    expect(resumedExclusive).toBe(false);
    commit.release();
    await operation;
    expect(resumedExclusive).toBe(true);
  });

  it("removes a cancelled waiter without blocking the queue", async () => {
    const coordinator = new WorkspaceMutationCoordinator();
    const active = await coordinator.acquireExclusive();
    const controller = new AbortController();
    const cancelled = coordinator.acquireCommit(controller.signal);
    const next = coordinator.acquireExclusive();

    controller.abort();
    await expect(cancelled).rejects.toThrow(
      "workspace_mutation_wait_cancelled",
    );
    active.release();
    (await next).release();
  });
});
