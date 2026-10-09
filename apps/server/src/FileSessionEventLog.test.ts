import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openFileSessionEventLog } from "./FileSessionEventLog.js";
import {
  SERVER_RESTARTED_ERROR,
  SessionEventHub,
  type AssistantSessionEvent,
} from "./SessionEventHub.js";

const KEY = "home\u0000session-1";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function directory() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "event-log-"));
  cleanup.push(() => fs.rm(parent, { recursive: true, force: true }));
  return path.join(parent, "events");
}

async function open(dir: string, maxRetained = 1_000) {
  const log = await openFileSessionEventLog({ directory: dir });
  return { log, hub: new SessionEventHub(maxRetained, log) };
}

const started = (taskId: string): AssistantSessionEvent => ({
  kind: "task",
  state: "started",
  taskId,
  operation: "turn",
  actor: { subjectId: "owner", deviceId: "device" },
});
const finished = (taskId: string): AssistantSessionEvent => ({
  kind: "task",
  state: "finished",
  taskId,
  status: "completed",
});

async function logFile(dir: string) {
  const names = (await fs.readdir(dir)).filter((name) =>
    name.endsWith(".jsonl"),
  );
  expect(names).toHaveLength(1);
  return path.join(dir, names[0]!);
}

describe("file session event log", () => {
  it("keeps the epoch and replays events across a clean restart", async () => {
    const dir = await directory();
    const first = await open(dir);
    first.hub.publish(KEY, started("t1"));
    first.hub.publish(KEY, finished("t1"));
    await first.log.close();

    const second = await open(dir);
    expect(second.hub.epoch).toBe(first.hub.epoch);
    expect(second.hub.latestSequence(KEY)).toBe(2);
    const replay = second.hub.read(KEY, 1);
    expect(replay).toEqual({
      reset: false,
      events: [{ sequence: 2, event: finished("t1") }],
    });
    // Sequences continue rather than restarting, so old cursors stay valid.
    expect(second.hub.publish(KEY, started("t2"))?.sequence).toBe(3);
    // Unknown sessions start empty.
    expect(second.hub.latestSequence("home\u0000other")).toBe(0);
    await second.log.close();
  });

  it("changes the epoch after a crash but keeps the log", async () => {
    const dir = await directory();
    const first = await open(dir);
    first.hub.publish(KEY, started("t1"));
    first.hub.publish(KEY, finished("t1"));
    await first.log.close();
    // What a crash leaves: the state written at start, never marked clean.
    const statePath = path.join(dir, "state.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(state.clean).toBe(true);
    await fs.writeFile(statePath, JSON.stringify({ ...state, clean: false }));

    const second = await open(dir);
    expect(second.hub.epoch).not.toBe(first.hub.epoch);
    expect(second.hub.latestSequence(KEY)).toBe(2);
    await second.log.close();
  });

  it("closes a task the previous run left open, once", async () => {
    const dir = await directory();
    const first = await open(dir);
    first.hub.publish(KEY, started("t1"));
    await first.log.close();

    const second = await open(dir);
    const replay = second.hub.read(KEY, 0);
    expect(replay.reset).toBe(false);
    expect(!replay.reset && replay.events.map(({ event }) => event)).toEqual([
      started("t1"),
      {
        kind: "task",
        state: "failed",
        taskId: "t1",
        error: SERVER_RESTARTED_ERROR,
      },
    ]);
    await second.log.close();

    const third = await open(dir);
    expect(third.hub.latestSequence(KEY)).toBe(2);
    await third.log.close();
  });

  it("drops a torn last line and stays appendable", async () => {
    const dir = await directory();
    const first = await open(dir);
    first.hub.publish(KEY, started("t1"));
    first.hub.publish(KEY, finished("t1"));
    await first.log.close();
    const file = await logFile(dir);
    await fs.appendFile(file, '{"sequence":3,"event":{"kind":"ta');

    const second = await open(dir);
    expect(second.hub.latestSequence(KEY)).toBe(2);
    second.hub.publish(KEY, started("t2"));
    await second.log.close();
    const lines = (await fs.readFile(file, "utf8")).trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line).sequence)).toEqual([1, 2, 3]);
  });

  it("compacts a session's file to the retained window", async () => {
    const dir = await directory();
    const first = await open(dir, 3);
    for (let index = 1; index <= 10; index += 1) {
      first.hub.publish(KEY, finished(`t${index}`));
    }
    await first.log.close();
    const lines = (await fs.readFile(await logFile(dir), "utf8"))
      .trimEnd()
      .split("\n");
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(JSON.parse(lines.at(-1)!).sequence).toBe(10);

    const second = await open(dir, 3);
    expect(second.hub.latestSequence(KEY)).toBe(10);
    expect(second.hub.read(KEY, 6)).toMatchObject({ reset: true });
    const tail = second.hub.read(KEY, 7);
    expect(!tail.reset && tail.events.map(({ sequence }) => sequence)).toEqual([
      8, 9, 10,
    ]);
    await second.log.close();
  });

  it("never reuses sequence numbers when a session's file goes missing", async () => {
    const dir = await directory();
    const first = await open(dir);
    first.hub.publish(KEY, started("t1"));
    first.hub.publish(KEY, finished("t1"));
    await first.log.close();
    await fs.rm(await logFile(dir));

    const second = await open(dir);
    expect(second.hub.epoch).toBe(first.hub.epoch);
    // An old cursor resets instead of replaying new events as if continuous.
    expect(second.hub.latestSequence(KEY)).toBe(2);
    expect(second.hub.read(KEY, 1)).toMatchObject({ reset: true });
    expect(second.hub.publish(KEY, started("t2"))?.sequence).toBe(3);
    await second.log.close();
  });

  it("closes a long interrupted turn even past the retained window", async () => {
    const dir = await directory();
    const first = await open(dir, 3);
    first.hub.publish(KEY, started("long"));
    for (let index = 0; index < 20; index += 1) {
      first.hub.publish(KEY, {
        kind: "agent",
        state: "steered",
        childSessionId: `child-${index}`,
      });
    }
    // Stopped without the task finishing, as after a crash.
    await first.log.close();

    const second = await open(dir, 3);
    const log = second.hub.read(KEY, 19);
    expect(!log.reset && log.events.at(-1)).toEqual({
      sequence: 22,
      event: {
        kind: "task",
        state: "failed",
        taskId: "long",
        error: SERVER_RESTARTED_ERROR,
      },
    });
    await second.log.close();
  });

  it("drops events published after the hub closes", async () => {
    const dir = await directory();
    const first = await open(dir);
    const seen: number[] = [];
    first.hub.subscribe(KEY, 0, (event) => seen.push(event.sequence));
    first.hub.publish(KEY, started("t1"));
    first.hub.close();
    expect(first.hub.publish(KEY, finished("t1"))).toBeUndefined();
    await first.log.close();
    expect(seen).toEqual([1]);

    const second = await open(dir);
    expect(second.hub.latestSequence(KEY)).toBe(2); // + server_restarted
    await second.log.close();
  });

  it("refuses a second process and keeps its files private", async () => {
    const dir = await directory();
    const first = await open(dir);
    await expect(openFileSessionEventLog({ directory: dir })).rejects.toThrow(
      /Another agentlink-server process/u,
    );
    first.hub.publish(KEY, started("t1"));
    if (process.platform !== "win32") {
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(await logFile(dir))).mode & 0o777).toBe(0o600);
    }
    await first.log.close();
  });
});
