import type { SidebarState, PostCommand } from "../types.js";
import { RuleList } from "./common/RuleList.js";
import { SessionBlock } from "./common/SessionBlock.js";
import { CollapsibleSection } from "./common/CollapsibleSection.js";

interface Props {
  state: SidebarState;
  postCommand: PostCommand;
}

export function WriteApproval({ state, postCommand }: Props) {
  const {
    writeApproval,
    globalWriteRules,
    projectWriteRules,
    settingsWriteRules,
    activeSessions,
    hasWorkspace,
  } = state;

  const label =
    writeApproval === "global"
      ? "Always auto-accept"
      : writeApproval === "project"
        ? "Project auto-accept"
        : writeApproval === "session"
          ? "Session auto-accept"
          : "Prompt each time";

  const badge =
    writeApproval === "global" ? (
      <span class="badge badge-warn">Global</span>
    ) : writeApproval === "project" ? (
      <span class="badge badge-warn">Project</span>
    ) : writeApproval === "session" ? (
      <span class="badge badge-warn">Session</span>
    ) : (
      <span class="badge badge-ok">Active</span>
    );

  const handleModeChange = (e: Event) => {
    const value = (e.target as HTMLSelectElement).value;
    postCommand("setWriteApproval", { mode: value });
  };

  const sessionsWithWriteRules = (activeSessions ?? []).filter(
    (s) => s.writeRules.length > 0,
  );

  const hasAnyWriteRules =
    (settingsWriteRules ?? []).length > 0 ||
    (globalWriteRules ?? []).length > 0 ||
    (projectWriteRules ?? []).length > 0 ||
    sessionsWithWriteRules.length > 0;

  return (
    <CollapsibleSection title="Write Approval">
      <div class="info-row">
        <select
          class="select"
          value={writeApproval}
          onChange={handleModeChange}
        >
          <option value="prompt">Prompt each time</option>
          <option value="session">Session auto-accept</option>
          <option value="project" disabled={!hasWorkspace}>Project auto-accept</option>
          <option value="global">Always auto-accept</option>
        </select>
        {badge}
      </div>
      {hasAnyWriteRules && (
        <div style={{ marginTop: "10px" }}>
          <p class="help-text">
            Files matching these rules skip the diff view.
          </p>
          {(settingsWriteRules ?? []).length > 0 &&
            (settingsWriteRules ?? []).map((p) => (
              <div key={p} class="rule-row">
                <span class="rule-mode">glob</span>
                <span class="rule-pattern">{p}</span>
                <span class="help-text" style={{ margin: 0, fontSize: "10px" }}>
                  (settings)
                </span>
              </div>
            ))}
          {(globalWriteRules ?? []).length > 0 && (
            <>
              <div class="subsection-label">Global Rules</div>
              <RuleList
                rules={globalWriteRules!}
                editCommand="editGlobalWriteRule"
                removeCommand="removeGlobalWriteRule"
                postCommand={postCommand}
              />
            </>
          )}
          {(projectWriteRules ?? []).length > 0 && (
            <>
              <div class="subsection-label">Project Rules</div>
              <RuleList
                rules={projectWriteRules!}
                editCommand="editProjectWriteRule"
                removeCommand="removeProjectWriteRule"
                postCommand={postCommand}
              />
            </>
          )}
          {sessionsWithWriteRules.length > 0 && (
            <div style={{ marginTop: "10px" }}>
              <div class="subsection-label">Session Rules</div>
              {sessionsWithWriteRules.map((s) => (
                <SessionBlock
                  key={s.id}
                  sessionId={s.id}
                  clientName={s.clientName}
                  clientVersion={s.clientVersion}
                  agentId={s.agentId}
                >
                  <RuleList
                    rules={s.writeRules}
                    removeCommand="removeSessionWriteRule"
                    postCommand={postCommand}
                    sessionId={s.id}
                  />
                </SessionBlock>
              ))}
            </div>
          )}
        </div>
      )}
    </CollapsibleSection>
  );
}
