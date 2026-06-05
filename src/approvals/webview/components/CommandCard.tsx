import type { ApprovalRequest, DecisionMessage, RuleEntry } from "../types.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

import { ApprovalLayout } from "./ApprovalLayout.js";
import type { RefObject } from "preact";
import { RuleRow } from "./RuleRow.js";

interface CommandCardProps {
  request: ApprovalRequest;
  submit: (data: Omit<DecisionMessage, "type">) => void;
  followUpRef: RefObject<string>;
  /**
   * Optional: request a regex suggestion from the current model in a fresh
   * context. Returns the suggested pattern string (no flags, no delimiters).
   * If absent, the "Suggest" button is hidden.
   */
  onSuggestRegex?: (args: {
    subCommand: string;
    fullCommand: string;
  }) => Promise<string>;
}

interface SuggestState {
  status: "idle" | "loading" | "error";
  error?: string;
  pattern?: string;
  kind?: "regex" | "prefix";
}

/**
 * Break a command into whitespace-delimited tokens (respecting quotes), each
 * paired with the cumulative prefix up to and including it. The prefixes are
 * true substrings of the trimmed command, so any of them is a valid prefix
 * rule. e.g. `git commit -m "x"` → git / git commit / git commit -m / git commit -m "x".
 */
function commandTokenPrefixes(
  command: string,
): Array<{ token: string; prefix: string }> {
  const cmd = command.trim();
  const result: Array<{ token: string; prefix: string }> = [];
  let tokenStart = -1;
  let inSingle = false;
  let inDouble = false;
  const flush = (end: number) => {
    if (tokenStart >= 0) {
      result.push({ token: cmd.slice(tokenStart, end), prefix: cmd.slice(0, end) });
      tokenStart = -1;
    }
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "\\" && i + 1 < cmd.length && !inSingle) {
      if (tokenStart < 0) tokenStart = i;
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      if (tokenStart < 0) tokenStart = i;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      if (tokenStart < 0) tokenStart = i;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      flush(i);
      continue;
    }
    if (tokenStart < 0) tokenStart = i;
  }
  flush(cmd.length);
  return result;
}

