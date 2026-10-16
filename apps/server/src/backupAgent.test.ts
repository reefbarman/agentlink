import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ResticRunner } from "./backup.js";
import { startBackupAgent, type BackupAgentOptions } from "./backupAgent.js";
import {
  BACKUP_OVERDUE_MS,
  BackupRequestError,
  backupProblem,
  createBackupClient,
} from "./backupClient.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const HOUR = 60 * 60 * 1_000;

async function setup(
  overrides: Partial<BackupAgentOptions> & { failBackups?: boolean } = {},
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-agent-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const deployRoot = path.join(dir, "deploy");
  await fs.mkdir(path.join(deployRoot, "data"), { recursive: true });
  await fs.writeFile(path.join(deployRoot, "data/chats.json"), "[]");
  let clock = 1_000_000;
  let backups = 0;
  const restic: ResticRunner = async (args) => {
    if (args[0] === "backup") {
      backups += 1;
      if (overrides.failBackups) {
        return { exitCode: 1, stdout: "", stderr: "Fatal: store is full" };
      }
      return {
        exitCode: 0,
        stdout: `{"message_type":"summary","snapshot_id":"${String(backups).padStart(16, "0")}","total_files_processed":1,"total_bytes_processed":2,"data_added":2}`,
        stderr: "",
      };
    }
    if (args[0] === "snapshots") {
      return { exitCode: 0, stdout: "[]", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const agent = await startBackupAgent({
    host: "127.0.0.1",
    port: 0,
    token: "secret-token",
    deployRoot,
    stateDirectory: path.join(dir, "state"),
    restic,
    now: () => clock,
    schedule: false,
    ...overrides,
  });
  cleanup.push(() => agent.close());
  return {
    agent,
    dir,
    deployRoot,
    backups: () => backups,
    advance: (ms: number) => {
      clock += ms;
    },
    client: (token = "secret-token") =>
      createBackupClient({
        host: "127.0.0.1",
        port: agent.port,
        token: async () => token,
      }),
  };
}

describe("backup agent", () => {
  it("requires the token", async () => {
    const { client } = await setup();
    await expect(client("wrong").status()).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
    await expect(client().health()).resolves.toEqual({ protocol: 1 });
  });

  it("backs up on request and reports it", async () => {
    const { client } = await setup();
    const status = await client().backupNow();
    expect(status.lastSuccess).toMatchObject({
      snapshotId: "0000000000000001",
      files: 1,
      added: 2,
    });
    await expect(client().status()).resolves.toEqual(status);
    await expect(client().snapshots()).resolves.toEqual([]);
  });

  it("joins a backup already running", async () => {
    const { agent, backups } = await setup();
    const [first, second] = await Promise.all([
      agent.backupNow(),
      agent.backupNow(),
    ]);
    expect(first).toEqual(second);
    expect(backups()).toBe(1);
  });

  it("keeps its status across restarts", async () => {
    const { agent, dir, deployRoot } = await setup();
    await agent.backupNow();
    await agent.close();
    const again = await startBackupAgent({
      host: "127.0.0.1",
      port: 0,
      token: "t",
      deployRoot,
      stateDirectory: path.join(dir, "state"),
      restic: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      schedule: false,
    });
    cleanup.push(() => again.close());
    expect(again.status().lastSuccess?.snapshotId).toBe("0000000000000001");
  });

  it("backs up when none yet, hourly when data/ changed, daily otherwise", async () => {
    const { agent, deployRoot, backups, advance } = await setup();
    await agent.check();
    expect(backups()).toBe(1);
    // Changed, but too soon.
    await fs.writeFile(path.join(deployRoot, "data/chats.json"), "[1]");
    advance(30 * 60 * 1_000);
    await agent.check();
    expect(backups()).toBe(1);
    advance(HOUR);
    await agent.check();
    expect(backups()).toBe(2);
    // Unchanged: not until a day has passed.
    advance(2 * HOUR);
    await agent.check();
    expect(backups()).toBe(2);
    advance(24 * HOUR);
    await agent.check();
    expect(backups()).toBe(3);
  });

  it("records a failure and retries it after half an hour", async () => {
    const { agent, backups, advance } = await setup({ failBackups: true });
    await agent.check();
    expect(agent.status().lastFailure?.error).toMatch(/store is full/u);
    expect(agent.status().lastSuccess).toBeUndefined();
    advance(10 * 60 * 1_000);
    await agent.check();
    expect(backups()).toBe(1);
    advance(30 * 60 * 1_000);
    await agent.check();
    expect(backups()).toBe(2);
  });
});

describe("backup client", () => {
  it("reports an unreachable sidecar as unavailable", async () => {
    const client = createBackupClient({
      host: "127.0.0.1",
      port: 7800,
      token: async () => "t",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const error = await client.status().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackupRequestError);
    expect(error).toMatchObject({ status: 503, code: "backup_unavailable" });
  });
});

describe("backupProblem", () => {
  const since = 0;
  it("reports the latest failure", () => {
    expect(
      backupProblem(
        { lastSuccess: undefined, lastFailure: { at: 5, error: "boom" } },
        10,
        since,
      ),
    ).toEqual({ kind: "failed", at: 5, error: "boom" });
  });

  it("ignores a failure followed by a success", () => {
    expect(
      backupProblem(
        {
          lastFailure: { at: 5, error: "boom" },
          lastSuccess: {
            at: 6,
            durationMs: 1,
            snapshotId: "x",
            files: 1,
            bytes: 1,
            added: 0,
          },
        },
        10,
        since,
      ),
    ).toBeUndefined();
  });

  it("reports no good backup for over a day", () => {
    expect(backupProblem({}, BACKUP_OVERDUE_MS - 1, since)).toBeUndefined();
    expect(backupProblem({}, BACKUP_OVERDUE_MS, since)).toEqual({
      kind: "overdue",
    });
    expect(
      backupProblem({ runningSince: 1 }, BACKUP_OVERDUE_MS, since),
    ).toBeUndefined();
  });
});
