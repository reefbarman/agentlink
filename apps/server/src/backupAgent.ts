import { promises as fs } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";

import { writeFileAtomic } from "./atomicFile.js";
import {
  BackupError,
  dataFingerprint,
  listSnapshots,
  runBackup,
  type BackupSnapshot,
  type BackupSummary,
  type ResticRunner,
} from "./backup.js";
import { tokensMatch } from "./commandWorkerProtocol.js";
import { SERVER_BUILD } from "./serverBuild.js";

/**
 * The backup sidecar (`agentlink-server backup-agent`). It sees the deploy
 * directory read-only, and holds the backup store's address and password;
 * the assistant reaches it on a private network with a shared token and can
 * only ask for its status, its snapshots, or a backup now. It cannot read
 * files through it, and the store (an append-only rest-server) does not let
 * it delete or replace backups.
 *
 * It backs up by itself: hourly when `data/` changed, and at least daily.
 */

export const BACKUP_PROTOCOL = 1;
/** How often it checks whether a backup is due. */
const CHECK_INTERVAL_MS = 10 * 60 * 1_000;
/** Back up at least this often, even when nothing changed. */
const MAX_AGE_MS = 24 * 60 * 60 * 1_000;
/** And no more often than this when `data/` changed. */
const MIN_AGE_MS = 60 * 60 * 1_000;
/** A failed backup is retried after this long. */
const RETRY_MS = 30 * 60 * 1_000;
const STATUS_FILE = "status.json";

export interface BackupStatus {
  readonly lastSuccess?: BackupSummary & {
    readonly at: number;
    readonly durationMs: number;
  };
  readonly lastFailure?: { readonly at: number; readonly error: string };
  /** When the running backup started, if one is running. */
  readonly runningSince?: number;
}

interface StoredStatus extends BackupStatus {
  readonly schemaVersion: 1;
  readonly fingerprint?: string;
}

export interface BackupAgentOptions {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly deployRoot: string;
  /** Its own folder: status and the staging copy of `data/`. */
  readonly stateDirectory: string;
  readonly restic: ResticRunner;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** Off in tests. */
  readonly schedule?: boolean;
}

export interface BackupAgent {
  readonly port: number;
  status(): BackupStatus;
  /** Back up now, or join the backup already running. */
  backupNow(): Promise<BackupStatus>;
  /** Run a scheduled check (tests). */
  check(): Promise<void>;
  close(): Promise<void>;
}

export async function startBackupAgent(
  options: BackupAgentOptions,
): Promise<BackupAgent> {
  if (!options.token.trim()) throw new Error("Backup token is empty");
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  await fs.mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  const statusFile = path.join(options.stateDirectory, STATUS_FILE);
  const stageRoot = path.join(options.stateDirectory, "stage");
  let stored = await readStatus(statusFile);
  let running: Promise<BackupStatus> | undefined;
  let runningSince: number | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const status = (): BackupStatus => {
    const {
      schemaVersion: _version,
      fingerprint: _fingerprint,
      ...rest
    } = stored;
    return { ...rest, ...(runningSince ? { runningSince } : {}) };
  };
  const save = async (next: StoredStatus) => {
    stored = next;
    await writeFileAtomic(statusFile, `${JSON.stringify(next)}\n`);
  };

  const backupNow = (): Promise<BackupStatus> => {
    running ??= (async () => {
      const startedAt = now();
      runningSince = startedAt;
      try {
        const fingerprint = await dataFingerprint(options.deployRoot);
        const summary = await runBackup({
          restic: options.restic,
          deployRoot: options.deployRoot,
          stageRoot,
        });
        const at = now();
        await save({
          ...stored,
          schemaVersion: 1,
          fingerprint,
          lastSuccess: { ...summary, at, durationMs: at - startedAt },
        });
        log(
          `Backup ${summary.snapshotId.slice(0, 8)}: ${summary.files} files, ${summary.added} new bytes in ${Math.round((at - startedAt) / 1000)}s`,
        );
      } catch (error) {
        const message =
          error instanceof BackupError || error instanceof Error
            ? error.message
            : String(error);
        await save({
          ...stored,
          schemaVersion: 1,
          lastFailure: { at: now(), error: message },
        });
        log(`Backup failed: ${message}`);
      } finally {
        runningSince = undefined;
      }
      return status();
    })().finally(() => {
      running = undefined;
    });
    return running;
  };

  /** Whether a scheduled backup is due now. */
  const due = async (): Promise<boolean> => {
    const at = now();
    const success = stored.lastSuccess?.at;
    const failure = stored.lastFailure?.at;
    if (failure && (!success || failure > success) && at - failure < RETRY_MS) {
      return false;
    }
    if (!success || at - success >= MAX_AGE_MS) return true;
    if (at - success < MIN_AGE_MS) return false;
    return (await dataFingerprint(options.deployRoot)) !== stored.fingerprint;
  };

  const check = async () => {
    if (running) return;
    try {
      if (await due()) await backupNow();
    } catch (error) {
      log(
        `Backup check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const scheduleNext = () => {
    if (closed || options.schedule === false) return;
    timer = setTimeout(() => {
      void check().finally(scheduleNext);
    }, CHECK_INTERVAL_MS);
    timer.unref();
  };

  const sockets = new Set<Socket>();
  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (error instanceof BackupError) {
        sendJson(response, 502, { error: error.code, detail: error.message });
        return;
      }
      log(
        `backup-agent: ${error instanceof Error ? error.message : String(error)}`,
      );
      sendJson(response, 500, { error: "backup_error" });
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    // No request bodies are accepted.
    request.resume();
    const header = request.headers.authorization;
    const presented =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length)
        : undefined;
    if (!tokensMatch(options.token, presented)) {
      log("backup-agent: rejected a request with a bad token");
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://backup");
    const method = request.method ?? "GET";
    if (url.pathname === "/v1/health" && method === "GET") {
      sendJson(response, 200, {
        protocol: BACKUP_PROTOCOL,
        build: SERVER_BUILD,
      });
      return;
    }
    if (url.pathname === "/v1/status" && method === "GET") {
      sendJson(response, 200, { status: status() });
      return;
    }
    if (url.pathname === "/v1/backup" && method === "POST") {
      sendJson(response, 200, { status: await backupNow() });
      return;
    }
    if (url.pathname === "/v1/snapshots" && method === "GET") {
      const snapshots: BackupSnapshot[] = await listSnapshots(options.restic);
      sendJson(response, 200, { snapshots });
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  // The first check soon after starting, then every interval.
  if (options.schedule !== false) {
    timer = setTimeout(() => void check().finally(scheduleNext), 60_000);
    timer.unref();
  }
  return {
    port,
    status,
    backupNow,
    check,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      await running?.catch(() => undefined);
      const done = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      for (const socket of sockets) socket.destroy();
      await done;
    },
  };
}

async function readStatus(file: string): Promise<StoredStatus> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(file, "utf8"),
    ) as Partial<StoredStatus>;
    if (parsed.schemaVersion === 1) return parsed as StoredStatus;
  } catch {
    // Missing or unreadable: start over; the store keeps every backup.
  }
  return { schemaVersion: 1 };
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}
