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
  });
});
