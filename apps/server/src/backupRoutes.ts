import type { IncomingMessage, ServerResponse } from "node:http";

import type { AssistantServerAuth } from "./assistantServer.js";
import type { CheckpointStatus } from "./auditCheckpoint.js";
import type { BackupStatus } from "./backupAgent.js";
import {
  BACKUP_OVERDUE_MS,
  BackupRequestError,
  type BackupClient,
} from "./backupClient.js";
import { HttpError, sendJson } from "./httpJson.js";

/**
 * Owner-only backup API:
 *
 * - `GET /api/backups`: `{ configured, status?, overdueAfterMs, error?,
 *   checkpoints? }` (the audit checkpoints, which go to the same store)
 * - `POST /api/backups`: start a backup now (`202`); poll `GET` for its
 *   outcome
 *
 * Unsafe methods have already passed the server's Host, Origin and
 * fetch-site checks; the POST re-checks the sign-in.
 */

export interface BackupRoutesOptions {
  /** Undefined when no backup sidecar is configured. */
  readonly client: BackupClient | undefined;
  /** The audit checkpoints' status, when they are running. */
  readonly checkpoints?: () => CheckpointStatus | undefined;
  readonly isOwner: (auth: AssistantServerAuth) => boolean;
  /** After a backup started here finishes (or fails). */
  readonly onFinished?: (status: BackupStatus | undefined) => void;
  readonly log?: (line: string) => void;
}

export interface BackupRoutes {
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    auth: AssistantServerAuth,
  ): Promise<boolean>;
}

export function createBackupRoutes(options: BackupRoutesOptions): BackupRoutes {
  return {
    async handleRequest(request, response, auth) {
      const url = new URL(request.url ?? "/", "https://server.invalid");
      if (url.pathname !== "/api/backups") return false;
      if (!options.isOwner(auth)) throw new HttpError(403, "backups_forbidden");
      const method = (request.method ?? "GET").toUpperCase();
      const client = options.client;
      if (method === "GET") {
        if (!client) {
          sendJson(response, 200, { configured: false });
          return true;
        }
        const checkpoints = options.checkpoints?.();
        const extra = checkpoints ? { checkpoints } : {};
        try {
          sendJson(response, 200, {
            configured: true,
            overdueAfterMs: BACKUP_OVERDUE_MS,
            status: await client.status(),
            ...extra,
          });
        } catch (error) {
          sendJson(response, 200, {
            configured: true,
            overdueAfterMs: BACKUP_OVERDUE_MS,
            ...extra,
            error:
              error instanceof BackupRequestError
                ? error.code
                : "backup_unavailable",
          });
        }
        return true;
      }
      if (method !== "POST") throw new HttpError(405, "method_not_allowed");
      if (!client) throw new HttpError(409, "backups_not_configured");
      if (!(await auth.revalidate()).valid) {
        throw new HttpError(401, "authentication_required");
      }
      // A backup can take a while; it reports through its status.
      void client.backupNow().then(
        (status) => options.onFinished?.(status),
        (error: unknown) => {
          options.log?.(
            `Backup now failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          options.onFinished?.(undefined);
        },
      );
      sendJson(response, 202, { started: true });
      return true;
    },
  };
}
