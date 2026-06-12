import type {
  ApprovalRequest,
  DecisionMessage,
  MemoryScope,
  MemoryTier,
} from "../types.js";
import { useCallback, useMemo, useState } from "preact/hooks";

import { ApprovalLayout } from "./ApprovalLayout.js";
import type { RefObject } from "preact";

const TIERS: MemoryTier[] = ["instructions", "skill", "command", "memory"];
const SCOPES: MemoryScope[] = ["project", "global"];

interface MemoryCardProps {
  request: ApprovalRequest;
  submit: (data: Omit<DecisionMessage, "type">) => void;
  followUpRef: RefObject<string>;
}

function tierLabel(tier: MemoryTier): string {
  switch (tier) {
    case "instructions":
      return "Instructions";
    case "skill":
      return "Skill";
    case "command":
      return "Command";
    case "memory":
      return "Memory";
  }
}

export function MemoryCard({ request, submit, followUpRef }: MemoryCardProps) {
  const [tier, setTier] = useState<MemoryTier>(request.memoryTier ?? "memory");
  const [scope, setScope] = useState<MemoryScope>(
    request.memoryScope ?? "project",
  );
  const [name, setName] = useState(request.memoryName ?? "");

  const operation = request.memoryOperation ?? "add";
  const targetPath = request.memoryTargetPath ?? request.filePath ?? "";
  const title = request.memoryTitle ?? "Persist cross-session memory";
  const requiresName = tier === "skill" || tier === "command";
  const nameMissing = requiresName && !name.trim();

  const purpose = useMemo(() => {
    const verb =
      operation === "remove"
        ? "Remove"
        : operation === "update"
          ? "Update"
          : "Add";
    return `${verb} ${tierLabel(tier).toLowerCase()} (${scope})`;
  }, [operation, scope, tier]);

  const handleAccept = useCallback(() => {
    if (nameMissing) return;
    submit({
      id: request.id,
      decision: "accept",
      memoryTier: tier,
      memoryScope: scope,
      memoryName: name.trim() || undefined,
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [followUpRef, name, nameMissing, request.id, scope, submit, tier]);

  const handleReject = useCallback(
    (reason?: string) => {
      submit({ id: request.id, decision: "reject", rejectionReason: reason });
    },
    [request.id, submit],
  );

  return (
    <ApprovalLayout
      queuePosition={request.queuePosition}
      queueTotal={request.queueTotal}
      purpose={purpose}
      rulesModified={false}
      primaryLabel={nameMissing ? "Name required" : "Accept"}
      primaryWithRulesLabel="Accept"
      onAccept={handleAccept}
      onSaveAndAccept={handleAccept}
      onReject={handleReject}
      followUpRef={followUpRef}
    >
      <div class="memory-card">
        <div class="memory-card-header">
          <span class="codicon codicon-book" />
          <div>
            <div class="memory-card-title">{title}</div>
            <div class="memory-card-target">{targetPath}</div>
          </div>
        </div>

        {request.memoryRationale && (
          <div class="memory-rationale">
            <span class="memory-section-label">Rationale</span>
            <p>{request.memoryRationale}</p>
          </div>
        )}

        <div class="memory-retarget-grid">
          <div class="field">
            <label>Tier</label>
            <div class="toggle-group">
              {TIERS.map((value) => (
                <button
                  key={value}
                  type="button"
                  class={`mode-btn ${tier === value ? "active" : ""}`}
                  onClick={() => setTier(value)}
                >
                  {tierLabel(value)}
                </button>
              ))}
            </div>
          </div>

          <div class="field">
            <label>Scope</label>
            <div class="toggle-group">
              {SCOPES.map((value) => (
                <button
                  key={value}
                  type="button"
                  class={`mode-btn ${scope === value ? "active" : ""}`}
                  onClick={() => setScope(value)}
                >
                  {value === "project" ? "Project" : "Global"}
                </button>
              ))}
            </div>
          </div>
        </div>

        {requiresName && (
          <div class="field">
            <label>{tier === "skill" ? "Skill name" : "Command name"}</label>
            <input
              class="text-input"
              type="text"
              value={name}
              placeholder="lowercase-hyphen-name"
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
            />
            {nameMissing && (
              <div class="memory-validation-error">
                A {tier} proposal needs a name before it can be accepted.
              </div>
            )}
          </div>
        )}

        <div class="memory-rationale">
          <span class="memory-section-label">Review content</span>
          <p>
            Review or edit the open diff for the target file, then accept here
            to save it. Changing the target will reopen review for the selected
            destination.
          </p>
        </div>
      </div>
    </ApprovalLayout>
  );
}
