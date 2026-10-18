import { useEffect, useRef, useState } from "preact/hooks";
import {
  assistantUpdateIsActive,
  type AssistantUpdatePhase,
  type AssistantUpdateStatus,
} from "../../shared/assistantUpdates";
import { errorText, requestJson } from "./AssistantProjects";

const PHASE: Record<AssistantUpdatePhase, string> = {
  queued: "Update queued",
  downloading: "Downloading release assets",
  validating: "Checking release compatibility and files",
  pulling: "Pulling the new images",
  draining: "Waiting for active work to finish",
  backing_up: "Backing up before the update",
  installing: "Installing the release",
  checking_health: "Checking the new version",
  rolling_back: "Restoring the previous version",
  reconnecting: "Reconnecting to the updated Assistant",
  completed: "Finished",
  failed: "Update failed",
  interrupted: "Update interrupted",
};

interface UpdateResponse {
  status?: AssistantUpdateStatus;
  configured?: boolean;
  error?: string;
}
function projectResponse(value: UpdateResponse): AssistantUpdateStatus {
  if (value.status?.updaterProtocol === 1) return value.status;
  return {
    configured: value.configured === true,
    managed: false,
    installedVersion: null,
    installedCommit: null,
    updaterProtocol: 1,
    canRollback: false,
    rollbackVersion: null,
    operation: null,
    discovery: {
      status: "unsupported",
      automaticChecks: false,
      includePreviews: false,
      checkedAt: null,
      lastAttemptAt: null,
      retryAt: null,
      stale: true,
      releases: [],
    },
    ...(value.error ? { error: value.error } : {}),
  };
}

