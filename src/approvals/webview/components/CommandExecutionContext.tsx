import type { CommandReviewSummary } from "../types.js";
import type { TerminalExecutionSecuritySummary } from "../../../core/capabilities/terminal.js";

interface CommandExecutionContextProps {
  security?: TerminalExecutionSecuritySummary;
  reason?: string;
  review?: CommandReviewSummary;
  humanOnlyReason?: string;
  edited?: boolean;
  nativeEscalation?: boolean;
  approvalRulesSupported?: boolean;
}

export function CommandExecutionContext({
  security,
  reason,
  review,
  humanOnlyReason,
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
  const shortDescription = nativeEscalation
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
        {reviewLabel && (
          <span
            class={`command-context-review-badge${review?.status === "reviewed" ? ` risk-${review.risk}` : ""}`}
          >
            {reviewLabel}
          </span>
        )}
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
        {humanOnlyReason && !nativeEscalation && (
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
  );
}
