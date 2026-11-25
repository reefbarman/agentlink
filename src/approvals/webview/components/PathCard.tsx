import type {
  ApprovalRequest,
  DecisionMessage,
} from "@agentlink/protocol/approval-transport";
import {
  FilePermissionRuleEditor,
  ruleFolder,
  useFilePermissionRule,
} from "./FilePermissionRuleEditor.js";

import { ApprovalLayout } from "./ApprovalLayout.js";
import type { RefObject } from "preact";
import { useCallback } from "preact/hooks";

interface PathCardProps {
  request: ApprovalRequest;
  submit: (data: Omit<DecisionMessage, "type">) => void;
  followUpRef: RefObject<string>;
}

export function PathCard({ request, submit, followUpRef }: PathCardProps) {
  const filePath = request.filePath ?? "";
  const folder = ruleFolder(filePath);
  const rule = useFilePermissionRule({ filePath });
  const { isSkipped, scope, pattern, match } = rule;

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
      ruleMode: match,
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [request.id, scope, pattern, match, submit, followUpRef]);

  // One click for the common case: trust this file's folder for the session.
  const handleAllowFolder = useCallback(() => {
    submit({
      id: request.id,
      decision: "allow-session",
      rulePattern: folder,
      ruleMode: "prefix",
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [request.id, folder, submit, followUpRef]);

  const handleReject = useCallback(
    (reason?: string) => {
      submit({ id: request.id, decision: "reject", rejectionReason: reason });
    },
    [request.id, submit],
  );

  const rulesJsx = (
    <FilePermissionRuleEditor
      label={filePath}
      modeGroupName={`path-rule-mode-${request.id}`}
      rule={rule}
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
      secondaryAction={
        folder && isSkipped
          ? {
              label: "Allow Folder for Session",
              title: `Allow now and auto-approve access under ${folder} for this session`,
              onClick: handleAllowFolder,
            }
          : undefined
      }
      onReject={handleReject}
      followUpRef={followUpRef}
    >
      <div class="card-label">Outside Workspace Access</div>
      <pre class="command-box">{filePath}</pre>
    </ApprovalLayout>
  );
}