/** Owner deployment management, not an agent tool or a remote shell. */
export function AssistantUpdates({ pollMs = 2_000 }: { pollMs?: number }) {
  const [status, setStatus] = useState<AssistantUpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState("");
  const [confirm, setConfirm] = useState<{
    kind: "update" | "rollback";
    targetVersion: string;
    installedVersion: string | null;
  } | null>(null);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const requestNumber = useRef(0);
  const active = assistantUpdateIsActive(status?.operation ?? null);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const refresh = async () => {
      if (busyRef.current) {
        if (!cancelled) timer = setTimeout(() => void refresh(), pollMs);
        return;
      }
      const number = ++requestNumber.current;
      try {
        const next = projectResponse(
          await requestJson<UpdateResponse>("/api/updates", {
            signal: AbortSignal.timeout(8_000),
          }),
        );
        if (!cancelled && number === requestNumber.current) {
          setStatus((current) =>
            next.error && current ? { ...current, error: next.error } : next,
          );
          setError(null);
        }
      } catch {
        if (!cancelled && number === requestNumber.current) {
          setError(
            "The Assistant is temporarily unreachable. This panel will reconnect; reopening it also restores progress.",
          );
        }
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), pollMs);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      alive.current = false;
      clearTimeout(timer);
    };
  }, [pollMs]);

  const act = async (path: string, body: unknown) => {
    busyRef.current = true;
    setBusy(true);
    setError(null);
    // Do not let a status request started before this action overwrite its result.
    const number = ++requestNumber.current;
    try {
      const next = projectResponse(
        await requestJson<UpdateResponse>(`/api/updates/${path}`, {
          method: "POST",
          body,
          signal: AbortSignal.timeout(30_000),
        }),
      );
      if (alive.current && number === requestNumber.current) setStatus(next);
      return true;
    } catch (caught) {
      if (alive.current) setError(errorText(caught));
      return false;
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const releases = status?.discovery.releases ?? [];
  const release =
    releases.find((entry) => entry.version === selected) ?? releases[0];
  const disabled = busy || active;
  const confirmationIsCurrent =
    confirm !== null &&
    confirm.installedVersion === status?.installedVersion &&
    (confirm.kind === "update"
      ? releases.some((entry) => entry.version === confirm.targetVersion)
      : confirm.targetVersion === status?.rollbackVersion);
  useEffect(() => {
    if (confirm && !confirmationIsCurrent) setConfirm(null);
  }, [confirm, confirmationIsCurrent]);
  const openConfirmation = (kind: "update" | "rollback") => {
    if (!status) return;
    const targetVersion =
      kind === "update" ? release?.version : status.rollbackVersion;
    if (!targetVersion || disabled) return;
    setConfirm({
      kind,
      targetVersion,
      installedVersion: status.installedVersion,
    });
  };
  const submit = async () => {
    if (!status || !confirm || !confirmationIsCurrent || disabled) {
      setConfirm(null);
      return;
    }
    const { kind, targetVersion, installedVersion } = confirm;
    setConfirm(null);
    await act(kind === "update" ? "apply" : "rollback", {
      version: targetVersion,
      expectedInstalledVersion: installedVersion,
      confirmed: true,
    });
  };

  return (
    <section
      class="assistant-settings-section assistant-updates"
      aria-label="Assistant updates"
    >
      <h3>Updates</h3>
      {!status && !error && (
        <p class="assistant-project-hint" role="status">
          Checking installation…
        </p>
      )}
      {status && (
        <>
          <p class="assistant-project-hint">
            {status.installedVersion
              ? `Installed: ${status.installedVersion}`
              : status.error
                ? "Installation status temporarily unavailable"
                : "Source-built installation"}
            {status.installedCommit
              ? ` (${status.installedCommit.slice(0, 8)})`
              : ""}
          </p>
          {!status.configured || !status.managed ? (
            <p class="assistant-project-hint">
              Browser updates are not configured for this installation. Keep
              using its existing command-line upgrade process; no automatic
              conversion will be attempted.
            </p>
          ) : (
            <>
              <div class="assistant-job-actions">
                <button
                  type="button"
                  class="assistant-panel-action"
                  disabled={disabled || status.discovery.status === "checking"}
                  onClick={() => void act("check", {})}
                >
                  {status.discovery.status === "checking"
                    ? "Checking…"
                    : "Check for updates"}
                </button>
                <button
                  type="button"
                  class="assistant-panel-action"
                  disabled={
                    disabled || !status.canRollback || !status.rollbackVersion
                  }
                  onClick={() => openConfirmation("rollback")}
                >
                  Roll back
                </button>
              </div>
              <label class="assistant-update-choice">
                <input
                  type="checkbox"
                  checked={status.discovery.automaticChecks}
                  disabled={disabled}
                  onChange={(event) =>
                    void act("preferences", {
                      automaticChecks: event.currentTarget.checked,
                      includePreviews: status.discovery.includePreviews,
                    })
                  }
                />
                Check automatically (at most daily)
              </label>
              <label class="assistant-update-choice">
                <input
                  type="checkbox"
                  checked={status.discovery.includePreviews}
                  disabled={disabled}
                  onChange={(event) =>
                    void act("preferences", {
                      automaticChecks: status.discovery.automaticChecks,
                      includePreviews: event.currentTarget.checked,
                    })
                  }
                />
                Include preview releases
              </label>
              <p class="assistant-project-hint" role="status">
                {status.discovery.status === "current"
                  ? "You’re up to date."
                  : status.discovery.status === "rate_limited"
                    ? "GitHub has limited update checks. Try again after the retry time."
                    : status.discovery.status === "unavailable"
                      ? "The release check did not finish. Your installed version has not changed."
                      : status.discovery.status === "unsupported"
                        ? "This installation cannot use released-image updates."
                        : release
                          ? `${release.version} is available${release.channel === "preview" ? " (preview)" : ""}.`
                          : "No verified newer release is available on this channel."}
              </p>
              {status.discovery.checkedAt && (
                <p class="assistant-project-hint">
                  Last checked:{" "}
                  {new Date(status.discovery.checkedAt).toLocaleString()}
                  {status.discovery.stale
                    ? " (cached; the latest check did not refresh these results)"
                    : ""}
                </p>
              )}
              {status.discovery.retryAt && (
                <p class="assistant-project-hint">
                  Retry after:{" "}
                  {new Date(status.discovery.retryAt).toLocaleString()}
                </p>
              )}
              {release && (
                <>
                  <label class="assistant-update-version">
                    Release
                    <select
                      aria-label="Assistant release"
                      value={release.version}
                      disabled={disabled}
                      onChange={(event) => {
                        setSelected(event.currentTarget.value);
                        setConfirm(null);
                      }}
                    >
                      {releases.map((entry) => (
                        <option key={entry.version} value={entry.version}>
                          {entry.version}
                          {entry.channel === "preview" ? " (preview)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <details class="assistant-update-notes">
                    <summary>Release notes for {release.version}</summary>
                    <div>
                      {release.notes || "No release notes were provided."}
                    </div>
                    <a
                      href={release.releaseUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View release on GitHub
                    </a>
                  </details>
                  <div>
                    <button
                      type="button"
                      class="assistant-panel-action primary"
                      disabled={disabled}
                      onClick={() => openConfirmation("update")}
                    >
                      Update to {release.version}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
          {status.operation && (
            <div
              class="assistant-update-progress"
              role="status"
              aria-live="polite"
            >
              <strong>{PHASE[status.operation.phase]}</strong>
              <span>
                {status.operation.fromVersion} →{" "}
                {status.operation.targetVersion}
              </span>
              {active && (
                <p>
                  Work continues if this panel or browser is closed. Updates may
                  briefly disconnect the app.
                </p>
              )}
              {status.operation.phase === "failed" && (
                <p>
                  The update did not complete. Check the status before trying
                  again; rollback may already have restored the previous
                  version.
                </p>
              )}
              {status.operation.phase === "interrupted" && (
                <p>
                  The updater stopped before reporting completion. Check the
                  deployment or use its rollback procedure before starting more
                  work.
                </p>
              )}
              {status.operation.phase === "completed" && (
                <button
                  type="button"
                  class="assistant-panel-action"
                  onClick={() => window.location.reload()}
                >
                  Reload Assistant
                </button>
              )}
            </div>
          )}
          {confirm && (
            <section
              class="assistant-update-confirm"
              aria-label="Confirm Assistant update"
            >
              <h4>
                {confirm.kind === "update"
                  ? `Update to ${confirm.targetVersion}?`
                  : `Restore ${confirm.targetVersion}?`}
              </h4>
              <p>
                {confirm.kind === "update"
                  ? "New work will pause while active work finishes. The updater takes a backup, installs the release and checks it, with rollback if startup fails. The app will briefly disconnect. Save any unsent message first."
                  : "Rollback restores the previous images, management files and pre-update data. Changes made since that backup will be kept aside, and scheduled jobs will be paused."}
              </p>
              <p>
                Your configuration and credentials are retained. Nothing changes
                until you confirm.
              </p>
              <div class="assistant-job-actions">
                <button
                  type="button"
                  class="assistant-panel-action"
                  disabled={busy}
                  onClick={() => setConfirm(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="assistant-panel-action primary"
                  disabled={disabled || !confirmationIsCurrent}
                  onClick={() => void submit()}
                >
                  {confirm.kind === "update"
                    ? "Back up and update"
                    : "Confirm rollback"}
                </button>
              </div>
            </section>
          )}
        </>
      )}
      {error && (
        <p class="assistant-project-error" role="alert">
          {error}
        </p>
      )}
      {status?.error && !error && (
        <p class="assistant-project-error" role="alert">
          The updater is unavailable or this deployment needs operator
          attention. No new update has been started.
        </p>
      )}
    </section>
  );
}
