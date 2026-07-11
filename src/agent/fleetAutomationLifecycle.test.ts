import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFleetAutomationLifecycle,
  type FleetAutomationLifecycleDependencies,
} from "./fleetAutomationLifecycle.js";

function createDependencies() {
  let eventListener:
    | ((sessionId: string, event: { type: string }) => void)
    | undefined;
  let intervalCallback: (() => void) | undefined;
  const removeEventListener = vi.fn();
  const store = {
    load: vi.fn(async () => {}),
    schedule: vi.fn(async (input) => ({
      id: "automation-1",
      enabled: true,
      ...input,
    })),
    trigger: vi.fn(async () => []),
    runDue: vi.fn(async () => []),
    list: vi.fn(() => []),
    history: vi.fn(() => []),
    setEnabled: vi.fn(async (id, enabled) => ({
      id,
      name: "Automation",
      workflow: {
        kind: "persistent_goal" as const,
        task: "task",
        message: "message",
      },
      enabled,
    })),
    remove: vi.fn(async () => true),
  } satisfies FleetAutomationLifecycleDependencies["store"];
  const dependencies: FleetAutomationLifecycleDependencies = {
    store,
    events: {
      addFleetEventListener: vi.fn((listener) => {
        eventListener = listener;
        return removeEventListener;
      }),
    },
    log: vi.fn(),
    setIntervalFn: vi.fn((callback) => {
      intervalCallback = callback;
      return 42 as unknown as ReturnType<typeof setInterval>;
    }),
    clearIntervalFn: vi.fn(),
  };
  return {
    dependencies,
    store,
    removeEventListener,
    event: (type: string) => eventListener?.("session-1", { type }),
    tick: () => intervalCallback?.(),
  };
}

async function waitForCalls(mock: ReturnType<typeof vi.fn>, count: number) {
  await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(count));
}

describe("createFleetAutomationLifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loads immediately and waits for readiness before scheduling", async () => {
    const setup = createDependencies();
    let resolveLoad: (() => void) | undefined;
    setup.store.load.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const lifecycle = createFleetAutomationLifecycle(setup.dependencies);
    const input = {
      name: "Nightly",
      workflow: {
        kind: "persistent_goal" as const,
        task: "task",
        message: "message",
      },
      everyMs: 60_000,
    };

    const scheduled = lifecycle.schedule(input);
    expect(setup.store.load).toHaveBeenCalledOnce();
    expect(setup.store.schedule).not.toHaveBeenCalled();

    resolveLoad?.();
    await expect(scheduled).resolves.toEqual(
      expect.objectContaining({ id: "automation-1", name: "Nightly" }),
    );
    expect(setup.store.schedule).toHaveBeenCalledWith(input);
  });

  it("triggers event and scheduled automations after loading", async () => {
    const setup = createDependencies();
    createFleetAutomationLifecycle(setup.dependencies);

    setup.event("done");
    setup.tick();
    await waitForCalls(setup.store.trigger, 1);
    await waitForCalls(setup.store.runDue, 1);

    expect(setup.store.trigger).toHaveBeenCalledWith("done");
    expect(setup.store.runDue).toHaveBeenCalledOnce();
    expect(setup.dependencies.setIntervalFn).toHaveBeenCalledWith(
      expect.any(Function),
      30_000,
    );
  });

  it.each([
    ["list", undefined, "list", []],
    ["history", "automation-1", "history", ["automation-1"]],
    ["enable", "automation-1", "setEnabled", ["automation-1", true]],
    ["disable", "automation-1", "setEnabled", ["automation-1", false]],
    ["delete", "automation-1", "remove", ["automation-1"]],
  ] as const)("dispatches %s management", async (action, id, method, args) => {
    const setup = createDependencies();
    const lifecycle = createFleetAutomationLifecycle(setup.dependencies);

    const result = await lifecycle.manage({ action, id });

    expect(setup.store[method]).toHaveBeenCalledWith(...args);
    if (action === "delete") expect(result).toEqual({ removed: true });
  });

  it.each(["enable", "disable", "delete"] as const)(
    "requires an id for %s",
    async (action) => {
      const lifecycle = createFleetAutomationLifecycle(
        createDependencies().dependencies,
      );
      await expect(lifecycle.manage({ action })).rejects.toThrow(
        `${action} requires an automation id`,
      );
    },
  );

  it("logs event and scheduled failures with their original prefixes", async () => {
    const setup = createDependencies();
    setup.store.trigger.mockRejectedValue(new Error("event failed"));
    setup.store.runDue.mockRejectedValue(new Error("timer failed"));
    createFleetAutomationLifecycle(setup.dependencies);

    setup.event("error");
    setup.tick();
    await waitForCalls(setup.dependencies.log as ReturnType<typeof vi.fn>, 2);

    expect(setup.dependencies.log).toHaveBeenCalledWith(
      "[fleet-automation] event trigger failed: Error: event failed",
    );
    expect(setup.dependencies.log).toHaveBeenCalledWith(
      "[fleet-automation] scheduled run failed: Error: timer failed",
    );
  });

  it("clears the timer and removes the event listener on disposal", () => {
    const setup = createDependencies();
    const lifecycle = createFleetAutomationLifecycle(setup.dependencies);

    lifecycle.dispose();

    expect(setup.dependencies.clearIntervalFn).toHaveBeenCalledWith(42);
    expect(setup.removeEventListener).toHaveBeenCalledOnce();
  });
});
