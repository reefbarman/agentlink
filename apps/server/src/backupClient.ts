import type { SignedCheckpoint, StoredCheckpoint } from "./auditCheckpoint.js";

import type { BackupSnapshot } from "./backup.js";
import type { BackupStatus } from "./backupAgent.js";

/**
 * The assistant server's side of the backup sidecar: plain HTTP on a
 * private network with the shared token. It can only ask for the status,
 * the snapshots, or a backup now, and add or list audit checkpoints.
 */

export class BackupRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "BackupRequestError";
  }
}

export interface BackupClient {
  health(): Promise<{ readonly protocol: number; readonly build?: unknown }>;
  status(): Promise<BackupStatus>;
  /** Waits for the backup (or the one already running). */
  backupNow(): Promise<BackupStatus>;
  snapshots(): Promise<readonly BackupSnapshot[]>;
  /** Store a signed audit checkpoint in the witness. */
  writeCheckpoint(
    checkpoint: SignedCheckpoint,
  ): Promise<{ readonly snapshotId: string }>;
  /** The witness's audit checkpoints, oldest first. */
  checkpoints(): Promise<readonly StoredCheckpoint[]>;
}

export function createBackupClient(options: {
  readonly host: string;
  readonly port: number;
  readonly token: () => Promise<string>;
  readonly fetch?: typeof fetch;
}): BackupClient {
  const fetchImpl = options.fetch ?? fetch;
  const host = options.host.includes(":") ? `[${options.host}]` : options.host;
  const base = `http://${host}:${options.port}`;

  const call = async <T>(
    method: string,
    pathname: string,
    timeoutMs: number,
    body?: unknown,
  ): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${await options.token()}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new BackupRequestError(
        503,
        "backup_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const failure = (parsed ?? {}) as { error?: unknown; detail?: unknown };
      throw new BackupRequestError(
        response.status,
        typeof failure.error === "string" ? failure.error : "backup_error",
        typeof failure.detail === "string" ? failure.detail : undefined,
      );
    }
    return parsed as T;
  };

  return {
    health: () => call("GET", "/v1/health", 10_000),
    status: async () =>
      (await call<{ status: BackupStatus }>("GET", "/v1/status", 10_000))
        .status,
    // A first backup reads every project: give it time.
    backupNow: async () =>
      (
        await call<{ status: BackupStatus }>(
          "POST",
          "/v1/backup",
          6 * 60 * 60 * 1_000,
        )
      ).status,
    snapshots: async () =>
      (
        await call<{ snapshots: BackupSnapshot[] }>(
          "GET",
          "/v1/snapshots",
          60_000,
        )
      ).snapshots,
    writeCheckpoint: (checkpoint) =>
      call<{ snapshotId: string }>("POST", "/v1/checkpoints", 60_000, {
        payload: checkpoint.payload,
        signature: checkpoint.signature,
      }),
    checkpoints: async () =>
      (
        await call<{ checkpoints: StoredCheckpoint[] }>(
          "GET",
          "/v1/checkpoints",
          60_000,
        )
      ).checkpoints,
  };
}

/** No good backup for this long is worth telling the owner about. */
export const BACKUP_OVERDUE_MS = 26 * 60 * 60 * 1_000;

/** What, if anything, about the backups the owner should hear. */
export function backupProblem(
  status: BackupStatus,
  now: number,
  /** When backups were first seen configured (no success yet is normal before a day). */
  since: number,
):
  | { readonly kind: "failed"; readonly at: number; readonly error: string }
  | { readonly kind: "overdue"; readonly lastSuccessAt?: number }
  | undefined {
  const success = status.lastSuccess?.at;
  const failure = status.lastFailure;
  if (failure && (!success || failure.at > success)) {
    return { kind: "failed", at: failure.at, error: failure.error };
  }
  if (status.runningSince) return undefined;
  const reference = success ?? since;
  if (now - reference >= BACKUP_OVERDUE_MS) {
    return {
      kind: "overdue",
      ...(success ? { lastSuccessAt: success } : {}),
    };
  }
  return undefined;
}
