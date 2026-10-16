import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  CHECKPOINT_HOST,
  CHECKPOINT_TAG,
  checkpointTag,
  parseCheckpointTag,
  type SignedCheckpoint,
  type StoredCheckpoint,
} from "./auditCheckpoint.js";

/**
 * Backups of an assistant deployment with restic, taken by the backup
 * sidecar (`agentlink-server backup-agent`), which sees the deploy
 * directory read-only and nothing else.
 *
 * Each backup is one restic snapshot of two paths:
 *
 * - the deploy directory (`server.json`, `.env`, compose files, `secrets/`,
 *   `publisher/`, `projects/` without dependency and build folders, and so
 *   on), read live, without its `data/` folder;
 * - a staged copy of `data/`, taken first, so the server's records are
 *   copied in a moment rather than over the minutes the projects take. The
 *   audit log's head is copied before the log, so a restored log is never
 *   shorter than its head says.
 *
 * Restoring puts both back in place in an empty directory and leaves a
 * `data/restored.json` marker, which the server reads on its next start
 * (schedules paused, Inbox entry).
 */

/** The restic host name every snapshot is taken as. */
export const BACKUP_HOST = "agentlink-assistant";
/** Where the deploy directory is mounted in the backup container. */
export const DEPLOY_MOUNT = "/srv/agentlink/deploy";
/** The `data/` folder inside a deploy directory. */
export const DATA_FOLDER = "data";
/** Written into a restored `data/`; read and removed on the next start. */
export const RESTORED_MARKER = "restored.json";
/** Not backed up: rebuilt on demand, or scratch. */
const DATA_EXCLUDES = new Set(["repository-snapshots"]);
/** Dependency and build folders, anywhere under `projects/`. */
export const PROJECT_EXCLUDES = [
  "node_modules",
  ".pnpm-store",
  ".venv",
  "dist",
  "build",
  "target",
  ".next",
] as const;
/** Head files copied before the logs they describe. */
const COPY_FIRST = new Set(["head.json"]);

export interface ResticResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs restic with these arguments; the repository and password come from the environment. */
export type ResticRunner = (
  args: readonly string[],
  options?: { readonly signal?: AbortSignal },
) => Promise<ResticResult>;

export class BackupError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BackupError";
  }
}

