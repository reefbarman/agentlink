import { useEffect, useRef, useState } from "preact/hooks";
import {
  hasVisibleReleaseUpdate,
  RELEASE_REPOSITORY_URL,
  releaseInstructionsUrl,
  type ReleaseUpdateState,
} from "../../updates/releaseUpdateTypes.js";

import type { ReleaseInstallState } from "../../updates/releaseInstall.js";

export interface ReleaseUpdateIndicatorProps {
  onInstall?: () => void;
  onRestart?: () => void;
  installState?: ReleaseInstallState | null;
  state: ReleaseUpdateState | null;
  onCheck: () => void;
  onDismiss: () => void;
  onOpenLink: (url: string) => void;
  label?: string;
  showDetails?: boolean;
  onClose?: () => void;
  onAutomaticChecksChange?: (value: boolean) => void;
}

const productNames = {
  vscode: "AgentLink for VS Code",
  desktop: "AgentLink Desktop",
  cli: "AgentLink CLI",
};
const statusLabels: Record<ReleaseUpdateState["status"], string> = {
  idle: "Not checked yet.",
  checking: "Checking for updates…",
  available: "An update is available.",
  current: "No newer compatible release was found.",
  unavailable: "Could not complete the update check. Try again later.",
  rate_limited:
    "GitHub has limited update checks. Try again after the cooldown.",
  unsupported: "No supported release target is available for this build.",
  metadata_unavailable:
    "A newer release was found, but its compatibility information is unavailable.",
};

