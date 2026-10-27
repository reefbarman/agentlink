import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMaintenance,
  readMaintenanceRequest,
  readMaintenanceStatus,
  requestDrain,
  requestResume,
  type Maintenance,
  type MaintenanceStatus,
} from "./maintenance.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const MINUTE = 60_000;

async function setup(options: { running?: string[] } = {}) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maintenance-"));
  cleanup.push(() =>
    fs.rm(dataRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    }),
  );
  let clock = 1_000_000;
  const running = [...(options.running ?? [])];
  const changes: MaintenanceStatus["state"][] = [];
  const interrupt = vi.fn(async () => {
    const stopped = running.splice(0);
    return stopped;
  });
  const open = () => {
    const maintenance = createMaintenance({
      dataRoot,
      running: () => running,
      interrupt,
      onChanged: (status) => changes.push(status.state),
      now: () => clock,
      // Polled by hand in these tests.
      pollMs: 60 * MINUTE,
      settleMs: MINUTE,
    });
    cleanup.push(() => maintenance.close());
    return maintenance;
  };
  return {
    dataRoot,
    running,
    changes,
    interrupt,
    open,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

/** The CLI's commands, with the server polled at each of their waits. */
function cliAgainst(
  test: Awaited<ReturnType<typeof setup>>,
  server: Maintenance | undefined,
) {
  const lines: string[] = [];
  return {
    lines,
    options: {
      dataRoot: test.dataRoot,
      report: (line: string) => lines.push(line),
      now: test.now,
      sleep: async (ms: number) => {
        test.advance(ms);
        await server?.check();
      },
      ackTimeoutMs: 15_000,
      pollMs: 1_000,
    },
  };
}

describe("draining", () => {
  it("drains at once when nothing runs, and resumes", async () => {
    const test = await setup();
    const server = test.open();
    await server.start();
    expect(server.paused()).toBe(false);

    const cli = cliAgainst(test, server);
    const outcome = await requestDrain(cli.options);
    expect(outcome).toMatchObject({ kind: "drained" });
    expect(server.paused()).toBe(true);
    expect(server.status().state).toBe("drained");
    expect(test.changes).toEqual(["draining", "drained"]);

    await expect(requestResume(cli.options)).resolves.toBe("resumed");
    expect(server.paused()).toBe(false);
    expect(test.changes.at(-1)).toBe("running");
    await expect(
      readMaintenanceRequest(test.dataRoot),
    ).resolves.toBeUndefined();
  });

  it("waits for running work, reporting it, then drains", async () => {
    const test = await setup({ running: ["task t1 (implementing)"] });
    const server = test.open();
    await server.start();
    const cli = cliAgainst(test, server);
    let ticks = 0;
    const outcome = await requestDrain({
      ...cli.options,
      sleep: async (ms) => {
        ticks += 1;
        // The task finishes after a few seconds.
        if (ticks === 3) test.running.splice(0);
        await cli.options.sleep(ms);
      },
    });
    expect(outcome).toMatchObject({
      kind: "drained",
      status: { interrupted: [] },
    });
    expect(cli.lines).toContain("Waiting for: task t1 (implementing)");
    expect(test.interrupt).not.toHaveBeenCalled();
  });

  it("stops what is left at the deadline, recorded interrupted", async () => {
    const test = await setup({ running: ["a chat turn in Home"] });
    const server = test.open();
    await server.start();
    const cli = cliAgainst(test, server);
    const outcome = await requestDrain({ ...cli.options, waitMs: 2 * MINUTE });
    expect(test.interrupt).toHaveBeenCalledWith("upgrade");
    expect(outcome).toMatchObject({
      kind: "drained",
      status: { interrupted: ["a chat turn in Home"] },
    });
  });

  it("stays drained across a restart until resumed", async () => {
    const test = await setup({ running: ['scheduled run of "Brief"'] });
    const first = test.open();
    await first.start();
    const cli = cliAgainst(test, first);
    await requestDrain({ ...cli.options, waitMs: 0 });
    await first.close();

    // The new version starts: nothing runs, and new work still waits.
    const second = test.open();
    await second.start();
    expect(second.paused()).toBe(true);
    expect(second.status()).toMatchObject({
      state: "drained",
      interrupted: ['scheduled run of "Brief"'],
    });
    await expect(requestResume(cliAgainst(test, second).options)).resolves.toBe(
      "resumed",
    );
    expect(second.paused()).toBe(false);
  });

  it("leaves the request for the next start when the server is down", async () => {
    const test = await setup();
    const cli = cliAgainst(test, undefined);
    await expect(requestDrain(cli.options)).resolves.toEqual({
      kind: "not_running",
    });
    const server = test.open();
    await server.start();
    expect(server.paused()).toBe(true);
  });

  it("joins a drain already requested", async () => {
    const test = await setup({ running: ["task t1 (implementing)"] });
    const server = test.open();
    await server.start();
    const cli = cliAgainst(test, server);
    await requestDrain({ ...cli.options, waitMs: 0 });
    const request = await readMaintenanceRequest(test.dataRoot);
    const again = cliAgainst(test, server);
    await expect(requestDrain(again.options)).resolves.toMatchObject({
      kind: "drained",
    });
    expect(again.lines[0]).toMatch(/^Already draining/u);
    await expect(readMaintenanceRequest(test.dataRoot)).resolves.toEqual(
      request,
    );
  });

  it("says when there is nothing to resume", async () => {
    const test = await setup();
    const server = test.open();
    await server.start();
    await expect(requestResume(cliAgainst(test, server).options)).resolves.toBe(
      "not_draining",
    );
    // Never drained: nothing was written.
    await expect(readMaintenanceStatus(test.dataRoot)).resolves.toBeUndefined();
  });
});
