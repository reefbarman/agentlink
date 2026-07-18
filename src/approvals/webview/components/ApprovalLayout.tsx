import type { ComponentChildren, RefObject } from "preact";

import type { ApprovalProjectContext } from "../types";
import { useState } from "preact/hooks";

export interface ApprovalLayoutProps {
  queuePosition?: number;
  queueTotal?: number;
  sourceProject?: ApprovalProjectContext;
  targetProject?: ApprovalProjectContext;
  targetPath?: string;
  /** Short description of what capability/action needs approval. */
  purpose: string;
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

export function ProjectContextBanner({
  sourceProject,
  targetProject,
  targetPath,
}: Pick<
  ApprovalLayoutProps,
  "sourceProject" | "targetProject" | "targetPath"
>) {
  if (!sourceProject && !targetProject && !targetPath) return null;

  const projects = [sourceProject, targetProject].filter(
    (project): project is ApprovalProjectContext => Boolean(project),
  );

  return (
    <div class="approval-project-context">
      {projects.length > 0 && (
        <div class="approval-project-route">
          <span class="codicon codicon-root-folder" />
          {projects.map((project, index) => (
            <span class="approval-project-route-entry" key={project.projectId}>
              {index > 0 && (
                <span
                  class="codicon codicon-arrow-right approval-project-route-arrow"
                  aria-hidden="true"
                />
              )}
              <span class="approval-project-name">{project.displayName}</span>
              {project.availability !== "available" && (
                <span class="approval-project-status">
                  {project.availability}
                </span>
              )}
            </span>
          ))}
        </div>
      )}
      {targetPath && (
        <div class="approval-project-target" title={targetPath}>
          {targetPath}
        </div>
      )}
    </div>
  );
}

export function ApprovalLayout({
  queuePosition,
  queueTotal,
  sourceProject,
  targetProject,
  targetPath,
  purpose,
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
    <div class="approval-card-shell">
      <div class="approval-card-scroll">
        {/* Header */}
        <div class="header">
          <div
            class="header-text"
            role="heading"
            aria-level={2}
            aria-label={`Approval required: ${purpose}`}
          >
            <span class="header-title">
              <span class="codicon codicon-warning" /> Approval required
            </span>
            <span class="header-purpose">{purpose}</span>
          </div>
          {badge && <span class="badge">{badge}</span>}
        </div>

        <ProjectContextBanner
          sourceProject={sourceProject}
          targetProject={targetProject}
          targetPath={targetPath}
        />

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
            <span class="codicon codicon-comment" /> Follow Up / Rejection
            Reason
          </div>
          <textarea
            class="text-input textarea follow-up-input"
            rows={2}
            placeholder="Add a message to follow up on accept or provide a reason for rejection..."
            onInput={(e) => {
              followUpRef.current = (e.target as HTMLTextAreaElement).value;
            }}
          />
        </div>
      </div>

      {/* Action buttons */}
      <div class="approval-card-footer">
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
    </div>
  );
}