/** restic as a child process, with the repository and password from files. */
export function resticRunner(options: {
  readonly repositoryFile: string;
  readonly passwordFile: string;
  /** restic's cache; none when absent. */
  readonly cacheDirectory?: string;
  readonly executable?: string;
  readonly env?: NodeJS.ProcessEnv;
}): ResticRunner {
  const executable = options.executable ?? "restic";
  return (args, runOptions = {}) =>
    new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        PATH: options.env?.PATH ?? process.env.PATH ?? "/usr/bin:/bin",
        HOME: options.env?.HOME ?? "/tmp",
        RESTIC_REPOSITORY_FILE: options.repositoryFile,
        RESTIC_PASSWORD_FILE: options.passwordFile,
        ...(options.cacheDirectory
          ? { RESTIC_CACHE_DIR: options.cacheDirectory }
          : {}),
      };
      const child = spawn(
        executable,
        [...(options.cacheDirectory ? [] : ["--no-cache"]), ...args],
        {
          env,
          stdio: ["ignore", "pipe", "pipe"],
          ...(runOptions.signal ? { signal: runOptions.signal } : {}),
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
}

/** restic's own words for a failure, without the repository's address. */
function resticFailure(result: ResticResult, what: string): BackupError {
  const lines = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    // A rest: URL carries the witness password.
    .map((line) => line.replace(/rest:[^\s"']+/gu, "the backup store"));
  const detail = lines.slice(-3).join(" ") || `exit code ${result.exitCode}`;
  return new BackupError("restic_failed", `${what} failed: ${detail}`);
}

/**
 * Copy `data/` into `stage/data`, keeping each file's mode, owner and
 * modification time. Links and other special files are skipped. Returns
 * the number of files copied.
 */
export async function stageData(
  deployRoot: string,
  stageRoot: string,
): Promise<number> {
  const source = path.join(deployRoot, DATA_FOLDER);
  const target = path.join(stageRoot, DATA_FOLDER);
  await fs.rm(stageRoot, { recursive: true, force: true });
  await fs.mkdir(stageRoot, { recursive: true, mode: 0o700 });
  let files = 0;
  const copyDirectory = async (from: string, to: string, top: boolean) => {
    const stats = await fs.stat(from);
    await fs.mkdir(to, { mode: 0o700 });
    const entries = await fs.readdir(from, { withFileTypes: true });
    // Heads before their logs; otherwise a stable order.
    entries.sort((left, right) => {
      const first =
        Number(COPY_FIRST.has(right.name)) - Number(COPY_FIRST.has(left.name));
      return first || left.name.localeCompare(right.name);
    });
    for (const entry of entries) {
      if (top && DATA_EXCLUDES.has(entry.name)) continue;
      const fromPath = path.join(from, entry.name);
      const toPath = path.join(to, entry.name);
      if (entry.isDirectory()) {
        await copyDirectory(fromPath, toPath, false);
      } else if (entry.isFile()) {
        // A file removed while copying is simply not in this backup.
        const copied = await copyFileContents(fromPath, toPath).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (!copied) continue;
        await keepMetadata(toPath, await fs.stat(fromPath).catch(() => null));
        files += 1;
      }
    }
    await keepMetadata(to, stats);
  };
  await copyDirectory(source, target, true);
  return files;
}

/**
 * A plain read-and-write copy. Node's `copyFile` fails with EPERM in the
 * backup container (its copy fast paths are refused there), where reading
 * and writing work.
 */
async function copyFileContents(from: string, to: string): Promise<void> {
  // Open the source first, so a file that is gone leaves nothing behind.
  const source = await fs.open(from, "r");
  try {
    await pipeline(
      source.createReadStream({ autoClose: false }),
      createWriteStream(to, { flags: "wx", mode: 0o600 }),
    );
  } finally {
    await source.close();
  }
}

async function keepMetadata(file: string, stats: Stats | null): Promise<void> {
  if (!stats) return;
  await fs.chmod(file, stats.mode & 0o7777);
  await fs.utimes(file, stats.atime, stats.mtime);
  // Root (the backup container) keeps the owner; anyone else keeps theirs.
  await fs.chown(file, stats.uid, stats.gid).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  });
}

/**
 * A fingerprint of `data/` (names, sizes and modification times), to skip
 * a backup when nothing changed.
 */
export async function dataFingerprint(deployRoot: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (directory: string, relative: string, top: boolean) => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (top && DATA_EXCLUDES.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await walk(child, name, false);
      } else if (entry.isFile()) {
        const stats = await fs.stat(child).catch(() => null);
        if (stats) hash.update(`${name}\0${stats.size}\0${stats.mtimeMs}\n`);
      }
    }
  };
  await walk(path.join(deployRoot, DATA_FOLDER), "", true);
  return hash.digest("hex");
}

/** restic's arguments for one backup. */
export function backupArguments(
  deployRoot: string,
  stageRoot: string,
): string[] {
  const projects = path.posix.join(deployRoot, "projects");
  return [
    "backup",
    "--json",
    "--host",
    BACKUP_HOST,
    "--tag",
    "agentlink",
    "--exclude",
    path.posix.join(deployRoot, DATA_FOLDER),
    ...PROJECT_EXCLUDES.flatMap((name) => [
      "--exclude",
      `${projects}/**/${name}`,
    ]),
    deployRoot,
    path.posix.join(stageRoot, DATA_FOLDER),
  ];
}

export interface BackupSummary {
  readonly snapshotId: string;
  readonly files: number;
  /** Bytes read, and bytes new to the store. */
  readonly bytes: number;
  readonly added: number;
}

export interface BackupSnapshot {
  readonly id: string;
  readonly shortId: string;
  readonly time: string;
  readonly paths: readonly string[];
}

/** Create the repository if the store has none yet. */
export async function ensureRepository(restic: ResticRunner): Promise<void> {
  const probe = await restic(["cat", "config"]);
  if (probe.exitCode === 0) return;
  if (
    !/config file|does not exist|Is there a repository|no such file|not found/iu.test(
      probe.stderr,
    )
  ) {
    throw resticFailure(probe, "Opening the backup store");
  }
  const created = await restic(["init"]);
  if (created.exitCode !== 0) {
    throw resticFailure(created, "Creating the backup store");
  }
}

/** Back up `deployRoot` (with `data/` staged in `stageRoot`). */
export async function runBackup(options: {
  readonly restic: ResticRunner;
  readonly deployRoot: string;
  readonly stageRoot: string;
}): Promise<BackupSummary> {
  await ensureRepository(options.restic);
  await stageData(options.deployRoot, options.stageRoot);
  try {
    const result = await options.restic(
      backupArguments(options.deployRoot, options.stageRoot),
    );
    // 3: some files could not be read; the snapshot exists but is partial.
    if (result.exitCode !== 0) {
      throw resticFailure(result, "The backup");
    }
    const summary = result.stdout
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .find((line) => line?.message_type === "summary");
    if (!summary || typeof summary.snapshot_id !== "string") {
      throw new BackupError(
        "restic_failed",
        "The backup finished without naming its snapshot",
      );
    }
    const count = (key: string) =>
      typeof summary[key] === "number" ? (summary[key] as number) : 0;
    return {
      snapshotId: summary.snapshot_id,
      files: count("total_files_processed"),
      bytes: count("total_bytes_processed"),
      added: count("data_added"),
    };
  } finally {
    await fs.rm(options.stageRoot, { recursive: true, force: true });
  }
}

