import { describe, expect, it } from "vitest";

import {
  SessionEventHub,
  type AssistantSessionEvent,
} from "./SessionEventHub.js";
import { createSessionWatch, type SessionAlert } from "./sessionWatch.js";
import {
  createAssistantWorkspaceRoutes,
  parseSessionKey,
} from "./workspaceRoutes.js";

const MINUTE = 60_000;

const started = (taskId = "t1"): AssistantSessionEvent =>
  ({
    kind: "task",
    state: "started",
    taskId,
    operation: "turn",
    actor: "owner",
  }) as unknown as AssistantSessionEvent;
const finished = (taskId = "t1"): AssistantSessionEvent => ({
  kind: "task",
  state: "finished",
  taskId,
  status: "completed",
});
const turn = (event: Record<string, unknown>): AssistantSessionEvent =>
  ({ kind: "turn", event }) as unknown as AssistantSessionEvent;
const toolStarted = (toolName: string, displayInput: unknown) =>
  turn({ type: "tool.started", toolCallId: "c", toolName, displayInput });

function harness() {
  const clock = { value: 1_000_000 };
  const alerts: SessionAlert[] = [];
  const watch = createSessionWatch({
    now: () => clock.value,
    onAlert: (alert) => alerts.push(alert),
    longRunningMs: 120 * MINUTE,
    repeatLimit: 3,
    quietMs: 30 * MINUTE,
    stretchGapMs: 2 * MINUTE,
  });
  return { clock, alerts, watch };
}

describe("watching the event hub", () => {
  it("sees every session's events through observe, as the service wires it", () => {
    const hub = new SessionEventHub();
    const { alerts, watch } = harness();
    const stop = hub.observe((key, { event }) => {
      const session = parseSessionKey(key);
      if (session) watch.observe(session.projectId, session.sessionId, event);
    });
    const routes = createAssistantWorkspaceRoutes({
      projects: [],
      authorizeProject: () => false,
      models: {
        available: [{ providerId: "p", modelId: "m" }],
        defaultModel: { providerId: "p", modelId: "m" },
      },
    });
    const key = routes.operations.sessionKey("task-t1", "chat-7");
    hub.publish(key, started());
    for (let index = 0; index < 3; index += 1) {
      hub.publish(key, toolStarted("execute_command", { command: "ls" }));
    }
    expect(alerts).toEqual([
      expect.objectContaining({
        projectId: "task-t1",
        sessionId: "chat-7",
        kind: "repeating",
      }),
    ]);
    stop();
    hub.publish(key, toolStarted("execute_command", { command: "ls" }));
    expect(alerts).toHaveLength(1);
    expect(parseSessionKey("no-separator")).toBeUndefined();
  });
});

describe("createSessionWatch", () => {
  it("says a session is still working once per period, never stopping it", () => {
    const { clock, alerts, watch } = harness();
    watch.observe("home", "s1", started());
    // Auto Continue: a new turn right after the last keeps the stretch.
    for (let index = 0; index < 13; index += 1) {
      clock.value += 10 * MINUTE;
      watch.observe("home", "s1", turn({ type: "text.delta", text: "…" }));
      watch.observe("home", "s1", finished());
      clock.value += 30_000;
      watch.observe("home", "s1", started(`t${index}`));
      watch.tick();
    }
    expect(alerts).toEqual([
      expect.objectContaining({
        projectId: "home",
        sessionId: "s1",
        kind: "long_running",
      }),
    ]);
    expect(alerts[0]!.elapsedMs).toBeGreaterThanOrEqual(120 * MINUTE);

    // Keep going: the next one waits another full period.
    watch.keepGoing("home", "s1");
    clock.value += 119 * MINUTE;
    watch.observe("home", "s1", turn({ type: "text.delta", text: "…" }));
    watch.tick();
    expect(alerts).toHaveLength(1);
    clock.value += 2 * MINUTE;
    watch.observe("home", "s1", turn({ type: "text.delta", text: "…" }));
    watch.tick();
    expect(alerts.map((alert) => alert.kind)).toEqual([
      "long_running",
      "long_running",
    ]);
  });

  it("starts a new stretch after the session was idle", () => {
    const { clock, alerts, watch } = harness();
    watch.observe("home", "s1", started());
    clock.value += 100 * MINUTE;
    watch.observe("home", "s1", finished());
    clock.value += 5 * MINUTE;
    watch.tick();
    expect(watch.activeCount()).toBe(0);
    watch.observe("home", "s1", started("t2"));
    clock.value += 30 * MINUTE;
    watch.observe("home", "s1", turn({ type: "text.delta", text: "…" }));
    watch.tick();
    expect(alerts).toEqual([]);
  });

  it("flags the same call with the same input repeated, once", () => {
    const { alerts, watch } = harness();
    watch.observe("home", "s1", started());
    const call = () =>
      watch.observe(
        "home",
        "s1",
        toolStarted("execute_command", { command: "npm test", cwd: "." }),
      );
    call();
    call();
    // Same input, keys in another order.
    watch.observe(
      "home",
      "s1",
      toolStarted("execute_command", { cwd: ".", command: "npm test" }),
    );
    call();
    expect(alerts).toEqual([
      expect.objectContaining({
        kind: "repeating",
        toolName: "execute_command",
        repeats: 3,
      }),
    ]);
    // Something else in between starts the count again.
    watch.observe("home", "s1", toolStarted("read_file", { path: "a" }));
    call();
    call();
    expect(alerts).toHaveLength(1);
    call();
    expect(alerts).toHaveLength(2);
  });

  it("does not count waiting on background agents as repeating", () => {
    const { alerts, watch } = harness();
    watch.observe("home", "s1", started());
    for (let index = 0; index < 10; index += 1) {
      watch.observe(
        "home",
        "s1",
        toolStarted("get_background_result", { sessionId: "child" }),
      );
    }
    expect(alerts).toEqual([]);
  });

  it("flags a working session that has gone quiet, but not one waiting for the owner", () => {
    const { clock, alerts, watch } = harness();
    watch.observe("home", "s1", started());
    watch.observe("home", "s2", started());
    watch.observe(
      "home",
      "s2",
      turn({ type: "interaction.required", interaction: {} }),
    );
    clock.value += 31 * MINUTE;
    watch.tick();
    watch.tick();
    expect(alerts).toEqual([
      expect.objectContaining({ sessionId: "s1", kind: "quiet" }),
    ]);
    // New output, then quiet again: another alert.
    watch.observe("home", "s1", turn({ type: "tool.completed" }));
    clock.value += 31 * MINUTE;
    watch.tick();
    expect(alerts.filter((alert) => alert.kind === "quiet")).toHaveLength(2);
  });
});