export function ReleaseUpdateIndicator({
  state,
  onCheck,
  onDismiss,
  onOpenLink,
  label = "Update available",
  showDetails = false,
  onClose,
  onAutomaticChecksChange,
  onInstall,
  onRestart,
  installState,
}: ReleaseUpdateIndicatorProps) {
  const [open, setOpen] = useState(showDetails);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (showDetails) setOpen(true);
  }, [showDetails]);
  const close = () => {
    setOpen(false);
    onClose?.();
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, onClose]);
  const pendingRestart = installState?.phase === "ready_to_restart";
  const installBlocked = installState?.phase === "blocked";
  const installing = Boolean(
    installState &&
    ["preparing", "downloading", "verifying", "installing"].includes(
      installState.phase,
    ),
  );
  if (!state || (!hasVisibleReleaseUpdate(state) && !pendingRestart && !open))
    return null;
  const candidate = state.candidate;
  const prefix =
    state.identity.product === "vscode" ? "v" : `${state.identity.product}-v`;
  const releaseUrl =
    candidate && new RegExp(`^${prefix}\\d+\\.\\d+\\.\\d+$`).test(candidate.tag)
      ? `${RELEASE_REPOSITORY_URL}/releases/tag/${candidate.tag}`
      : `${RELEASE_REPOSITORY_URL}/releases`;
  const installTone =
    installState?.phase === "failed" || installState?.phase === "blocked"
      ? "warning"
      : installState?.phase === "ready_to_restart" ||
          installState?.phase === "installed"
        ? "success"
        : "info";
  const canInstall =
    onInstall &&
    candidate &&
    !pendingRestart &&
    !installBlocked &&
    !state.identity.development;
  return (
    <span class="release-update">
      {(hasVisibleReleaseUpdate(state) || pendingRestart) && (
        <button
          ref={trigger}
          type="button"
          class="icon-button release-update-trigger"
          title={`${label}: ${candidate?.version}`}
          aria-label={label}
          onClick={() => setOpen((value) => !value)}
          style={{
            color: "var(--vscode-focusBorder, #4EC9B0)",
            gap: "4px",
            width: "auto",
            fontSize: "11px",
          }}
        >
          <i class="codicon codicon-arrow-circle-up" aria-hidden="true" />
          {pendingRestart ? "Restart to update" : label}
        </button>
      )}
      {open && (
        <section
          role="dialog"
          aria-label="AgentLink update details"
          class="release-update-dialog"
        >
          <header class="release-update-header">
            <strong class="release-update-title">
              {productNames[state.identity.product]}
            </strong>
            <button
              class="icon-button release-update-close"
              type="button"
              aria-label="Close update details"
              onClick={close}
            >
              <i class="codicon codicon-close" aria-hidden="true" />
            </button>
          </header>
          <div class="release-update-versions">
            <span class="release-update-version-current">
              {state.identity.version}
            </span>
            {candidate && (
              <>
                <i
                  class="codicon codicon-arrow-right release-update-version-arrow"
                  aria-label="to"
                />
                <span class="release-update-version-next">
                  {candidate.version}
                </span>
                <span class="release-update-channel">{candidate.channel}</span>
              </>
            )}
          </div>
          <p class="release-update-meta">
            {state.identity.target}
            {state.identity.hostLabel ? ` · ${state.identity.hostLabel}` : ""}
          </p>
          <p role="status" class="release-update-status">
            {statusLabels[state.status]}
          </p>
          {state.stale && state.checkedAt !== null && (
            <p class="release-update-meta">
              Last confirmed {new Date(state.checkedAt).toLocaleString()}. This
              result may be out of date.
            </p>
          )}
          {state.identity.product !== "vscode" && (
            <p class="release-update-note">
              <i class="codicon codicon-shield" aria-hidden="true" />
              <span>This preview is unsigned and not notarised.</span>
            </p>
          )}
          {installState && installState.phase !== "idle" && (
            <p
              role="status"
              class={`release-update-notice release-update-notice-${installTone}`}
            >
              {installState.message ??
                (
                  {
                    preparing: "Preparing update…",
                    downloading: "Downloading update…",
                    verifying: "Verifying checksum…",
                    installing: "Installing update…",
                    ready_to_restart:
                      "Update is ready. Restart when convenient.",
                    installed: "Update installed.",
                    failed: "Update failed. Nothing was restarted.",
                    blocked: "Self-update is unavailable for this build.",
                  } as Record<string, string>
                )[installState.phase]}
              {installState.phase === "downloading" && installState.total
                ? ` ${Math.round(((installState.received ?? 0) / installState.total) * 100)}%`
                : ""}
            </p>
          )}
          {!onInstall && (
            <p class="release-update-meta">
              Install this update from the host.
            </p>
          )}
          {(canInstall || (pendingRestart && onRestart)) && (
            <div class="release-update-primary-actions">
              {canInstall && (
                <button
                  type="button"
                  class="release-update-button release-update-button-primary"
                  disabled={installing}
                  onClick={onInstall}
                >
                  <i
                    class="codicon codicon-cloud-download"
                    aria-hidden="true"
                  />
                  Install update
                </button>
              )}
              {pendingRestart && onRestart && (
                <button
                  type="button"
                  class="release-update-button release-update-button-primary"
                  onClick={onRestart}
                >
                  <i class="codicon codicon-debug-restart" aria-hidden="true" />
                  {state.identity.product === "vscode"
                    ? "Reload to finish"
                    : "Restart to update"}
                </button>
              )}
            </div>
          )}
          <div class="release-update-links">
            <button
              type="button"
              class="release-update-button"
              onClick={() => onOpenLink(releaseUrl)}
            >
              Release notes
              <i class="codicon codicon-link-external" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="release-update-button"
              onClick={() =>
                onOpenLink(releaseInstructionsUrl(state.identity.product))
              }
            >
              How to update
              <i class="codicon codicon-link-external" aria-hidden="true" />
            </button>
          </div>
          <footer class="release-update-footer">
            <div class="release-update-footer-actions">
              <button
                type="button"
                class="release-update-button release-update-button-ghost"
                disabled={
                  state.status === "checking" ||
                  Boolean(state.retryAt && state.retryAt > Date.now())
                }
                onClick={onCheck}
              >
                <i class="codicon codicon-refresh" aria-hidden="true" />
                Check again
              </button>
              {candidate && candidate.version !== state.dismissedVersion && (
                <button
                  type="button"
                  class="release-update-button release-update-button-ghost"
                  onClick={onDismiss}
                >
                  Dismiss this version
                </button>
              )}
            </div>
            {renderAutomaticChecks()}
          </footer>
        </section>
      )}
    </span>
  );

  function renderAutomaticChecks() {
    if (!state) return null;
    return onAutomaticChecksChange ? (
      <label class="release-update-auto-checks">
        <input
          type="checkbox"
          checked={state.automaticChecks}
          onChange={(event) =>
            onAutomaticChecksChange(event.currentTarget.checked)
          }
        />
        Check automatically once a day
      </label>
    ) : (
      <p class="release-update-meta">
        Automatic checks are{" "}
        {state.automaticChecks && !state.identity.development ? "on" : "off"}.
        Change this on the host.
      </p>
    );
  }
}
