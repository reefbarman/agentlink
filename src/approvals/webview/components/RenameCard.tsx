import type {
  ApprovalRequest,
  DecisionMessage,
} from "@agentlink/protocol/approval-transport";
import {
  FilePermissionRuleEditor,
  useFilePermissionRule,
  writeTrustFields,
} from "./FilePermissionRuleEditor.js";

import { ApprovalLayout } from "./ApprovalLayout.js";
import type { RefObject } from "preact";
import { useCallback } from "preact/hooks";

interface RenameCardProps {
  request: ApprovalRequest;
  submit: (data: Omit<DecisionMessage, "type">) => void;
  followUpRef: RefObject<string>;
}

export function RenameCard({ request, submit, followUpRef }: RenameCardProps) {
  const oldName = request.oldName ?? "?";
  const newName = request.newName ?? "?";
  const affectedFiles = request.affectedFiles ?? [];
  const totalChanges = request.totalChanges ?? 0;
  const fileCount = affectedFiles.length;

  // A rename spans files, so the rule starts on "All files"; the path modes
  // start from the first affected file.
  const firstPath = affectedFiles[0]?.path ?? "";
  const rule = useFilePermissionRule({
    filePath: firstPath,
    allowAllFiles: true,
    defaultMatch: "all",
  });
  const { isSkipped, scope } = rule;
  const trust = writeTrustFields(rule);

  const handleAccept = useCallback(() => {
    submit({
      id: request.id,
      decision: "accept",
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [request.id, submit, followUpRef]);

  const handleSaveAndAccept = useCallback(() => {
    const decision =
      scope === "session"
        ? "accept-session"
        : scope === "project"
          ? "accept-project"
          : "accept-always";
    submit({
      id: request.id,
      decision,
      ...trust,
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [
    request.id,
    scope,
    trust.trustScope,
    trust.rulePattern,
    trust.ruleMode,
    submit,
    followUpRef,
  ]);

  const handleReject = useCallback(
    (reason?: string) => {
      submit({ id: request.id, decision: "reject", rejectionReason: reason });
    },
    [request.id, submit],
  );

  const rulesJsx = (
    <FilePermissionRuleEditor
      label={firstPath}
      modeGroupName={`rename-rule-mode-${request.id}`}
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
      purpose="Rename a symbol across files"
      rulesContent={rulesJsx}
      rulesModified={!isSkipped}
      primaryLabel="Accept"
      primaryWithRulesLabel="Save Rule & Accept"
      onAccept={handleAccept}
      onSaveAndAccept={handleSaveAndAccept}
      onReject={handleReject}
      followUpRef={followUpRef}
    >
      {/* Rename display */}
      <div class="rename-box">
        <div class="rename-header">
          <span class="codicon codicon-symbol-method" />
          <span>Rename Symbol</span>
        </div>
        <div class="rename-names">
          <span class="rename-old">{oldName}</span>
          <span class="codicon codicon-arrow-right rename-arrow" />
          <span class="rename-new">{newName}</span>
        </div>
      </div>

      {/* Affected files list */}
      <div class="rename-files">
        <div class="rename-files-header">
          Affected Files
          <span class="badge rename-summary-badge">
            {totalChanges} change{totalChanges !== 1 ? "s" : ""} across{" "}
            {fileCount} file{fileCount !== 1 ? "s" : ""}
          </span>
        </div>
        <div class="rename-files-list">
          {affectedFiles.map((file) => (
            <div key={file.path} class="rename-file-entry">
              <span class="codicon codicon-file" />
              <span class="rename-file-path">{file.path}</span>
              <span class="rename-change-count">{file.changes}</span>
            </div>
          ))}
        </div>
      </div>
    </ApprovalLayout>
  );
}
