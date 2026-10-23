import type {
  ApprovalRequest,
  CommandRecoveryAttempt,
  CommandReviewSummary,
} from "@agentlink/protocol/approval-transport";

import type { TerminalExecutionSecuritySummary } from "@agentlink/protocol/terminal-security";

interface CommandExecutionContextProps {
  security?: TerminalExecutionSecuritySummary;
  /** Host-described sandbox, used when there is no security summary. */
  commandSandbox?: ApprovalRequest["commandSandbox"];
  reason?: string;
  review?: CommandReviewSummary;
  humanOnlyReason?: string;
  recoveryAttempt?: CommandRecoveryAttempt;
  edited?: boolean;
  nativeEscalation?: boolean;
  approvalRulesSupported?: boolean;
  /** Only the computer running AgentLink can approve this command. */
  thisMachineOnly?: boolean;
}

/** "1 hour", "90 minutes", "45 seconds". */
function formatRunLimit(milliseconds: number): string {
  const plural = (value: number, unit: string) =>
    `${value} ${unit}${value === 1 ? "" : "s"}`;
  if (milliseconds >= 3_600_000 && milliseconds % 3_600_000 === 0) {
    return plural(milliseconds / 3_600_000, "hour");
  }
  if (milliseconds >= 60_000) {
    return plural(Math.round(milliseconds / 60_000), "minute");
  }
  return plural(Math.max(1, Math.round(milliseconds / 1_000)), "second");
}

export function CommandExecutionContext({
  security,
  commandSandbox,
  reason,
  review,
  humanOnlyReason,
  recoveryAttempt,
  edited = false,
  nativeEscalation = false,
  approvalRulesSupported = false,
  thisMachineOnly = false,
}: CommandExecutionContextProps) {
  const hostSandbox =
    !security && !nativeEscalation ? commandSandbox : undefined;
  const protectedTerminal =
    security?.route === "sandbox" || Boolean(hostSandbox);
  const managedNetwork = ["proxy-only", "partial"].includes(
    security?.sandbox?.capabilities.network ?? "",
  );
  const label = nativeEscalation
    ? "Full terminal access"
    : hostSandbox
      ? "Sandboxed command"
      : protectedTerminal
        ? "Protected Terminal"
        : "AgentLink Terminal";
  const firstCommandNotStarted =
    recoveryAttempt?.commandSent === false &&
    recoveryAttempt.processLaunched === false;
  const shortDescription = recoveryAttempt
    ? firstCommandNotStarted
      ? "First execution · sandbox could not start"
      : "Second execution · may repeat side effects"
    : nativeEscalation
      ? approvalRulesSupported
        ? "Normal user permissions"
        : "One run · normal user permissions"
      : hostSandbox
        ? hostSandbox.network === "none"
          ? "Writes only in this folder · no network"
          : hostSandbox.network === "approved-destinations"
            ? "Writes only in this folder · internet asks per destination"
            : "Writes only in this folder · no internet"
        : protectedTerminal
          ? managedNetwork
            ? "Workspace access · mediated network"
            : "Workspace access · private HOME · no network"
          : "Normal shell permissions";
  const description = nativeEscalation
    ? approvalRulesSupported
      ? "Runs with your normal user permissions, including host files, credentials, network, and local processes."
      : "This exact command will run once with your normal user permissions. It can access host files, credentials, network services, and local processes that the sandbox normally protects. This approval is not saved and cannot approve future commands."
    : hostSandbox
      ? `Runs once in a sandbox. It can read files on this computer, but can only write inside ${hostSandbox.writableRoot} and temporary folders. Git metadata and agent instruction files at the top of that folder stay read-only. ${
          hostSandbox.network === "none"
            ? "It has no network access."
            : hostSandbox.network === "approved-destinations"
              ? "Each new internet destination it connects to waits for your approval. Private network and cloud metadata addresses stay blocked."
              : "It cannot reach the internet, but can connect to services running on this computer."
        }`
      : protectedTerminal
        ? managedNetwork
          ? "Runs with workspace access, protected metadata, private HOME and temporary files. Public connections pause for exact destination approval; private and local destinations remain blocked."
          : "Runs with workspace access, protected metadata, private HOME and temporary files, and no network access."
        : "Runs in your normal shell environment with the same permissions as a terminal you open.";
  const background = commandSandbox?.background === true;
  const backgroundLimit =
    typeof commandSandbox?.timeoutMs === "number"
      ? formatRunLimit(commandSandbox.timeoutMs)
      : undefined;
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
              <span class="command-context-boundary">
                {background
                  ? `Background · ${shortDescription}`
                  : shortDescription}
              </span>
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
          {background && (
            <div class="command-context-detail-row">
              <span aria-hidden="true" class="codicon codicon-history" />
              <div>
                <strong>Keeps running in the background</strong>
                <div>
                  {`It keeps running after the agent replies, until it exits, the agent stops it, or it reaches its ${backgroundLimit ? `${backgroundLimit} ` : ""}time limit. Revoking the folder or deleting the chat stops it too.`}
                </div>
              </div>
            </div>
          )}
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

      {thisMachineOnly && (
        <div class="command-context-detail-row command-recovery-warning">
          <span aria-hidden="true" class="codicon codicon-lock" />
          <div>
            <strong>Approve on the computer running AgentLink</strong>
            <div>
              Running a command outside the sandbox can only be approved there.
              From another device you can only reject it.
            </div>
          </div>
        </div>
      )}

      {recoveryAttempt && (
        <div class="command-context-detail-row command-recovery-warning">
          <span aria-hidden="true" class="codicon codicon-warning" />
          <div>
            <strong>
              {firstCommandNotStarted
                ? "Sandbox could not start the command"
                : "Second execution after sandbox denial"}
            </strong>
            <div>
              {firstCommandNotStarted
                ? "The command has not run yet. Approving will run it once with your normal user permissions."
                : "The sandbox already launched this command. A second run may repeat side effects."}
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
                  <strong>
                    {firstCommandNotStarted
                      ? "Sandbox startup failure"
                      : "Sandbox denial details"}
                  </strong>
                  <div>
                    {firstCommandNotStarted ? "Failure" : "Denied"}{" "}
                    {recoveryAttempt.denialOperation}:{" "}
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
