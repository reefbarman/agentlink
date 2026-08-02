import type { CommandRecoveryAttempt, CommandReviewSummary } from "../types.js";

import type { TerminalExecutionSecuritySummary } from "../../../core/capabilities/terminal.js";

interface CommandExecutionContextProps {
  security?: TerminalExecutionSecuritySummary;
  reason?: string;
  review?: CommandReviewSummary;
  humanOnlyReason?: string;
  recoveryAttempt?: CommandRecoveryAttempt;
  edited?: boolean;
  nativeEscalation?: boolean;
  approvalRulesSupported?: boolean;
}

export function CommandExecutionContext({
  security,
  reason,
  review,
  humanOnlyReason,
  recoveryAttempt,
  edited = false,
  nativeEscalation = false,
  approvalRulesSupported = false,
}: CommandExecutionContextProps) {
  const protectedTerminal = security?.route === "sandbox";
  const label = nativeEscalation
    ? "Full terminal access"
    : protectedTerminal
      ? "Protected Terminal"
      : "AgentLink Terminal";
  const shortDescription = recoveryAttempt
    ? "Second execution · may repeat side effects"
    : nativeEscalation
      ? approvalRulesSupported
        ? "Normal user permissions"
        : "One run · normal user permissions"
      : protectedTerminal
        ? "Workspace access · private HOME · no network"
        : "Normal shell permissions";
  const description = nativeEscalation
    ? approvalRulesSupported
      ? "Runs with your normal user permissions, including host files, credentials, network, and local processes."
      : "This exact command will run once with your normal user permissions. It can access host files, credentials, network services, and local processes that the sandbox normally protects. This approval is not saved and cannot approve future commands."
    : protectedTerminal
      ? "Runs with workspace access, protected metadata, private HOME and temporary files, and no network access."
      : "Runs in your normal shell environment with the same permissions as a terminal you open.";
  const icon = nativeEscalation
    ? "codicon-warning"
    : protectedTerminal
      ? "codicon-shield"
      : "codicon-terminal";
  const reviewLabel = review
    ? review.status === "reviewed"
      ? `${review.risk} risk`
      : review.status.replace("_", " ")
    : undefined;
  const showHandoffContext = Boolean(
    review || humanOnlyReason || recoveryAttempt,
  );
  const reviewerLabel =
    security?.approvalReviewerSnapshot === "auto-review"
      ? "Auto reviewer"
      : security?.approvalReviewerSnapshot === "user"
        ? "Human reviewer"
        : undefined;
  const presetLabel =
    security?.executionPresetSnapshot === "workspace-write"
      ? "Workspace-write preset"
      : security?.executionPresetSnapshot === "native-manual"
        ? "Native manual preset"
        : undefined;

  return (
    <>
      <details
        class={`command-context ${nativeEscalation || !protectedTerminal ? "native" : "verified"}`}
      >
        <summary class="command-context-summary">
          <span aria-hidden="true" class={`codicon ${icon}`} />
          <span class="command-context-summary-copy">
            <span class="command-context-summary-line">
              <strong>{label}</strong>
              <span class="command-context-boundary">{shortDescription}</span>
            </span>
            {reason && (
              <span class="command-context-reason" title={reason}>
                {reason}
              </span>
            )}
          </span>
        </summary>

        <div class="command-context-details">
          <div class="command-context-detail-row">
            <span aria-hidden="true" class={`codicon ${icon}`} />
            <div>
              <div>{description}</div>
              {edited && (
                <div>Edited command will be re-prepared before execution.</div>
              )}
            </div>
          </div>
          {(reviewerLabel || presetLabel) && (
            <div class="command-context-detail-row">
              <span aria-hidden="true" class="codicon codicon-settings-gear" />
              <div>
                <strong>Approval mode</strong>
                <div>
                  {[reviewerLabel, presetLabel].filter(Boolean).join(" · ")}
                </div>
              </div>
            </div>
          )}
        </div>
      </details>

      {recoveryAttempt && (
        <div class="command-context-detail-row command-recovery-warning">
          <span aria-hidden="true" class="codicon codicon-warning" />
          <div>
            <strong>Second execution after sandbox denial</strong>
            <div>
              The sandbox already launched this command. A second run may repeat
              side effects.
            </div>
          </div>
        </div>
      )}

      {showHandoffContext && (
        <details class="command-context command-handoff-context">
          <summary class="command-context-summary">
            <span aria-hidden="true" class="codicon codicon-info" />
            <span class="command-context-summary-copy">
              <span class="command-context-summary-line">
                <strong>Why this reached you</strong>
              </span>
            </span>
            {reviewLabel && (
              <span
                class={`command-context-review-badge${review?.status === "reviewed" ? ` risk-${review.risk}` : ""}`}
              >
                {reviewLabel}
              </span>
            )}
          </summary>
          <div class="command-context-details">
            {review && (
              <div class="command-context-detail-row">
                <span aria-hidden="true" class="codicon codicon-shield" />
                <div>
                  <strong>
                    Guardian {review.outcome === "allow" ? "allowed" : "denied"}
                    {review.status === "reviewed"
                      ? ` · ${review.risk} risk · ${review.userAuthorization} authorization`
                      : ` · ${review.status.replace("_", " ")}`}
                  </strong>
                  <div>{review.rationale}</div>
                </div>
              </div>
            )}
            {recoveryAttempt && (
              <div class="command-context-detail-row">
                <span aria-hidden="true" class="codicon codicon-warning" />
                <div>
                  <strong>Sandbox denial details</strong>
                  <div>
                    Denied {recoveryAttempt.denialOperation}:{" "}
                    {recoveryAttempt.denialReason}
                  </div>
                  <div>
                    First attempt: {recoveryAttempt.firstAttemptRoute} · command
                    sent {String(recoveryAttempt.commandSent)} · process
                    launched {String(recoveryAttempt.processLaunched)} · may
                    have side effects{" "}
                    {String(recoveryAttempt.mayHaveSideEffects)}.
                  </div>
                </div>
              </div>
            )}
            {humanOnlyReason && (
              <div class="command-context-detail-row">
                <span aria-hidden="true" class="codicon codicon-lock" />
                <div>
                  <strong>Human approval required</strong>
                  <div>{humanOnlyReason}</div>
                </div>
              </div>
            )}
          </div>
        </details>
      )}
    </>
  );
}