export function CommandCard({
  request,
  submit,
  followUpRef,
  onSuggestRegex,
}: CommandCardProps) {
  const originalCommand = request.command ?? "";
  const [command, setCommand] = useState(originalCommand);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
        scope: "skip" as const,
      };
    }),
  );

  const isEdited = command !== originalCommand;

  // Snapshot of initial rules for dirty detection — only show "Save Rules"
  // when the user actually modifies something (not just because existing rules match)
  const initialRules = useMemo(
    () =>
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
          scope: "skip" as const,
        };
      }),
    [],
  );

  const rulesModified = rules.some((rule, i) => {
    const initial = initialRules[i];
    if (!initial) return true;
    return (
      rule.pattern !== initial.pattern ||
      rule.mode !== initial.mode ||
      rule.scope !== initial.scope
    );
  });

  // Auto-size on command change
  useEffect(() => {
    const el = textareaRef.current;
    if (el && el.clientWidth > 0) {
      el.style.height = "auto";
      el.style.height = el.scrollHeight + "px";
    }
  }, [command]);

  // Re-run sizing when the panel becomes visible (clientWidth goes from 0 to real value)
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    let lastWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w !== lastWidth && w > 0) {
        lastWidth = w;
        el.style.height = "auto";
        el.style.height = el.scrollHeight + "px";
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleRun = useCallback(() => {
    submit({
      id: request.id,
      decision: isEdited ? "edit" : "run-once",
      ...(isEdited && { editedCommand: command }),
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [request.id, isEdited, command, submit, followUpRef]);

  const handleSaveAndRun = useCallback(() => {
    const activeRules = rules.filter((r) => r.scope !== "skip");
    submit({
      id: request.id,
      decision: "run-once",
      rules: activeRules.length > 0 ? rules : undefined,
      ...(isEdited && { editedCommand: command }),
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [request.id, rules, isEdited, command, submit, followUpRef]);

  const handleReject = useCallback(
    (reason?: string) => {
      submit({ id: request.id, decision: "reject", rejectionReason: reason });
    },
    [request.id, submit],
  );

  const updateRule = useCallback((index: number, value: RuleEntry) => {
    setRules((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }, []);

  const [suggestStates, setSuggestStates] = useState<
    Record<number, SuggestState>
  >({});

  const handleSuggestRegex = useCallback(
    (index: number, subCommand: string) => {
      if (!onSuggestRegex) return;
      const current = rules[index];
      if (!current) return;
      updateRule(index, {
        ...current,
        mode: "regex",
        scope: current.scope === "skip" ? "session" : current.scope,
      });
      setSuggestStates((prev) => ({ ...prev, [index]: { status: "loading" } }));
      void (async () => {
        try {
          const pattern = await onSuggestRegex({
            subCommand,
            fullCommand: originalCommand,
          });
          const trimmed = pattern.trim();
          if (!trimmed) throw new Error("Empty suggestion");
          setSuggestStates((prev) => ({
            ...prev,
            [index]: { status: "idle", pattern: trimmed, kind: "regex" },
          }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setSuggestStates((prev) => ({
            ...prev,
            [index]: { status: "error", error: message },
          }));
        }
      })();
    },
    [onSuggestRegex, originalCommand, rules, updateRule],
  );

  const handleSuggestPrefix = useCallback(
    (index: number, prefix: string) => {
      const current = rules[index];
      if (!current) return;
      updateRule(index, {
        ...current,
        mode: "prefix",
        scope: current.scope === "skip" ? "session" : current.scope,
      });
      setSuggestStates((prev) => ({
        ...prev,
        [index]: { status: "idle", pattern: prefix, kind: "prefix" },
      }));
    },
    [rules, updateRule],
  );

  const handleSelectPrefix = useCallback((index: number, prefix: string) => {
    setSuggestStates((prev) => {
      const current = prev[index];
      if (!current) return prev;
      return { ...prev, [index]: { ...current, pattern: prefix } };
    });
  }, []);

  const rulesJsx =
    subCommands.length > 0 ? (
      <>
        {subCommands.map((entry, i) => {
          const state = suggestStates[i] ?? { status: "idle" };
          const rule = rules[i];
          if (!rule) return null;
          // Suggest a broader prefix for new rules whose command has more than
          // the leading token, and let the user pick the boundary (command vs.
          // sub-command vs. …) from the command's tokens.
          const tokenPrefixes = entry.existingRule
            ? []
            : commandTokenPrefixes(entry.command);
          const canSuggestPrefix = tokenPrefixes.length > 1;
          const prefixSuggestion = tokenPrefixes[0]?.prefix ?? "";
          return (
            <RuleRow
              key={i}
              entry={entry}
              value={rule}
              modeGroupName={`mode-${i}-${entry.command}`}
              onChange={(v) => updateRule(i, v)}
              onSuggestRegex={
                onSuggestRegex
                  ? () => handleSuggestRegex(i, entry.command)
                  : undefined
              }
              onSuggestPrefix={
                canSuggestPrefix
                  ? () => handleSuggestPrefix(i, prefixSuggestion)
                  : undefined
              }
              prefixSuggestion={canSuggestPrefix ? prefixSuggestion : undefined}
              prefixTokens={canSuggestPrefix ? tokenPrefixes : undefined}
              onSelectPrefix={(p) => handleSelectPrefix(i, p)}
              suggestKind={state.kind}
              suggestedPattern={state.pattern}
              onAcceptSuggestion={
                state.pattern
                  ? () => {
                      updateRule(i, { ...rule, pattern: state.pattern! });
                      setSuggestStates((prev) => ({
                        ...prev,
                        [i]: { status: "idle" },
                      }));
                    }
                  : undefined
              }
              onDismissSuggestion={() =>
                setSuggestStates((prev) => ({
                  ...prev,
                  [i]: { status: "idle" },
                }))
              }
              suggestStatus={state.status}
              suggestError={state.error}
            />
          );
        })}
      </>
    ) : undefined;

  const reason = request.reason;

  return (
    <ApprovalLayout
      queuePosition={request.queuePosition}
      queueTotal={request.queueTotal}
      rulesContent={rulesJsx}
      rulesModified={rulesModified}
      primaryLabel="Run"
      primaryWithRulesLabel="Save Rules & Run"
      onAccept={handleRun}
      onSaveAndAccept={handleSaveAndRun}
      onReject={handleReject}
      followUpRef={followUpRef}
    >
      {reason && (
        <div class="command-reason">
          <span class="codicon codicon-info" />
          <span>{reason}</span>
        </div>
      )}
      <div class="terminal-box">
        <div class="terminal-header">
          <span class="codicon codicon-terminal" />
          <span>Command</span>
          {isEdited && (
            <span class="edited-badge">
              <span class="codicon codicon-edit" /> modified
            </span>
          )}
          {request.cwd && (
            <span class="terminal-cwd" title={request.cwd}>
              <span class="codicon codicon-folder" />
              <span class="terminal-cwd-path">{request.cwd}</span>
            </span>
          )}
        </div>
        <div class="terminal-body">
          <span class="terminal-prompt">$</span>
          <textarea
            ref={textareaRef}
            class={`terminal-input ${isEdited ? "edited" : ""}`}
            value={command}
            onInput={(e) => setCommand((e.target as HTMLTextAreaElement).value)}
            rows={1}
            spellcheck={false}
          />
        </div>
      </div>
    </ApprovalLayout>
  );
}
