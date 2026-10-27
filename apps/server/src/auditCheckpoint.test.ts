import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHECKPOINT_HOST,
  checkpointKeyFile,
  checkpointTag,
  isSignedCheckpoint,
  loadCheckpointKey,
  parseCheckpointTag,
  readCheckpoint,
  signCheckpoint,
  startAuditCheckpointer,
  verifyCheckpoints,
  type CheckpointWitness,
  type StoredCheckpoint,
} from "./auditCheckpoint.js";
import type { ResticRunner } from "./backup.js";
import { startBackupAgent } from "./backupAgent.js";
import { createBackupClient } from "./backupClient.js";
import { runAssistantServerCli } from "./serverCli.js";
import {
  AUDIT_HEAD_FILE,
  AUDIT_LOG_FILE,
  auditEntryHash,
  openTaskAudit,
  readAuditHashes,
  verifyTaskAudit,
  type TaskAuditEntry,
} from "./taskAudit.js";
import type { TaskRun } from "./taskStore.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-checkpoint-"));
  // Retries ENOTEMPTY when a sidecar write lands during removal under load.
  cleanup.push(() =>
    fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  );
  return dir;
}

const task = (overrides: Partial<TaskRun> = {}): TaskRun => ({
  id: "aaaaaaaaaaaa",
  repository: "https://github.com/acme/demo",
  objective: "Fix the bug",
  projectId: "task-aaaaaaaaaaaa",
  branch: "agentlink/fix",
  workspace: "/srv/.tasks/aaaaaaaaaaaa/demo",
  state: "queued",
  attempts: 0,
  evidence: [],
  effects: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

/**
 * An append-only witness in memory, behind restic's command line: it adds
 * snapshots and lists them, and has no way to change or remove one.
 */
function fakeWitness(options: { down?: () => boolean } = {}) {
  const snapshots: Array<{
    id: string;
    time: string;
    hostname: string;
    tags: string[];
  }> = [];
  let clock = Date.parse("2026-10-16T00:00:00Z");
  const restic: ResticRunner = async (args) => {
    if (options.down?.()) {
      return { exitCode: 1, stdout: "", stderr: "Fatal: connection refused" };
    }
    const host = args[args.indexOf("--host") + 1];
    if (args[0] === "backup") {
      const tags = args.flatMap((arg, index) =>
        args[index - 1] === "--tag" ? [arg] : [],
      );
      const id = String(snapshots.length + 1).padStart(64, "0");
      clock += 1_000;
      snapshots.push({
        id,
        time: new Date(clock).toISOString(),
        hostname: host!,
        tags,
      });
      return {
        exitCode: 0,
        stdout: `{"message_type":"summary","snapshot_id":"${id}"}\n`,
        stderr: "",
      };
    }
    if (args[0] === "snapshots") {
      const tag = args.includes("--tag")
        ? args[args.indexOf("--tag") + 1]
        : undefined;
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          snapshots.filter(
            (snapshot) =>
              snapshot.hostname === host &&
              (!tag || snapshot.tags.includes(tag)),
          ),
        ),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { restic, snapshots };
}

/** An audit log with `count` entries, and the checkpointer pieces. */
async function setup(options: { count?: number; down?: () => boolean } = {}) {
  const root = await tempDir();
  const directory = path.join(root, "data", "audit");
  const audit = await openTaskAudit({ directory });
  let previous: TaskRun | undefined;
  for (let index = 0; index < (options.count ?? 3); index += 1) {
    const next = task({
      state: index % 2 === 0 ? "implementing" : "validating",
      updatedAt: index + 1,
    });
    await audit.taskChanged(previous, next);
    previous = next;
  }
  await audit.flush();
  const witness = fakeWitness(options);
  const deployRoot = path.join(root, "deploy");
  await fs.mkdir(path.join(deployRoot, "data"), { recursive: true });
  const agent = await startBackupAgent({
    host: "127.0.0.1",
    port: 0,
    token: "secret-token",
    deployRoot,
    stateDirectory: path.join(root, "backup-state"),
    restic: witness.restic,
    schedule: false,
  });
  cleanup.push(() => agent.close());
  const client = createBackupClient({
    host: "127.0.0.1",
    port: agent.port,
    token: async () => "secret-token",
  });
  const key = (await loadCheckpointKey(
    checkpointKeyFile(path.join(root, "data")),
  ))!;
  return { root, directory, audit, witness, agent, client, key, previous };
}

/** Rewrite the log consistently: a changed entry, a recomputed chain and head. */
async function rewriteConsistently(directory: string, seq: number) {
  const lines = (
    await fs.readFile(path.join(directory, AUDIT_LOG_FILE), "utf8")
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TaskAuditEntry);
  let prev = "0".repeat(64);
  const rewritten = lines.map((entry) => {
    const data =
      entry.seq === seq ? { ...entry.data, state: "ready" } : entry.data;
    const unsigned = { ...entry, data, prev };
    const next = { ...unsigned, hash: auditEntryHash(unsigned) };
    prev = next.hash;
    return next;
  });
  await fs.writeFile(
    path.join(directory, AUDIT_LOG_FILE),
    rewritten.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  );
  const last = rewritten.at(-1)!;
  await fs.writeFile(
    path.join(directory, AUDIT_HEAD_FILE),
    `${JSON.stringify({ seq: last.seq, hash: last.hash })}\n`,
  );
}

describe("checkpoint signing", () => {
  it("creates the key once, private to its owner, and signs checkpoints it can read back", async () => {
    const root = await tempDir();
    const file = checkpointKeyFile(root);
    await expect(loadCheckpointKey(file, { create: false })).resolves.toBe(
      undefined,
    );
    const key = (await loadCheckpointKey(file))!;
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await loadCheckpointKey(file))!.publicKey).toBe(key.publicKey);

    const signed = signCheckpoint(key, { seq: 3, hash: "a".repeat(64), at: 5 });
    expect(isSignedCheckpoint(signed)).toBe(true);
    expect(readCheckpoint(signed)).toEqual({
      v: 1,
      seq: 3,
      hash: "a".repeat(64),
      at: 5,
      publicKey: key.publicKey,
    });
    expect(parseCheckpointTag(checkpointTag(signed))).toEqual(signed);
    expect(checkpointTag(signed)).not.toMatch(/[,\s]/u);
    // A changed payload no longer matches its signature.
    expect(
      readCheckpoint({
        ...signed,
        payload: signed.payload.replace('"seq":3', '"seq":4'),
      }),
    ).toBeUndefined();
  });
});

describe("verifyCheckpoints", () => {
  const stored = (
    signed: ReturnType<typeof signCheckpoint>,
    index: number,
  ): StoredCheckpoint => ({
    ...signed,
    snapshotId: String(index),
    time: `2026-10-16T00:00:0${index}Z`,
  });

  it("rejects a checkpoint signed with another key, and reports a replaced key", async () => {
    const root = await tempDir();
    const mine = (await loadCheckpointKey(path.join(root, "mine.key")))!;
    const other = (await loadCheckpointKey(path.join(root, "other.key")))!;
    const hashes = ["a".repeat(64), "b".repeat(64)];
    const genuine = stored(
      signCheckpoint(mine, { seq: 1, hash: hashes[0]!, at: 1 }),
      1,
    );
    // Forged afterwards with another key: claims entry 2 is something else.
    const forged = stored(
      signCheckpoint(other, { seq: 2, hash: "c".repeat(64), at: 2 }),
      2,
    );
    const result = verifyCheckpoints({
      hashes,
      checkpoints: [genuine, forged],
      publicKey: mine.publicKey,
    });
    expect(result).toMatchObject({ ok: true, checked: 1, rejected: 1 });

    // The key itself replaced: the first checkpoint's key is still the trusted one.
    const replaced = verifyCheckpoints({
      hashes,
      checkpoints: [genuine, forged],
      publicKey: other.publicKey,
    });
    expect(replaced.ok).toBe(false);
    expect(replaced.problems[0]).toMatch(/signing key is not the one/u);
  });

  it("reports a log shorter than a checkpoint", async () => {
    const root = await tempDir();
    const key = (await loadCheckpointKey(path.join(root, "k.key")))!;
    const result = verifyCheckpoints({
      hashes: ["a".repeat(64)],
      checkpoints: [
        stored(signCheckpoint(key, { seq: 3, hash: "b".repeat(64), at: 1 }), 1),
      ],
      publicKey: key.publicKey,
    });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/at entry 3, but the log has 1/u);
  });
});

