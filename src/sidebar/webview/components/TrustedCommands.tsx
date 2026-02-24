import type { SidebarState, PostCommand } from "../types.js";
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
    <div class="section">
      <h3>Trusted Commands</h3>
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
            onClick={() => postCommand("clearAllSessions")}
          >
            Clear All Sessions
          </a>
        </div>
      )}
    </div>
  );
}