/** This deployment's snapshots, oldest first. */
export async function listSnapshots(
  restic: ResticRunner,
): Promise<BackupSnapshot[]> {
  const result = await restic(["snapshots", "--json", "--host", BACKUP_HOST]);
  if (result.exitCode !== 0) {
    throw resticFailure(result, "Listing backups");
  }
  const parsed = JSON.parse(result.stdout || "[]") as Array<{
    id?: unknown;
    short_id?: unknown;
    time?: unknown;
    paths?: unknown;
  }>;
  return parsed
    .filter((entry) => typeof entry.id === "string")
    .map((entry) => ({
      id: String(entry.id),
      shortId: String(entry.short_id ?? String(entry.id).slice(0, 8)),
      time: String(entry.time ?? ""),
      paths: Array.isArray(entry.paths) ? entry.paths.map(String) : [],
    }));
}

/**
 * Store a signed audit checkpoint in the witness as its own small snapshot
 * (host `agentlink-audit`, so backups never list or restore it). The
 * checkpoint is in its tags, so listing them is one call.
 */
export async function writeCheckpointSnapshot(options: {
  readonly restic: ResticRunner;
  /** A private folder for the checkpoint file restic reads. */
  readonly scratch: string;
  readonly checkpoint: SignedCheckpoint;
}): Promise<string> {
  await ensureRepository(options.restic);
  await fs.mkdir(options.scratch, { recursive: true, mode: 0o700 });
  const file = path.join(options.scratch, "audit-checkpoint.json");
  await fs.writeFile(file, `${JSON.stringify(options.checkpoint)}\n`, {
    mode: 0o600,
  });
  try {
    const result = await options.restic([
      "backup",
      "--json",
      "--host",
      CHECKPOINT_HOST,
      "--tag",
      CHECKPOINT_TAG,
      "--tag",
      checkpointTag(options.checkpoint),
      file,
    ]);
    if (result.exitCode !== 0) {
      throw resticFailure(result, "Storing the audit checkpoint");
    }
    const summary = result.stdout
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .find((line) => line?.message_type === "summary");
    if (!summary || typeof summary.snapshot_id !== "string") {
      throw new BackupError(
        "restic_failed",
        "Storing the audit checkpoint finished without naming its snapshot",
      );
    }
    return summary.snapshot_id;
  } finally {
    await fs.rm(file, { force: true });
  }
}

/** The witness's audit checkpoints, oldest first. */
export async function listCheckpointSnapshots(
  restic: ResticRunner,
): Promise<StoredCheckpoint[]> {
  const result = await restic([
    "snapshots",
    "--json",
    "--host",
    CHECKPOINT_HOST,
    "--tag",
    CHECKPOINT_TAG,
  ]);
  if (result.exitCode !== 0) {
    // A store with no repository yet has no checkpoints.
    if (/does not exist|Is there a repository/iu.test(result.stderr)) {
      return [];
    }
    throw resticFailure(result, "Listing audit checkpoints");
  }
  const parsed = JSON.parse(result.stdout || "[]") as Array<{
    id?: unknown;
    time?: unknown;
    tags?: unknown;
  }>;
  const checkpoints: StoredCheckpoint[] = [];
  for (const entry of parsed) {
    if (typeof entry.id !== "string" || !Array.isArray(entry.tags)) continue;
    for (const tag of entry.tags) {
      const signed =
        typeof tag === "string" ? parseCheckpointTag(tag) : undefined;
      if (signed) {
        checkpoints.push({
          ...signed,
          snapshotId: entry.id,
          time: String(entry.time ?? ""),
        });
      }
    }
  }
  // restic lists oldest first; keep that order by the witness's time.
  return checkpoints.sort((left, right) => left.time.localeCompare(right.time));
}

/** What `data/restored.json` records. */
export interface RestoredMarker {
  readonly snapshotId: string;
  /** When the snapshot was taken (ISO). */
  readonly snapshotTime: string;
  readonly restoredAt: number;
  /** Why: `upgrade-rollback` when an upgrade was rolled back. */
  readonly reason?: string;
}

