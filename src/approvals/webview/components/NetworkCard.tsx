import type { ApprovalRequest, DecisionMessage } from "../types.js";
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
  const rulesContent = (
    <div class="rule-row">
      <div class="rule-row-header">
        <code class="rule-row-label">{destination}</code>
      </div>
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
      rulesModified={scope !== "skip"}
      primaryLabel="Allow Once"
      primaryWithRulesLabel="Save Exact Rule & Allow"
      onAccept={allowOnce}
      onSaveAndAccept={saveAndAllow}
      onReject={reject}
      followUpRef={followUpRef}
    >
      <div class="card-label">
        <span class="codicon codicon-globe" /> Network Destination
      </div>
      <pre class="command-box">{destination}</pre>
      <dl class="approval-detail-list">
        <dt>Command</dt>
        <dd>{network.command}</dd>
        <dt>Working directory</dt>
        <dd>{network.cwd}</dd>
        <dt>Retained dial address</dt>
        <dd>{`${network.address} (IPv${network.family})`}</dd>
        <dt>Validated DNS answers</dt>
        <dd>
          {network.dnsAnswers
            .map((answer) => `${answer.address} (IPv${answer.family})`)
            .join(", ")}
        </dd>
      </dl>
      <div class="approval-detail-text">
        This approval permits only this paused connection. Redirects and later
        connections are reviewed independently. For encrypted HTTPS/TCP traffic,
        request paths, payloads, credentials, and response redirects are not
        visible.
      </div>
      {request.networkReview && (
        <div class="approval-detail-text">
          <strong>Guardian:</strong> {request.networkReview.rationale}
        </div>
      )}
    </ApprovalLayout>
  );
}
