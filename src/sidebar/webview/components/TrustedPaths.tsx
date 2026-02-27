import type { SidebarState, PostCommand } from "../types.js";
import { RuleList } from "./common/RuleList.js";
import { SessionBlock } from "./common/SessionBlock.js";
import { CollapsibleSection } from "./common/CollapsibleSection.js";

interface Props {
  state: SidebarState;
  postCommand: PostCommand;
}

export function TrustedPaths({ state, postCommand }: Props) {
  const { globalPathRules, projectPathRules, activeSessions } = state;

  const sessionsWithPathRules = (activeSessions ?? []).filter(
    (s) => s.pathRules.length > 0,
  );

  return (
    <CollapsibleSection title="Trusted Paths">
      <p class="help-text">Outside-workspace paths that tools can access.</p>
      <div class="subsection-label">Global Rules</div>
      {(globalPathRules ?? []).length > 0 ? (
        <RuleList
          rules={globalPathRules!}
          editCommand="editGlobalPathRule"
          removeCommand="removeGlobalPathRule"
          postCommand={postCommand}
        />
      ) : (
        <p class="help-text">No trusted paths configured.</p>
      )}
      {(projectPathRules ?? []).length > 0 && (
        <div style={{ marginTop: "10px" }}>
          <div class="subsection-label">Project Rules</div>
          <RuleList
            rules={projectPathRules!}
            editCommand="editProjectPathRule"
            removeCommand="removeProjectPathRule"
            postCommand={postCommand}
          />
        </div>
      )}
      {sessionsWithPathRules.length > 0 && (
        <div style={{ marginTop: "10px" }}>
          <div class="subsection-label">Session Rules</div>
          {sessionsWithPathRules.map((s) => (
            <SessionBlock key={s.id} sessionId={s.id}>
              <RuleList
                rules={s.pathRules}
                removeCommand="removeSessionPathRule"
                postCommand={postCommand}
                sessionId={s.id}
              />
            </SessionBlock>
          ))}
        </div>
      )}
    </CollapsibleSection>
  );
}
