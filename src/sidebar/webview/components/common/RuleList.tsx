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

function commandRuleAuthorityLabel(rule: CommandRule): string {
  if (rule.decision === "allow") {
    return rule.mode === "regex" ? "allow (sandboxed)" : "allow (native)";
  }
  return rule.decision ?? "legacy approval only";
}

function commandRuleAuthorityTitle(rule: CommandRule): string {
  if (rule.decision === "allow" && rule.mode !== "regex") {
    return "Skips approval and may run outside the Protected Terminal with normal user permissions when every command segment matches an exact or prefix allow rule.";
  }
  if (rule.decision === "allow") {
    return "Skips approval when this regex matches, but does not grant native execution authority.";
  }
  if (rule.decision === undefined) {
    return "Legacy approval-only rule; skips repeat approval cards without granting native execution authority.";
  }
  return `${rule.decision} command rule`;
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
          <span
            class="rule-mode"
            title={"decision" in r ? commandRuleAuthorityTitle(r) : undefined}
          >
            {"decision" in r ? `${commandRuleAuthorityLabel(r)} · ` : ""}
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
