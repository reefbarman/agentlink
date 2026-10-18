import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BACKUP_HOST,
  BackupError,
  backupArguments,
  dataFingerprint,
  ensureRepository,
  listSnapshots,
  restoreSnapshot,
  runBackup,
  stageData,
  takeRestoredMarker,
  type ResticResult,
  type ResticRunner,
} from "./backup.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const ok = (stdout = ""): ResticResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string, exitCode = 1): ResticResult => ({
  exitCode,
  stdout: "",
  stderr,
});

/** A deploy directory with a little of everything. */
async function deployDir(): Promise<string> {
  const root = await tempDir("backup-deploy-");
  await fs.mkdir(path.join(root, "data/audit"), { recursive: true });
  await fs.mkdir(path.join(root, "data/repository-snapshots/x"), {
    recursive: true,
  });
  await fs.writeFile(path.join(root, "data/audit/tasks.jsonl"), "{}\n");
  await fs.writeFile(path.join(root, "data/audit/head.json"), "{}\n");
  await fs.writeFile(path.join(root, "data/repository-snapshots/x/a"), "a");
  await fs.writeFile(path.join(root, "data/chats.json"), "[]", {
    mode: 0o600,
  });
  await fs.writeFile(path.join(root, "server.json"), "{}");
  return root;
}

