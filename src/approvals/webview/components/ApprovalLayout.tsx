import { useState } from "preact/hooks";
import type { ComponentChildren, RefObject } from "preact";

export interface ApprovalLayoutProps {
  queuePosition?: number;
  queueTotal?: number;
  /** Card-specific content (terminal box, file card, rename display, path) */
  children: ComponentChildren;
  /** Rules editor JSX, rendered inside collapsible section */
  rulesContent?: ComponentChildren;
  /** Whether any rule has been modified from defaults */
  rulesModified: boolean;
  /** Button label when rules are NOT modified */
  primaryLabel: string;
  /** Button label when rules ARE modified */
  primaryWithRulesLabel: string;
  onAccept: () => void;
  onSaveAndAccept: () => void;
  onReject: (reason?: string) => void;
  followUpRef: RefObject<string>;
}

export function ApprovalLayout({
  queuePosition,
  queueTotal,
  children,
  rulesContent,
  rulesModified,
  primaryLabel,
  primaryWithRulesLabel,
  onAccept,
  onSaveAndAccept,
  onReject,
  followUpRef,
}: ApprovalLayoutProps) {
  const [rulesOpen, setRulesOpen] = useState(false);

  const badge =
    queueTotal && queueTotal > 1 ? `${queuePosition} of ${queueTotal}` : "";

  const handleReject = () => {
    const text = followUpRef.current?.trim() || undefined;
    followUpRef.current = ""; // Clear so submit wrapper doesn't also add as followUp
    onReject(text);
  };

  return (
    <div>
      {/* Header */}
      <div class="header">
        <span class="header-title">
          <span class="codicon codicon-warning" /> APPROVAL REQUIRED
        </span>
        {badge && <span class="badge">{badge}</span>}
      </div>

      {/* Card-specific content */}
      {children}

      {/* Collapsible auto-approval rules */}
      {rulesContent && (
        <div class="rules-collapsible">
          <button
            type="button"
            class="rules-collapse-toggle"
            onClick={() => setRulesOpen(!rulesOpen)}
          >
            <span
              class={`codicon codicon-chevron-${rulesOpen ? "down" : "right"}`}
            />
            <span>Auto Approval Rules</span>
            {rulesModified && (
              <span class="rules-modified-indicator">Modified</span>
            )}
          </button>
          {rulesOpen && <div class="rules-collapse-body">{rulesContent}</div>}
        </div>
      )}

      {/* Message textarea (follow-up on accept, rejection reason on reject) */}
      <div class="follow-up-section">
        <div class="follow-up-label">
          <span class="codicon codicon-comment" /> Follow Up / Rejection Reason
        </div>
        <textarea
          class="text-input textarea follow-up-input"
          rows={2}
          placeholder="Add a message to follow up on on accept or provide a reason for rejection..."
          onInput={(e) => {
            followUpRef.current = (e.target as HTMLTextAreaElement).value;
          }}
        />
      </div>

      {/* Action buttons */}
      <div class="button-row">
        {rulesModified ? (
          <button class="btn btn-primary" onClick={onSaveAndAccept}>
            {primaryWithRulesLabel}
          </button>
        ) : (
          <button class="btn btn-primary" onClick={onAccept}>
            {primaryLabel}
          </button>
        )}
        <button class="btn btn-danger" onClick={handleReject}>
          Reject
        </button>
      </div>
    </div>
  );
}