describe("audit checkpoints through the backup sidecar", () => {
  it("catches a log rewritten consistently with its head, which the chain alone does not", async () => {
    const { directory, audit, client, key, witness } = await setup({
      count: 4,
    });
    const checkpointer = await startAuditCheckpointer({
      key,
      witness: {
        write: (checkpoint) => client.writeCheckpoint(checkpoint),
        list: () => client.checkpoints(),
      },
      head: () => audit.head(),
      hashes: () => readAuditHashes(directory),
      stateFile: path.join(directory, "checkpoints.json"),
      schedule: false,
    });
    cleanup.push(() => checkpointer.close());
    await checkpointer.checkpointNow();
    expect(checkpointer.status()).toMatchObject({
      pending: 0,
      lastCheckpoint: { seq: 5 },
      lastVerification: { ok: true, checked: 1 },
    });
    // Stored apart from backups, so a restore never picks it.
    expect(witness.snapshots.map((snapshot) => snapshot.hostname)).toEqual([
      CHECKPOINT_HOST,
    ]);
    await expect(client.snapshots()).resolves.toEqual([]);

    await rewriteConsistently(directory, 2);
    await expect(verifyTaskAudit(directory)).resolves.toMatchObject({
      ok: true,
    });
    const result = await checkpointer.verifyNow();
    expect(result?.ok).toBe(false);
    expect(result?.problems[0]).toMatch(/entry 5 is not the one checkpointed/u);
  });

  it("retries and reports a checkpoint the witness was down for", async () => {
    let down = true;
    const { directory, audit, client, key, previous } = await setup({
      down: () => down,
    });
    const failures: string[] = [];
    const checkpointer = await startAuditCheckpointer({
      key,
      witness: {
        write: (checkpoint) => client.writeCheckpoint(checkpoint),
        list: () => client.checkpoints(),
      },
      head: () => audit.head(),
      hashes: () => readAuditHashes(directory),
      stateFile: path.join(directory, "checkpoints.json"),
      onFailure: (error) => failures.push(error),
      schedule: false,
    });
    cleanup.push(() => checkpointer.close());
    await checkpointer.checkpointNow();
    await checkpointer.checkpointNow();
    expect(checkpointer.status()).toMatchObject({
      pending: 4,
      lastFailure: { error: expect.stringMatching(/connection refused/u) },
    });
    expect(checkpointer.status().lastCheckpoint).toBeUndefined();
    // Reported once per run of failures, not on every retry.
    expect(failures).toHaveLength(1);

    down = false;
    await audit.taskChanged(previous, task({ state: "ready", updatedAt: 9 }));
    await checkpointer.checkpointNow();
    const status = checkpointer.status();
    expect(status).toMatchObject({ pending: 0, lastCheckpoint: { seq: 5 } });
    expect(status.lastFailure).toBeUndefined();
  });

  it("checkpoints straight after an external effect", async () => {
    const root = await tempDir();
    const directory = path.join(root, "audit");
    const written: string[] = [];
    let checkpointer:
      | Awaited<ReturnType<typeof startAuditCheckpointer>>
      | undefined;
    const audit = await openTaskAudit({
      directory,
      onWritten: (kinds) => {
        if (kinds.includes("effect")) checkpointer?.effectRecorded();
      },
    });
    const witness: CheckpointWitness = {
      write: vi.fn(async (signed) => {
        written.push(signed.payload);
        return { snapshotId: "s" };
      }),
      list: async () => [],
    };
    checkpointer = await startAuditCheckpointer({
      key: (await loadCheckpointKey(path.join(root, "k.key")))!,
      witness,
      head: () => audit.head(),
      hashes: () => readAuditHashes(directory),
      stateFile: path.join(directory, "checkpoints.json"),
      schedule: false,
    });
    cleanup.push(() => checkpointer!.close());
    const created = task();
    await audit.taskChanged(undefined, created);
    await audit.flush();
    expect(written).toEqual([]);
    await audit.taskChanged(
      created,
      task({
        state: "published",
        effects: [
          { kind: "push", commit: "1".repeat(40), status: "done", at: 2 },
        ],
        updatedAt: 2,
      }),
    );
    await audit.flush();
    await vi.waitFor(() => expect(written).toHaveLength(1));
    expect(JSON.parse(written[0]!)).toMatchObject({ seq: 4 });
  });
});

