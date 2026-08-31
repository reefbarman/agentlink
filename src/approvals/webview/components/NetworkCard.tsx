import type {
  ApprovalRequest,
  DecisionMessage,
} from "@agentlink/protocol/approval-transport";
import { useCallback, useEffect, useState } from "preact/hooks";

import { ApprovalLayout } from "./ApprovalLayout.js";
import type { RefObject } from "preact";

const SCOPES = ["session", "project", "global", "skip"] as const;
const SCOPE_LABELS: Record<(typeof SCOPES)[number], string> = {
  session: "Session",
  project: "Project",
  global: "Global",
  skip: "Skip",
};

interface NetworkCardProps {
  request: ApprovalRequest;
  submit: (data: Omit<DecisionMessage, "type">) => void;
  followUpRef: RefObject<string>;
}

export function NetworkCard({
  request,
  submit,
  followUpRef,
}: NetworkCardProps) {
  const network = request.managedNetwork;
  const [scope, setScope] = useState<(typeof SCOPES)[number]>("skip");

  useEffect(() => setScope("skip"), [request.id]);

  const allowOnce = useCallback(() => {
    submit({ id: request.id, decision: "allow-once" });
  }, [request.id, submit]);
  const saveAndAllow = useCallback(() => {
    if (scope === "skip") return;
    submit({ id: request.id, decision: `allow-${scope}` });
  }, [request.id, scope, submit]);
  const reject = useCallback(
    (reason?: string) =>
      submit({ id: request.id, decision: "reject", rejectionReason: reason }),
    [request.id, submit],
  );

  if (!network) {
    return (
      <ApprovalLayout
        purpose="Connect to a public network destination"
        rulesModified={false}
        primaryLabel="Unavailable"
        primaryWithRulesLabel="Unavailable"
        onAccept={() => reject("Missing managed network evidence")}
        onSaveAndAccept={() => reject("Missing managed network evidence")}
        onReject={reject}
        followUpRef={followUpRef}
      >
        <div class="approval-detail-text">
          Managed network evidence is unavailable.
        </div>
      </ApprovalLayout>
    );
  }

  const destination = `${network.protocol}://${network.host}:${network.port}`;
  const ruleScopeDescription =
    scope === "skip"
      ? "Choose a scope to save an exact destination rule."
      : scope === "global"
        ? `Allows future connections to ${destination} from every AgentLink project on this machine. Each connection is resolved and safety-checked again.`
        : `Allows future connections to ${destination} for this ${SCOPE_LABELS[scope].toLowerCase()}. Each connection is resolved and safety-checked again.`;
  const rulesContent = (
    <div class="rule-row">
      <div class="rule-row-header">
        <code class="rule-row-label">{destination}</code>
      </div>
      <div class="network-rule-description">{ruleScopeDescription}</div>
      <div class="rule-row-toggles">
        <div class="toggle-group">
          {SCOPES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              class={`mode-btn ${scope === candidate ? "active" : ""} ${
                candidate === "skip" ? "mode-btn-skip" : ""
              }`}
              onClick={() => setScope(candidate)}
            >
              {SCOPE_LABELS[candidate]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <ApprovalLayout
      queuePosition={request.queuePosition}
      queueTotal={request.queueTotal}
      sourceProject={request.sourceProject}
      purpose="Connect to a public network destination"
      rulesContent={rulesContent}
      rulesLabel="Save destination rule"
      rulesModified={scope !== "skip"}
      primaryLabel="Allow Once"
      primaryWithRulesLabel="Save Exact Rule & Allow"
      onAccept={allowOnce}
      onSaveAndAccept={saveAndAllow}
      onReject={reject}
      followUpRef={followUpRef}
    >
      <div class="card-label">
        <span class="codicon codicon-globe" /> Network destination paused
      </div>
      <section class="network-destination-summary" aria-label="Destination">
        <div class="network-destination-copy">
          <span class="network-section-label">Destination</span>
          <strong>{network.host}</strong>
          <span>{`${network.protocol.toUpperCase()} socket · port ${network.port}`}</span>
        </div>
        <code>{destination}</code>
      </section>
      <div class="network-approval-explainer">
        <strong>Allow once resumes only this connection.</strong> Redirects and
        later connections are reviewed independently.
      </div>
      <section class="network-context" aria-label="Connection context">
        <div class="network-context-heading">Connection context</div>
        <div class="network-context-row">
          <span class="codicon codicon-terminal" aria-hidden="true" />
          <div>
            <span>Command</span>
            <code>{network.command}</code>
          </div>
        </div>
        <div class="network-context-row">
          <span class="codicon codicon-folder" aria-hidden="true" />
          <div>
            <span>Working directory</span>
            <code>{network.cwd}</code>
          </div>
        </div>
        <div class="network-context-row">
          <span class="codicon codicon-globe" aria-hidden="true" />
          <div>
            <span>Resolved peer</span>
            <code>{`${network.address} (IPv${network.family})`}</code>
          </div>
        </div>
      </section>
      <details class="network-technical-details">
        <summary>Connection safeguards and DNS</summary>
        <div class="network-technical-content">
          <dl class="approval-detail-list">
            <dt>Validated DNS answers</dt>
            <dd>
              {network.dnsAnswers
                .map((answer) => `${answer.address} (IPv${answer.family})`)
                .join(", ")}
            </dd>
          </dl>
          <p>
            HTTPS/TCP request paths, payloads, credentials, response bodies, and
            redirect targets are not visible. Future connections re-resolve and
            remain blocked when they target private, local, metadata, or other
            unsafe addresses.
          </p>
          {request.networkReview && (
            <p>
              <strong>Guardian assessment:</strong>{" "}
              {request.networkReview.rationale}
            </p>
          )}
        </div>
      </details>
    </ApprovalLayout>
  );
}
