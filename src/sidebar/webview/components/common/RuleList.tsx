import type { CommandRule, PathRule, PostCommand } from "../../types.js";

interface Props {
  rules: (CommandRule | PathRule)[];
  editCommand?: string;
  removeCommand: string;
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
      {rules.map((r) => (
        <div key={r.pattern + r.mode} class="rule-row">
          <span class="rule-mode">{r.mode}</span>
          <span
            class="rule-pattern"
            title={editCommand ? "Click to edit" : r.pattern}
            onClick={
              editCommand
                ? () =>
                    postCommand(editCommand, {
                      pattern: r.pattern,
                      mode: r.mode,
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
              onClick={() =>
                postCommand(editCommand, {
                  pattern: r.pattern,
                  mode: r.mode,
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
            onClick={() =>
              postCommand(removeCommand, {
                pattern: r.pattern,
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
