import { describe, expect, it } from "vitest";

import { ModelRequestScheduler } from "./modelRequestScheduler.js";

describe("ModelRequestScheduler", () => {
  it("limits requests independently per provider", async () => {
    const scheduler = new ModelRequestScheduler(1);
    const codex = await scheduler.acquire("codex", "background");
    const anthropic = await scheduler.acquire("anthropic", "background");

    expect(codex.queued).toBe(false);
    expect(anthropic.queued).toBe(false);

    codex.release();
    anthropic.release();
  });

  it("admits foreground work before queued background and maintenance work", async () => {
    let now = 100;
    const scheduler = new ModelRequestScheduler(1, () => now);
    const active = await scheduler.acquire("codex", "background");
    const maintenancePromise = scheduler.acquire("codex", "maintenance");
    const backgroundPromise = scheduler.acquire("codex", "background");
    const foregroundPromise = scheduler.acquire("codex", "interactive");

    now = 175;
    active.release();
    const foreground = await foregroundPromise;
    expect(foreground).toMatchObject({ queued: true, waitMs: 75 });

    foreground.release();
    const background = await backgroundPromise;
    background.release();
    const maintenance = await maintenancePromise;
    maintenance.release();
  });

  it("removes aborted queued requests without consuming a permit", async () => {
    const scheduler = new ModelRequestScheduler(1);
    const active = await scheduler.acquire("codex", "interactive");
    const controller = new AbortController();
    const queued = scheduler.acquire("codex", "background", controller.signal);

    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    active.release();

    const next = await scheduler.acquire("codex", "maintenance");
    expect(next.queued).toBe(false);
    next.release();
  });

  it("runs maintenance only while the provider is otherwise idle", async () => {
    const scheduler = new ModelRequestScheduler(2);
    const background = await scheduler.acquire("codex", "background");
    const maintenancePromise = scheduler.acquire("codex", "maintenance");
    let maintenanceStarted = false;
    void maintenancePromise.then(() => {
      maintenanceStarted = true;
    });

    await Promise.resolve();
    expect(maintenanceStarted).toBe(false);
    background.release();

    const maintenance = await maintenancePromise;
    expect(maintenance.queued).toBe(true);
    maintenance.release();
  });

  it("makes permit release idempotent", async () => {
    const scheduler = new ModelRequestScheduler(1);
    const first = await scheduler.acquire("codex", "interactive");
    const secondPromise = scheduler.acquire("codex", "interactive");

    first.release();
    first.release();
    const second = await secondPromise;
    expect(scheduler.hasCapacity("codex")).toBe(false);
    second.release();
    expect(scheduler.hasCapacity("codex")).toBe(true);
  });
});
