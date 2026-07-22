import type { PostCommand, SidebarState } from "../types.js";

import { CollapsibleSection } from "./common/CollapsibleSection.js";
import { RuleList } from "./common/RuleList.js";
import { SessionBlock } from "./common/SessionBlock.js";

interface Props {
  state: SidebarState;
  postCommand: PostCommand;
}

export function TrustedCommands({ state, postCommand }: Props) {
  const { globalCommandRules, projectCommandRules, activeSessions } = state;

  const sessionsWithRules = (activeSessions ?? []).filter(
    (s) => s.commandRules.length > 0,
  );

  return (
    <CollapsibleSection title="Trusted Commands">
      <p class="help-text">
        Exact and prefix allow rules may run matching commands with normal user
        permissions outside the Protected Terminal when every command segment
        matches. Regex and legacy approval-only rules do not grant native
        authority.
      </p>
      <div class="subsection-label">Global Rules</div>
      {(globalCommandRules ?? []).length > 0 ? (
        <RuleList
          rules={globalCommandRules!}
          editCommand="editGlobalRule"
          removeCommand="removeGlobalRule"
          postCommand={postCommand}
        />
      ) : (
        <p class="help-text">No global rules configured.</p>
      )}
      {(projectCommandRules ?? []).length > 0 && (
        <div style={{ marginTop: "10px" }}>
          <div class="subsection-label">Project Rules</div>
          <RuleList
            rules={projectCommandRules!}
            editCommand="editProjectRule"
            removeCommand="removeProjectRule"
            postCommand={postCommand}
          />
        </div>
      )}
      <button
        class="btn btn-secondary"
        style={{ marginTop: "6px" }}
        title="Add a command policy; exact and prefix allow rules may also grant native execution authority"
        onClick={() => postCommand("addGlobalRule")}
      >
        + Add Rule
      </button>
      {sessionsWithRules.length > 0 && (
        <div style={{ marginTop: "10px" }}>
          <div class="subsection-label">Session Rules</div>
          {sessionsWithRules.map((s) => (
            <SessionBlock key={s.id} sessionId={s.id}>
              <RuleList
                rules={s.commandRules}
                editCommand="editSessionRule"
                removeCommand="removeSessionRule"
                postCommand={postCommand}
                sessionId={s.id}
              />
              <a
                class="link"
                title="Remove every trusted command rule for this session"
                onClick={() =>
                  postCommand("clearSessionRules", { sessionId: s.id })
                }
              >
                Clear
              </a>
            </SessionBlock>
          ))}
          <a
            class="link"
            style={{ display: "block", marginTop: "6px" }}
            title="Remove trusted command rules for all sessions"
            onClick={() => postCommand("clearAllSessions")}
          >
            Clear All Sessions
          </a>
        </div>
      )}
    </CollapsibleSection>
  );
}
