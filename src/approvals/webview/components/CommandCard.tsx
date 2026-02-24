import { useState, useRef, useEffect, useCallback } from "preact/hooks";
import type { ApprovalRequest, RuleEntry, DecisionMessage } from "../types.js";
import { RuleRow } from "./RuleRow.js";
import { RejectionSection } from "./RejectionSection.js";

interface CommandCardProps {
  request: ApprovalRequest;
  submit: (data: Omit<DecisionMessage, "type">) => void;
}

export function CommandCard({ request, submit }: CommandCardProps) {
  const originalCommand = request.command ?? "";
  const [command, setCommand] = useState(originalCommand);
  const [showReject, setShowReject] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Initialize rule entries from sub-commands
  const subCommands = request.subCommands ?? [];
  const [rules, setRules] = useState<RuleEntry[]>(() =>
    subCommands.map((entry) => {
      if (entry.existingRule) {
        return {
          pattern: entry.existingRule.pattern,
          mode: entry.existingRule.mode,
          scope: entry.existingRule.scope,
        };
      }
      return {
        pattern: entry.command,
        mode: "prefix" as const,
        scope: "session" as const,
      };
    }),
  );

  const isEdited = command !== originalCommand;

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = el.scrollHeight + "px";
    }
  }, [command]);

  const handleRun = useCallback(() => {
    const data: Omit<DecisionMessage, "type"> = {
      id: request.id,
      decision: isEdited ? "edit" : "run-once",
      ...(isEdited && { editedCommand: command }),
    };
    submit(data);
  }, [request.id, isEdited, command, submit]);

  const handleSaveAndRun = useCallback(() => {
    const activeRules = rules.filter((r) => r.scope !== "skip");
    const data: Omit<DecisionMessage, "type"> = {
      id: request.id,
      decision: "run-once",
      rules: activeRules.length > 0 ? rules : undefined,
      ...(isEdited && { editedCommand: command }),
    };
    submit(data);
  }, [request.id, rules, isEdited, command, submit]);

  const handleReject = useCallback(
    (reason?: string) => {
      submit({ id: request.id, decision: "reject", rejectionReason: reason });
    },
    [request.id, submit],
  );

  const updateRule = useCallback(
    (index: number, value: RuleEntry) => {
      setRules((prev) => {
        const next = [...prev];
        next[index] = value;
        return next;
      });
    },
    [],
  );

  const hasActiveRules = rules.some((r) => r.scope !== "skip");
  const badge =
    request.queueTotal && request.queueTotal > 1
      ? `${request.queuePosition} of ${request.queueTotal}`
      : "";

  if (showReject) {
    return (
      <RejectionSection
        onSubmit={handleReject}
        onCancel={() => setShowReject(false)}
      />
    );
  }

  return (
    <div>
      <div class="header">
        <span class="header-title">
          <span class="codicon codicon-warning" /> APPROVAL REQUIRED
        </span>
        {badge && <span class="badge">{badge}</span>}
      </div>

      {/* Command display */}
      <div class="terminal-box">
        <div class="terminal-header">
          <span class="codicon codicon-terminal" />
          <span>Command</span>
          {isEdited && (
            <span class="edited-badge">
              <span class="codicon codicon-edit" /> modified
            </span>
          )}
        </div>
        <div class="terminal-body">
          <span class="terminal-prompt">$</span>
          <textarea
            ref={textareaRef}
            class={`terminal-input ${isEdited ? "edited" : ""}`}
            value={command}
            onInput={(e) =>
              setCommand((e.target as HTMLTextAreaElement).value)
            }
            rows={1}
            spellcheck={false}
          />
        </div>
      </div>

      {/* Action buttons */}
      <div class="button-row">
        <button class="btn btn-primary" onClick={handleRun}>
          Run
        </button>
        <button class="btn btn-danger" onClick={() => setShowReject(true)}>
          Reject
        </button>
      </div>

      {/* Rule editor */}
      {subCommands.length > 0 && (
        <div class="rules-section">
          <div class="rules-header">Rules</div>
          {subCommands.map((entry, i) => (
            <RuleRow
              key={i}
              entry={entry}
              value={rules[i]}
              onChange={(v) => updateRule(i, v)}
            />
          ))}
          {hasActiveRules && (
            <button
              class="btn btn-primary save-rules-btn"
              onClick={handleSaveAndRun}
            >
              Save Rules & Run
            </button>
          )}
        </div>
      )}
    </div>
  );
}
