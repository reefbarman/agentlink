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
  return (
    <span style={{ display: "inline-flex", alignItems: "center" }}>
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
          style={{
            position: "fixed",
            top: "44px",
            right: "12px",
            zIndex: 2000,
            width: "min(340px, calc(100vw - 24px))",
            padding: "14px",
            border: "1px solid var(--vscode-widget-border, #445)",
            borderRadius: "8px",
            background: "var(--vscode-editorWidget-background, #20232c)",
            color: "var(--vscode-editorWidget-foreground, #eee)",
            boxShadow: "0 6px 24px #0005",
            fontSize: "12px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "8px",
              alignItems: "center",
            }}
          >
            <strong>{productNames[state.identity.product]}</strong>
            <button
              class="icon-button"
              type="button"
              aria-label="Close update details"
              onClick={close}
            >
              <i class="codicon codicon-close" />
            </button>
          </div>
          <p>
            Running {state.identity.version}
            {candidate
              ? ` → ${candidate.version} (${candidate.channel})`
              : ""}{" "}
            · {state.identity.target}
          </p>
          {state.identity.hostLabel && <p>{state.identity.hostLabel}</p>}
          <p role="status">{statusLabels[state.status]}</p>
          {state.stale && state.checkedAt !== null && (
            <p>
              Last confirmed {new Date(state.checkedAt).toLocaleString()}. This
              result may be out of date.
            </p>
          )}
          {state.identity.product !== "vscode" && (
            <p>This preview is unsigned and not notarised.</p>
          )}
          {installState && installState.phase !== "idle" && (
            <p role="status">
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
          {!onInstall && <p>Install this update from the host.</p>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {onInstall &&
              candidate &&
              !pendingRestart &&
              !state.identity.development && (
                <button type="button" disabled={installing} onClick={onInstall}>
                  Install update
                </button>
              )}
            {pendingRestart && onRestart && (
              <button type="button" onClick={onRestart}>
                {state.identity.product === "vscode"
                  ? "Reload to finish"
                  : "Restart to update"}
              </button>
            )}
            <button type="button" onClick={() => onOpenLink(releaseUrl)}>
              Release notes
            </button>
            <button
              type="button"
              onClick={() =>
                onOpenLink(releaseInstructionsUrl(state.identity.product))
              }
            >
              How to update
            </button>
            <button
              type="button"
              disabled={
                state.status === "checking" ||
                Boolean(state.retryAt && state.retryAt > Date.now())
              }
              onClick={onCheck}
            >
              Check again
            </button>
            {candidate && candidate.version !== state.dismissedVersion && (
              <button type="button" onClick={onDismiss}>
                Dismiss this version
              </button>
            )}
          </div>
          {onAutomaticChecksChange ? (
            <label style={{ display: "flex", gap: "6px", marginTop: "12px" }}>
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
            <p>
              Automatic checks are{" "}
              {state.automaticChecks && !state.identity.development
                ? "on"
                : "off"}
              . Change this on the host.
            </p>
          )}
        </section>
      )}
    </span>
  );
}
