import { errorText, requestJson } from "./AssistantProjects";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

/**
 * The Assistant's backup status, shown at the top of the Inbox (where a
 * failed backup is reported): when it last backed up, whether the last one
 * failed, and **Back up now**, then the audit log's checkpoints (kept in
 * the same store). Nothing shows when no backup sidecar is configured.
 */

export interface BackupStatus {
  lastSuccess?: {
    at: number;
    snapshotId: string;
    files: number;
    bytes: number;
    added: number;
    durationMs: number;
  };
  lastFailure?: { at: number; error: string };
  runningSince?: number;
}

/** The audit checkpoints, kept in the same backup store. */
export interface CheckpointStatus {
  lastCheckpoint?: { seq: number; at: number };
  lastFailure?: { at: number; error: string };
  pending: number;
  lastVerification?: { at: number; ok: boolean; problems: string[] };
}

export interface BackupsResponse {
  configured: boolean;
  overdueAfterMs?: number;
  status?: BackupStatus;
  error?: string;
  checkpoints?: CheckpointStatus;
}

/** The audit checkpoint line and its tone. */
export function checkpointSummary(
  checkpoints: CheckpointStatus | undefined,
  now: number,
): { text: string; tone: "ok" | "busy" | "bad" } | undefined {
  if (!checkpoints) return undefined;
  const { lastCheckpoint, lastFailure, lastVerification } = checkpoints;
  if (lastVerification && !lastVerification.ok) {
    return {
      text: "The audit log does not match its checkpoints",
      tone: "bad",
    };
  }
  if (lastFailure) {
    return {
      text: `Audit checkpoints are failing (since ${timeAgo(lastFailure.at, now)})`,
      tone: "bad",
    };
  }
  if (!lastCheckpoint) {
    return { text: "No audit checkpoint yet", tone: "busy" };
  }
  return {
    text: `Audit log checkpointed ${timeAgo(lastCheckpoint.at, now)}`,
    tone: "ok",
  };
}

/** "5 minutes ago", "3 hours ago", "2 days ago". */
export function timeAgo(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

/** The status line and its tone. */
export function backupSummary(
  body: BackupsResponse,
  now: number,
): { text: string; tone: "ok" | "busy" | "bad" } | undefined {
  if (!body.configured) return undefined;
  if (body.error || !body.status) {
    return {
      text: "Backups: the backup service is not reachable",
      tone: "bad",
    };
  }
  const { lastSuccess, lastFailure, runningSince } = body.status;
  if (runningSince) {
    return {
      text: `Backing up (started ${timeAgo(runningSince, now)})`,
      tone: "busy",
    };
  }
  if (lastFailure && (!lastSuccess || lastFailure.at > lastSuccess.at)) {
    return {
      text: `The last backup failed ${timeAgo(lastFailure.at, now)}`,
      tone: "bad",
    };
  }
  if (!lastSuccess) return { text: "No backup yet", tone: "busy" };
  const overdue =
    body.overdueAfterMs !== undefined &&
    now - lastSuccess.at >= body.overdueAfterMs;
  return {
    text: `Backed up ${timeAgo(lastSuccess.at, now)}`,
    tone: overdue ? "bad" : "ok",
  };
}

export function BackupSettings({
  now = Date.now,
  pollMs = 5_000,
}: {
  now?: () => number;
  pollMs?: number;
}) {
  const [body, setBody] = useState<BackupsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const next = await requestJson<BackupsResponse>("/api/backups");
      setBody(next);
      // Follow a running backup until it finishes.
      if (next.status?.runningSince) {
        timer.current = setTimeout(() => void load(), pollMs);
      }
    } catch (caught) {
      setError(errorText(caught));
    }
  }, [pollMs]);

  useEffect(() => {
    void load();
    return () => clearTimeout(timer.current);
  }, [load]);

  const backUpNow = async () => {
    setBusy(true);
    setError(null);
    try {
      await requestJson("/api/backups", { method: "POST" });
      clearTimeout(timer.current);
      // The sidecar marks it running straight away.
      timer.current = setTimeout(() => void load(), 500);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const summary = body ? backupSummary(body, now()) : undefined;
  if (!summary) return null;
  const checkpoint = checkpointSummary(body?.checkpoints, now());
  const checkpointDetail =
    body?.checkpoints?.lastVerification?.ok === false
      ? body.checkpoints.lastVerification.problems.join("; ")
      : body?.checkpoints?.lastFailure?.error;
  const failure = body?.status?.lastFailure;
  const failed =
    failure &&
    (!body?.status?.lastSuccess || failure.at > body.status.lastSuccess.at);
  return (
    <section class="assistant-notifications" aria-label="Backups">
      <div class="assistant-notifications-row">
        <i
          class={`codicon codicon-${summary.tone === "bad" ? "warning" : summary.tone === "busy" ? "sync" : "database"}`}
          aria-hidden="true"
        />
        <span class="assistant-notifications-status">{summary.text}</span>
        {body?.status && (
          <span class="assistant-notifications-actions">
            <button
              type="button"
              class="assistant-panel-action"
              disabled={busy || Boolean(body.status.runningSince)}
              onClick={() => void backUpNow()}
            >
              Back up now
            </button>
          </span>
        )}
      </div>
      {failed && failure && !body?.status?.runningSince && (
        <p class="assistant-project-hint">{failure.error}</p>
      )}
      {checkpoint && (
        <div class="assistant-notifications-row">
          <i
            class={`codicon codicon-${checkpoint.tone === "bad" ? "warning" : "shield"}`}
            aria-hidden="true"
          />
          <span class="assistant-notifications-status">{checkpoint.text}</span>
        </div>
      )}
      {checkpoint?.tone === "bad" && checkpointDetail && (
        <p class="assistant-project-hint">{checkpointDetail}</p>
      )}
      {error && (
        <p class="assistant-project-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