/**
 * Restore a snapshot into `target`, which must be empty: the deploy
 * directory's files at its top, the staged `data/` as its `data/`, and
 * `data/restored.json` so the server starts in restored mode.
 */
export async function restoreSnapshot(options: {
  readonly restic: ResticRunner;
  readonly target: string;
  /** A snapshot ID, or `latest`. */
  readonly snapshot: string;
  readonly reason?: string;
  readonly now?: () => number;
}): Promise<RestoredMarker> {
  const now = options.now ?? Date.now;
  if (!/^(latest|[0-9a-f]{8,64})$/u.test(options.snapshot)) {
    throw new BackupError(
      "snapshot_invalid",
      "Name a snapshot by its ID (from `backups`) or `latest`",
    );
  }
  const target = path.resolve(options.target);
  const existing = await fs.readdir(target).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existing === null) {
    await fs.mkdir(target, { recursive: true });
  } else if (existing.length > 0) {
    throw new BackupError(
      "target_not_empty",
      `${target} is not empty. Restore into a new, empty directory (move the old deploy directory aside first).`,
    );
  }
  const snapshots = await listSnapshots(options.restic);
  const chosen =
    options.snapshot === "latest"
      ? snapshots.at(-1)
      : snapshots.find(
          (entry) =>
            entry.id === options.snapshot ||
            entry.id.startsWith(options.snapshot),
        );
  if (!chosen) {
    throw new BackupError(
      "snapshot_not_found",
      options.snapshot === "latest"
        ? "The backup store has no backups of this assistant"
        : `No backup ${options.snapshot} in the backup store`,
    );
  }
  const deployPath = chosen.paths.find((entry) => !entry.endsWith("/data"));
  const dataPath = chosen.paths.find((entry) => entry.endsWith("/data"));
  if (!deployPath || !dataPath) {
    throw new BackupError(
      "snapshot_unrecognised",
      `Backup ${chosen.shortId} was not taken by the backup sidecar`,
    );
  }
  // Restored beside the files' final places, then moved: same file system.
  const scratch = path.join(target, `.restore-${now()}`);
  const result = await options.restic([
    "restore",
    chosen.id,
    "--target",
    scratch,
  ]);
  if (result.exitCode !== 0) {
    await fs.rm(scratch, { recursive: true, force: true });
    throw resticFailure(result, "Restoring");
  }
  const restoredDeploy = path.join(scratch, deployPath);
  for (const entry of await fs.readdir(restoredDeploy)) {
    if (entry === DATA_FOLDER) continue;
    await fs.rename(path.join(restoredDeploy, entry), path.join(target, entry));
  }
  await fs.rename(path.join(scratch, dataPath), path.join(target, DATA_FOLDER));
  // The deploy directory's own mode and owner (often 0700, the host user).
  const stats = await fs.stat(restoredDeploy);
  await fs.chmod(target, stats.mode & 0o7777);
  await fs.chown(target, stats.uid, stats.gid).catch(() => undefined);
  await fs.rm(scratch, { recursive: true, force: true });
  const marker: RestoredMarker = {
    snapshotId: chosen.id,
    snapshotTime: chosen.time,
    restoredAt: now(),
    ...(options.reason ? { reason: options.reason } : {}),
  };
  // A backup taken for an upgrade was taken drained; the restored server
  // starts in restored mode (schedules paused) instead of drained.
  await fs.rm(path.join(target, DATA_FOLDER, "maintenance"), {
    recursive: true,
    force: true,
  });
  const markerFile = path.join(target, DATA_FOLDER, RESTORED_MARKER);
  await fs.writeFile(markerFile, `${JSON.stringify(marker)}\n`, {
    mode: 0o600,
  });
  const dataStats = await fs.stat(path.join(target, DATA_FOLDER));
  await fs.chown(markerFile, dataStats.uid, dataStats.gid).catch(() => {
    // Not root: the marker already belongs to whoever restored.
  });
  return marker;
}

/** Read and remove `data/restored.json`, if the last start was a restore. */
export async function takeRestoredMarker(
  dataRoot: string,
): Promise<RestoredMarker | undefined> {
  const file = path.join(dataRoot, RESTORED_MARKER);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  await fs.rm(file, { force: true });
  try {
    const parsed = JSON.parse(raw) as Partial<RestoredMarker>;
    return {
      snapshotId: String(parsed.snapshotId ?? ""),
      snapshotTime: String(parsed.snapshotTime ?? ""),
      restoredAt: Number(parsed.restoredAt ?? 0),
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
    };
  } catch {
    return { snapshotId: "", snapshotTime: "", restoredAt: 0 };
  }
}
