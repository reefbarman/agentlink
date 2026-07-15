import type { ComponentChildren } from "preact";

interface ErrorNoticeProps {
  tone: "recovering" | "recovered" | "error";
  title: string;
  status?: string;
  hint?: string;
  details?: string[];
  actions?: ComponentChildren;
}

export function ErrorNotice({
  tone,
  title,
  status,
  hint,
  details = [],
  actions,
}: ErrorNoticeProps) {
  const uniqueDetails = [...new Set(details.filter(Boolean))];
  const icon =
    tone === "recovering"
      ? "codicon-sync error-notice-icon-spinning"
      : tone === "recovered"
        ? "codicon-check"
        : "codicon-error";

  return (
    <section
      class={`error-notice error-notice-${tone}`}
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
    >
      <i class={`codicon ${icon} error-notice-icon`} aria-hidden="true" />
      <div class="error-notice-content">
        <div class="error-notice-summary">
          <strong class="error-notice-title">{title}</strong>
          {status && <span class="error-notice-status">{status}</span>}
        </div>
        {hint && <div class="error-notice-hint">{hint}</div>}
        {uniqueDetails.length > 0 && (
          <details class="error-notice-details">
            <summary>
              Technical details
              {uniqueDetails.length > 1 ? ` (${uniqueDetails.length})` : ""}
            </summary>
            <div class="error-notice-detail-list">
              {uniqueDetails.map((detail, index) => (
                <pre key={`${index}:${detail}`}>{detail}</pre>
              ))}
            </div>
          </details>
        )}
        {actions && <div class="error-notice-actions">{actions}</div>}
      </div>
    </section>
  );
}
