import type {
  ApprovalRequest,
  DecisionMessage,
} from "@agentlink/protocol/approval-transport";
import { useCallback, useState } from "preact/hooks";

import { ApprovalLayout } from "./ApprovalLayout.js";
import {
  FilePermissionRuleEditor,
  type FilePermissionRuleMode,
  type FilePermissionRuleScope,
} from "./FilePermissionRuleEditor.js";
import type { RefObject } from "preact";

interface PathCardProps {
  request: ApprovalRequest;
  submit: (data: Omit<DecisionMessage, "type">) => void;
  followUpRef: RefObject<string>;
}

export function PathCard({ request, submit, followUpRef }: PathCardProps) {
  const filePath = request.filePath ?? "";
  const dirPath =
    filePath.substring(0, filePath.lastIndexOf("/") + 1) || filePath;

  const [pattern, setPattern] = useState(dirPath);
  const [mode, setMode] = useState<FilePermissionRuleMode>("prefix");
  const [scope, setScope] = useState<FilePermissionRuleScope>("skip");

  const isSkipped = scope === "skip";

  const handleAllowOnce = useCallback(() => {
    submit({
      id: request.id,
      decision: "allow-once",
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [request.id, submit, followUpRef]);

  const handleSaveAndAllow = useCallback(() => {
    const decision =
      scope === "session"
        ? "allow-session"
        : scope === "project"
          ? "allow-project"
          : "allow-always";
    submit({
      id: request.id,
      decision,
      rulePattern: pattern,
      ruleMode: mode,
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [request.id, scope, pattern, mode, submit, followUpRef]);

  const handleReject = useCallback(
    (reason?: string) => {
      submit({ id: request.id, decision: "reject", rejectionReason: reason });
    },
    [request.id, submit],
  );

  const rulesJsx = (
    <FilePermissionRuleEditor
      label={filePath}
      pattern={pattern}
      mode={mode}
      scope={scope}
      modeGroupName={`path-rule-mode-${request.id}`}
      onPatternChange={setPattern}
      onModeChange={setMode}
      onScopeChange={setScope}
    />
  );

  return (
    <ApprovalLayout
      queuePosition={request.queuePosition}
      queueTotal={request.queueTotal}
      sourceProject={request.sourceProject}
      targetProject={request.targetProject}
      targetPath={request.targetPath}
      purpose="Read or access a path outside the workspace"
      rulesContent={rulesJsx}
      rulesModified={!isSkipped}
      primaryLabel="Allow Once"
      primaryWithRulesLabel="Save Rule & Allow"
      onAccept={handleAllowOnce}
      onSaveAndAccept={handleSaveAndAllow}
      onReject={handleReject}
      followUpRef={followUpRef}
    >
      <div class="card-label">Outside Workspace Access</div>
      <pre class="command-box">{filePath}</pre>
    </ApprovalLayout>
  );
}
