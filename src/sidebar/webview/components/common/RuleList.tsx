import type {
  CommandRule,
  PathRule,
  PostCommand,
  RuleEditCommand,
  RuleRemoveCommand,
} from "../../types.js";

interface Props {
  rules: (CommandRule | PathRule)[];
  editCommand?: RuleEditCommand;
  removeCommand: RuleRemoveCommand;
  postCommand: PostCommand;
  sessionId?: string;
}

export function RuleList({
  rules,
  editCommand,
  removeCommand,
  postCommand,
  sessionId,
}: Props) {
  if (rules.length === 0) return null;

  return (
    <>
      {rules.map((r, i) => (
        <div
          key={`${r.pattern}\0${r.mode}\0${"decision" in r ? (r.decision ?? "legacy") : "path"}\0${i}`}
          class="rule-row"
        >
          <span class="rule-mode">
            {"decision" in r ? `${r.decision ?? "legacy"} · ` : ""}
            {r.mode}
          </span>
          <span
            class="rule-pattern"
            title={editCommand ? "Click to edit" : r.pattern}
            onClick={
              editCommand
                ? () =>
                    postCommand(editCommand, {
                      pattern: r.pattern,
                      mode: r.mode,
                      ...("decision" in r ? { decision: r.decision } : {}),
                      ...(sessionId ? { sessionId } : {}),
                    })
                : undefined
            }
          >
            {r.pattern}
          </span>
          {editCommand && (
            <a
              class="rule-action"
              title="Edit"
              aria-label={`Edit rule ${r.pattern}`}
              role="button"
              tabIndex={0}
              onClick={() =>
                postCommand(editCommand, {
                  pattern: r.pattern,
                  mode: r.mode,
                  ...("decision" in r ? { decision: r.decision } : {}),
                  ...(sessionId ? { sessionId } : {}),
                })
              }
            >
              ✎
            </a>
          )}
          <a
            class="rule-action rule-delete"
            title="Remove"
            aria-label={`Remove rule ${r.pattern}`}
            role="button"
            tabIndex={0}
            onClick={() =>
              postCommand(removeCommand, {
                pattern: r.pattern,
                mode: r.mode,
                ...("decision" in r ? { decision: r.decision } : {}),
                ...(sessionId ? { sessionId } : {}),
              })
            }
          >
            ✕
          </a>
        </div>
      ))}
    </>
  );
}