describe("agentlink-server audit-check --checkpoints", () => {
  it("passes on the real log and fails on a consistently rewritten copy", async () => {
    const { root, directory, audit, client, key, agent } = await setup({
      count: 2,
    });
    await fs.mkdir(path.join(root, "projects", "home"), { recursive: true });
    await fs.writeFile(path.join(root, "backup-token"), "secret-token", {
      mode: 0o600,
    });
    const configPath = path.join(root, "server.json");

    await fs.writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        dataRoot: "data",
        listen: { host: "127.0.0.1", port: 8443 },
        publicOrigins: ["https://assistant.home.arpa:8443"],
        tls: { localCa: true },
        defaultModel: { providerId: "codex", modelId: "gpt-6.1-sol" },
        providers: [{ type: "codex", modelIds: ["gpt-6.1-sol"] }],
        projects: [{ id: "home", root: "projects/home" }],
        backup: {
          host: "127.0.0.1",
          port: agent.port,
          token: { file: "backup-token" },
        },
      }),
    );
    await client.writeCheckpoint(
      signCheckpoint(key, { ...(await audit.head())!, at: Date.now() }),
    );
    const run = async (...extra: string[]) => {
      let stdout = "";
      const code = await runAssistantServerCli(
        ["audit-check", "--config", configPath, "--checkpoints", ...extra],
        {
          stdout: (text: string) => {
            stdout += text;
          },
          log: () => undefined,
          env: {},
          waitForShutdown: () => new Promise<string>(() => undefined),
        },
      );
      return { code, stdout };
    };
    const intact = await run();
    expect(intact.code).toBe(0);
    expect(intact.stdout).toMatch(/Checkpoints OK: the log matches 1 signed/u);

    const copy = path.join(root, "audit-copy");
    await fs.cp(directory, copy, { recursive: true });
    await rewriteConsistently(copy, 2);
    const rewritten = await run("--directory", copy);
    expect(rewritten.code).toBe(1);
    expect(rewritten.stdout).toMatch(/Audit log OK: 3 entries/u);
    expect(rewritten.stdout).toMatch(/does NOT match/u);
  });
});
