import type {
  FleetAutomation,
  FleetAutomationRun,
} from "./FleetAutomationStore.js";

import type { FleetWorkflowRequest } from "./FleetWorkflows.js";

interface FleetAutomationStoreTarget {
  load(): Promise<void>;
  schedule(input: FleetAutomationScheduleInput): Promise<FleetAutomation>;
  trigger(eventType: string): Promise<string[]>;
  runDue(): Promise<string[]>;
  list(): FleetAutomation[];
  history(automationId?: string): FleetAutomationRun[];
  setEnabled(id: string, enabled: boolean): Promise<FleetAutomation>;
  remove(id: string): Promise<boolean>;
}

interface FleetEventSource {
  addFleetEventListener(
    listener: (sessionId: string, event: { type: string }) => void,
  ): () => void;
}

export interface FleetAutomationScheduleInput {
  name: string;
  workflow: FleetWorkflowRequest;
  everyMs?: number;
  eventType?: string;
}

export interface FleetAutomationManageInput {
  action: "list" | "history" | "enable" | "disable" | "delete";
  id?: string;
}

export interface FleetAutomationLifecycle {
  schedule(input: FleetAutomationScheduleInput): Promise<FleetAutomation>;
  manage(
    input: FleetAutomationManageInput,
  ): Promise<
    | FleetAutomation[]
    | FleetAutomationRun[]
    | FleetAutomation
    | { removed: boolean }
  >;
  dispose(): void;
}

export interface FleetAutomationLifecycleDependencies {
  store: FleetAutomationStoreTarget;
  events: FleetEventSource;
  log(message: string): void;
  intervalMs?: number;
  setIntervalFn?: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void;
}

export function createFleetAutomationLifecycle({
  store,
  events,
  log,
  intervalMs = 30_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}: FleetAutomationLifecycleDependencies): FleetAutomationLifecycle {
  const ready = store.load();
  const removeEventListener = events.addFleetEventListener(
    (_sessionId, event) => {
      void ready
        .then(() => store.trigger(event.type))
        .catch((error) =>
          log(`[fleet-automation] event trigger failed: ${String(error)}`),
        );
    },
  );
  const timer = setIntervalFn(() => {
    void ready
      .then(() => store.runDue())
      .catch((error) =>
        log(`[fleet-automation] scheduled run failed: ${String(error)}`),
      );
  }, intervalMs);

  return {
    async schedule(input) {
      await ready;
      return store.schedule(input);
    },
    async manage({ action, id }) {
      await ready;
      if (action === "list") return store.list();
      if (action === "history") return store.history(id);
      if (!id) throw new Error(`${action} requires an automation id`);
      if (action === "enable") return store.setEnabled(id, true);
      if (action === "disable") return store.setEnabled(id, false);
      return { removed: await store.remove(id) };
    },
    dispose() {
      clearIntervalFn(timer);
      removeEventListener();
    },
  };
}
