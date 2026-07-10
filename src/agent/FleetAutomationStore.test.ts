import { mkdtemp } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { FleetAutomationStore } from "./FleetAutomationStore.js";

describe("FleetAutomationStore", () => {
  it("persists and executes time and event workflows", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fleet-automation-"));
    const file = path.join(dir, "automations.json");
    const launch = vi.fn().mockResolvedValue(undefined);
    let now = 100;
    const store = new FleetAutomationStore(file, launch, () => now);
    await store.load();
    await store.schedule({
      name: "timer",
      everyMs: 50,
      workflow: { kind: "persistent_goal", task: "T", message: "M" },
    });
    await store.schedule({
      name: "failure hook",
      eventType: "failed",
      workflow: { kind: "structured_diff_review", task: "R", message: "M" },
    });
    now = 151;
    expect(await store.runDue()).toHaveLength(1);
    expect(await store.trigger("failed")).toHaveLength(1);
    expect(launch).toHaveBeenCalledTimes(2);

    const restored = new FleetAutomationStore(file, launch, () => now);
    await restored.load();
    expect(restored.list()).toHaveLength(2);
    expect(restored.history()).toHaveLength(2);
    const first = restored.list()[0];
    expect((await restored.setEnabled(first.id, false)).enabled).toBe(false);
    expect(await restored.remove(first.id)).toBe(true);
    expect(restored.list()).toHaveLength(1);
  });

  it("records failures and applies exponential retry backoff", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fleet-automation-fail-"));
    let now = 100;
    const store = new FleetAutomationStore(
      path.join(dir, "automations.json"),
      vi.fn().mockRejectedValue(new Error("provider unavailable")),
      () => now,
    );
    await store.load();
    const automation = await store.schedule({
      name: "failing",
      everyMs: 10,
      workflow: { kind: "persistent_goal", task: "T", message: "M" },
    });
    now = 111;
    await store.runDue();
    expect(store.list()[0]).toEqual(
      expect.objectContaining({
        failureCount: 1,
        lastError: "provider unavailable",
        nextRunAt: 30_111,
      }),
    );
    expect(store.history(automation.id)[0]).toEqual(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("skips a reentrant event run and records it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fleet-automation-reentrant-"));
    let store: FleetAutomationStore;
    const launch = vi.fn(async () => {
      await store.trigger("changed");
    });
    store = new FleetAutomationStore(
      path.join(dir, "automations.json"),
      launch,
      () => 100,
    );
    await store.load();
    const automation = await store.schedule({
      name: "change hook",
      eventType: "changed",
      workflow: { kind: "persistent_goal", task: "T", message: "M" },
    });

    await store.trigger("changed");

    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.history(automation.id).map((entry) => entry.status)).toEqual([
      "skipped_reentrant",
      "completed",
    ]);
  });
});
