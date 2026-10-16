import { afterEach, describe, expect, it, vi } from "vitest";

import { createTaskEditors, type TaskEditors } from "./taskEditors.js";
import type { TaskRun } from "./taskStore.js";

const task = (id = "0123456789ab") =>
  ({
    id,
    workspace: `/srv/agentlink/projects/.tasks/${id}/repo`,
  }) as TaskRun;

function fakeManager() {
  const started: Array<{
    id: string;
    folder: string;
    mode: string;
    proxy?: string;
  }> = [];
  const stopped: string[] = [];
  let stopAll = 0;
  return {
    started,
    stopped,
    get stopAllCalls() {
      return stopAll;
    },
    manager: {
      startEditor: vi.fn(
        async (request: {
          id: string;
          folder: string;
          mode: "ro" | "rw";
          proxy?: string;
        }) => {
          started.push({ ...request });
          return { url: `http://agentlink-editor-${request.id}:8080` };
        },
      ),
      stopEditor: vi.fn(async (id: string) => {
        stopped.push(id);
        return {};
      }),
      stopAllEditors: vi.fn(async () => {
        stopAll += 1;
        return { stopped: 0 };
      }),
    },
  };
}

describe("task editors", () => {
  let editors: TaskEditors | undefined;
  afterEach(async () => {
    vi.useRealTimers();
    await editors?.close();
    editors = undefined;
  });

  it("starts an editor on the task's folder and waits until it answers", async () => {
    const fake = fakeManager();
    const ready = vi.fn(async () => undefined);
    editors = createTaskEditors({
      manager: fake.manager,
      proxyUrl: () => "http://u:p@egress-gateway:3128",
      ready,
    });
    await editors.open(task(), "ro");
    expect(fake.started).toEqual([
      {
        id: "task-0123456789ab",
        folder: "/srv/agentlink/projects/.tasks/0123456789ab",
        mode: "ro",
        proxy: "http://u:p@egress-gateway:3128",
      },
    ]);
    expect(ready).toHaveBeenCalledWith(
      "http://agentlink-editor-task-0123456789ab:8080",
    );
    expect(editors.running("0123456789ab")).toEqual({ mode: "ro" });
    // The same mode again reuses it; another mode restarts it.
    await editors.open(task(), "ro");
    expect(fake.started).toHaveLength(1);
    await editors.open(task(), "rw");
    expect(fake.started.map((entry) => entry.mode)).toEqual(["ro", "rw"]);
  });

  it("redeems a link once, for that task's editor only", async () => {
    const fake = fakeManager();
    editors = createTaskEditors({ manager: fake.manager });
    const { token } = await editors.open(task(), "ro");
    const redeemed = editors.redeem(token);
    expect(redeemed?.taskId).toBe("0123456789ab");
    expect(editors.redeem(token)).toBeUndefined();
    expect(editors.authorize("0123456789ab", redeemed!.session)).toBe(
      "http://agentlink-editor-task-0123456789ab:8080",
    );
    // Not for another task, nor without or with a wrong session.
    await editors.open(task("ba9876543210"), "ro");
    expect(
      editors.authorize("ba9876543210", redeemed!.session),
    ).toBeUndefined();
    expect(editors.authorize("0123456789ab", undefined)).toBeUndefined();
    expect(editors.authorize("0123456789ab", "nope")).toBeUndefined();
  });

  it("expires links after two minutes and ends sessions when the editor stops", async () => {
    let now = 1_000;
    const fake = fakeManager();
    editors = createTaskEditors({ manager: fake.manager, now: () => now });
    const late = await editors.open(task(), "ro");
    now += 2 * 60_000 + 1;
    expect(editors.redeem(late.token)).toBeUndefined();
    const { token } = await editors.open(task(), "ro");
    const { session } = editors.redeem(token)!;
    await editors.stop("0123456789ab");
    expect(fake.stopped).toEqual(["task-0123456789ab"]);
    expect(editors.running("0123456789ab")).toBeUndefined();
    expect(editors.authorize("0123456789ab", session)).toBeUndefined();
  });

  it("stops an idle editor and reports it, but not while a connection is open", async () => {
    vi.useFakeTimers();
    let now = 0;
    const fake = fakeManager();
    const onIdle = vi.fn(async () => undefined);
    editors = createTaskEditors({
      manager: fake.manager,
      now: () => now,
      idleMs: 1_000,
      onIdle,
    });
    await editors.open(task(), "rw");
    editors.connection("0123456789ab", 1);
    now = 5_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onIdle).not.toHaveBeenCalled();
    expect(editors.running("0123456789ab")).toEqual({ mode: "rw" });
    editors.connection("0123456789ab", -1);
    now = 10_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.stopped).toEqual(["task-0123456789ab"]);
    expect(onIdle).toHaveBeenCalledWith("0123456789ab", "rw");
    expect(editors.running("0123456789ab")).toBeUndefined();
  });

  it("stops every editor, including an earlier process's", async () => {
    const fake = fakeManager();
    editors = createTaskEditors({ manager: fake.manager });
    await editors.open(task(), "ro");
    await editors.stopAll();
    expect(fake.stopAllCalls).toBe(1);
    expect(editors.running("0123456789ab")).toBeUndefined();
  });
});