describe("stageData", () => {
  it("copies data/ without scratch folders, heads before their logs", async () => {
    const root = await deployDir();
    const stage = path.join(await tempDir("backup-stage-"), "stage");
    const copied: string[] = [];
    const originalOpen = fs.open;
    // Record the copy order: each source is opened to be copied.
    fs.open = ((file: string, ...rest: unknown[]) => {
      copied.push(path.relative(path.join(root, "data"), String(file)));
      return (originalOpen as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.open;
    try {
      expect(await stageData(root, stage)).toBe(3);
    } finally {
      fs.open = originalOpen;
    }
    expect(copied.indexOf("audit/head.json")).toBeLessThan(
      copied.indexOf("audit/tasks.jsonl"),
    );
    await expect(
      fs.readFile(path.join(stage, "data/audit/tasks.jsonl"), "utf8"),
    ).resolves.toBe("{}\n");
    await expect(
      fs.stat(path.join(stage, "data/repository-snapshots")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const mode = (await fs.stat(path.join(stage, "data/chats.json"))).mode;
    expect(mode & 0o777).toBe(0o600);
  });

  it("starts from an empty stage each time", async () => {
    const root = await deployDir();
    const stage = path.join(await tempDir("backup-stage-"), "stage");
    await fs.mkdir(path.join(stage, "data"), { recursive: true });
    await fs.writeFile(path.join(stage, "data/stale"), "old");
    await stageData(root, stage);
    await expect(fs.stat(path.join(stage, "data/stale"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });
});

describe("dataFingerprint", () => {
  it("changes when data/ changes, not when scratch folders do", async () => {
    const root = await deployDir();
    const first = await dataFingerprint(root);
    await fs.writeFile(path.join(root, "data/repository-snapshots/x/b"), "b");
    expect(await dataFingerprint(root)).toBe(first);
    await fs.writeFile(path.join(root, "data/chats.json"), "[1]");
    expect(await dataFingerprint(root)).not.toBe(first);
  });
});

describe("backupArguments", () => {
  it("backs up the deploy directory without data/ or build folders, plus the staged data/", () => {
    const args = backupArguments("/srv/agentlink/deploy", "/state/stage");
    expect(args.slice(0, 6)).toEqual([
      "backup",
      "--json",
      "--host",
      BACKUP_HOST,
      "--tag",
      "agentlink",
    ]);
    expect(args).toContain("/srv/agentlink/deploy/data");
    // Includes .upgrade-rollback.*, .upgrade-failed/, staged releases and
    // previous template/updater copies, all confined to the deploy bind mount.
    expect(args).toContain("/srv/agentlink/deploy/.upgrade-*");
    expect(args).toContain("/srv/agentlink/deploy/projects/**/node_modules");
    expect(args.slice(-2)).toEqual([
      "/srv/agentlink/deploy",
      "/state/stage/data",
    ]);
  });
});

describe("ensureRepository", () => {
  it("creates the repository when the store has none", async () => {
    const calls: string[][] = [];
    const restic: ResticRunner = async (args) => {
      calls.push([...args]);
      return args[0] === "cat"
        ? fail("Fatal: unable to open config file: Is there a repository?")
        : ok();
    };
    await ensureRepository(restic);
    expect(calls).toEqual([["cat", "config"], ["init"]]);
  });

  it("leaves an existing repository alone", async () => {
    const calls: string[][] = [];
    await ensureRepository(async (args) => {
      calls.push([...args]);
      return ok("{}");
    });
    expect(calls).toEqual([["cat", "config"]]);
  });

  it("reports other failures (a wrong password) without the store's address", async () => {
    await expect(
      ensureRepository(async () =>
        fail(
          "Fatal: wrong password or no key found at rest:http://u:secret@witness:8000/agentlink",
        ),
      ),
    ).rejects.toThrow(/wrong password.*the backup store/u);
    await expect(
      ensureRepository(async () => fail("rest:http://u:secret@w/x")),
    ).rejects.not.toThrow(/secret/u);
  });
});

describe("runBackup", () => {
  it("returns restic's summary and removes the stage", async () => {
    const root = await deployDir();
    const stage = path.join(await tempDir("backup-stage-"), "stage");
    let stagedFiles: string[] = [];
    const restic: ResticRunner = async (args) => {
      if (args[0] === "backup") {
        stagedFiles = await fs.readdir(path.join(stage, "data"));
        return ok(
          [
            '{"message_type":"status","percent_done":0.5}',
            '{"message_type":"summary","snapshot_id":"abcdef0123456789","total_files_processed":7,"total_bytes_processed":700,"data_added":70}',
          ].join("\n"),
        );
      }
      return ok();
    };
    await expect(
      runBackup({ restic, deployRoot: root, stageRoot: stage }),
    ).resolves.toEqual({
      snapshotId: "abcdef0123456789",
      files: 7,
      bytes: 700,
      added: 70,
    });
    expect(stagedFiles.sort()).toEqual(["audit", "chats.json"]);
    await expect(fs.stat(stage)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails on a partial backup and still removes the stage", async () => {
    const root = await deployDir();
    const stage = path.join(await tempDir("backup-stage-"), "stage");
    const restic: ResticRunner = async (args) =>
      args[0] === "backup" ? fail("error: open x: permission denied", 3) : ok();
    await expect(
      runBackup({ restic, deployRoot: root, stageRoot: stage }),
    ).rejects.toBeInstanceOf(BackupError);
    await expect(fs.stat(stage)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

const SNAPSHOTS = JSON.stringify([
  {
    id: "1111111111111111",
    short_id: "11111111",
    time: "2026-10-15T00:00:00Z",
    paths: ["/srv/agentlink/deploy", "/state/stage/data"],
  },
  {
    id: "2222222222222222",
    short_id: "22222222",
    time: "2026-10-16T00:00:00Z",
    paths: ["/srv/agentlink/deploy", "/state/stage/data"],
  },
]);

describe("listSnapshots", () => {
  it("lists this host's snapshots", async () => {
    let seen: readonly string[] = [];
    const snapshots = await listSnapshots(async (args) => {
      seen = args;
      return ok(SNAPSHOTS);
    });
    expect(seen).toEqual(["snapshots", "--json", "--host", BACKUP_HOST]);
    expect(snapshots.map((entry) => entry.shortId)).toEqual([
      "11111111",
      "22222222",
    ]);
  });
});

describe("restoreSnapshot", () => {
  /** A restic that restores a small deployment for `restore`. */
  const restoringRestic =
    (restored: string[] = []): ResticRunner =>
    async (args) => {
      if (args[0] === "snapshots") return ok(SNAPSHOTS);
      if (args[0] === "restore") {
        restored.push(args[1]!);
        const scratch = args[3]!;
        const deploy = path.join(scratch, "srv/agentlink/deploy");
        const data = path.join(scratch, "state/stage/data");
        await fs.mkdir(path.join(deploy, "secrets"), { recursive: true });
        await fs.writeFile(path.join(deploy, "server.json"), "{}");
        await fs.writeFile(path.join(deploy, "secrets/token"), "t");
        await fs.mkdir(path.join(data, "audit"), { recursive: true });
        await fs.writeFile(path.join(data, "audit/tasks.jsonl"), "{}\n");
        // Taken while drained for an upgrade.
        await fs.mkdir(path.join(data, "maintenance"));
        await fs.writeFile(path.join(data, "maintenance/request.json"), "{}");
        return ok();
      }
      return fail("unexpected");
    };

  it("restores the deploy directory and data/ in place, with a marker", async () => {
    const target = path.join(await tempDir("backup-restore-"), "assistant");
    const restored: string[] = [];
    const marker = await restoreSnapshot({
      restic: restoringRestic(restored),
      target,
      snapshot: "latest",
      now: () => 42,
    });
    expect(restored).toEqual(["2222222222222222"]);
    expect(marker).toEqual({
      snapshotId: "2222222222222222",
      snapshotTime: "2026-10-16T00:00:00Z",
      restoredAt: 42,
    });
    expect((await fs.readdir(target)).sort()).toEqual([
      "data",
      "secrets",
      "server.json",
    ]);
    await expect(
      fs.readFile(path.join(target, "data/audit/tasks.jsonl"), "utf8"),
    ).resolves.toBe("{}\n");
    await expect(
      takeRestoredMarker(path.join(target, "data")),
    ).resolves.toEqual(marker);
    // Taken once.
    await expect(
      takeRestoredMarker(path.join(target, "data")),
    ).resolves.toBeUndefined();
  });

  it("restores a named snapshot by its short ID", async () => {
    const target = path.join(await tempDir("backup-restore-"), "assistant");
    const restored: string[] = [];
    await restoreSnapshot({
      restic: restoringRestic(restored),
      target,
      snapshot: "11111111",
    });
    expect(restored).toEqual(["1111111111111111"]);
  });

  it("starts undrained, and records a rollback's reason", async () => {
    const target = path.join(await tempDir("backup-restore-"), "assistant");
    const marker = await restoreSnapshot({
      restic: restoringRestic(),
      target,
      snapshot: "latest",
      reason: "upgrade-rollback",
    });
    expect(marker.reason).toBe("upgrade-rollback");
    await expect(
      fs.stat(path.join(target, "data/maintenance")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      takeRestoredMarker(path.join(target, "data")),
    ).resolves.toMatchObject({ reason: "upgrade-rollback" });
  });

  it("refuses a directory that is not empty", async () => {
    const target = await tempDir("backup-restore-");
    await fs.writeFile(path.join(target, "server.json"), "{}");
    await expect(
      restoreSnapshot({
        restic: restoringRestic(),
        target,
        snapshot: "latest",
      }),
    ).rejects.toMatchObject({ code: "target_not_empty" });
  });

  it("refuses unknown and malformed snapshot names", async () => {
    const target = path.join(await tempDir("backup-restore-"), "assistant");
    await expect(
      restoreSnapshot({
        restic: restoringRestic(),
        target,
        snapshot: "33333333",
      }),
    ).rejects.toMatchObject({ code: "snapshot_not_found" });
    await expect(
      restoreSnapshot({
        restic: restoringRestic(),
        target,
        snapshot: "--target=/",
      }),
    ).rejects.toMatchObject({ code: "snapshot_invalid" });
  });

  it("reports an empty store", async () => {
    const target = path.join(await tempDir("backup-restore-"), "assistant");
    await expect(
      restoreSnapshot({
        restic: async () => ok("[]"),
        target,
        snapshot: "latest",
      }),
    ).rejects.toMatchObject({ code: "snapshot_not_found" });
  });
});
