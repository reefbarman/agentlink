import type {
  WorkSummary,
  WorkSummaryCoverageNote,
  WorkSummaryDiff,
  WorkSummaryDiffHunk,
  WorkSummaryFileChange,
  WorkSummaryScope,
} from "@agentlink/protocol/final-status";
import { useMemo, useState } from "preact/hooks";

import type { RemoteWorkSummaryDetail } from "@agentlink/protocol/chat-transcript";
import { useRemoteWorkSummary } from "./RemoteToolDetail";

type ScopeKey = "since" | "session";

const OPERATION_LABEL: Record<WorkSummaryFileChange["operation"], string> = {
  created: "Created",
  modified: "Edited",
  deleted: "Deleted",
};

const COVERAGE_NOTE_TEXT: Record<WorkSummaryCoverageNote, string> = {
  shell_commands:
    "Shell commands ran. Files they changed are not included unless an AgentLink file tool also edited them.",
  mcp_tools:
    "MCP tools ran. Files they changed are not included unless an AgentLink file tool also edited them.",
  background_agents:
    "Background agents ran. Their changes appear in their own summaries.",
  capture_restarted:
    "This session was reloaded, so changes captured before the reload are not included.",
  storage_limit:
    "Some file contents exceeded the capture limit, so those diffs are unavailable.",
};

const OMISSION_TEXT: Record<NonNullable<WorkSummaryDiff["omitted"]>, string> = {
  too_large: "Diff too large to show.",
  binary: "Binary content, no diff shown.",
  content_unavailable: "Content was not retained, so no diff is available.",
  summary_budget: "Diff omitted to keep this summary small.",
};

/** Net counts for a file, or undefined when no single net diff exists. */
function fileCounts(
  file: WorkSummaryFileChange,
): { added: number; removed: number } | undefined {
  if (file.segments.length !== 1) return undefined;
  const [segment] = file.segments;
  if (segment?.added === undefined || segment.removed === undefined) {
    return undefined;
  }
  return { added: segment.added, removed: segment.removed };
}

function scopeTotals(scope: WorkSummaryScope) {
  let added = 0;
  let removed = 0;
  let uncounted = 0;
  for (const file of scope.files) {
    const counts = fileCounts(file);
    if (!counts) {
      uncounted += 1;
      continue;
    }
    added += counts.added;
    removed += counts.removed;
  }
  return { added, removed, uncounted };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Work summary loaded lazily over the browser relay. */
export function RemoteWorkSummaryBlock({
  reference,
  onOpenFile,
}: {
  reference: RemoteWorkSummaryDetail;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const { summary, loading, error } = useRemoteWorkSummary(reference);
  if (summary) {
    return <WorkSummaryBlock summary={summary} onOpenFile={onOpenFile} />;
  }
  return (
    <section class="work-summary" aria-label="Work summary">
      <div class="work-summary-header">
        <span class="work-summary-title">
          <i class="codicon codicon-diff" aria-hidden="true" />
          Work summary
        </span>
      </div>
      <div class="work-summary-muted work-summary-totals">
        {loading
          ? "Loading changes…"
          : (error ?? "Work summary is unavailable.")}
      </div>
    </section>
  );
}

export function WorkSummaryBlock({
  summary,
  onOpenFile,
}: {
  summary: WorkSummary;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const sessionScope = summary.sessionSameAsSince ? undefined : summary.session;
  const [scopeKey, setScopeKey] = useState<ScopeKey>("since");
  const [collapsed, setCollapsed] = useState(false);
  const scope =
    scopeKey === "session" && sessionScope
      ? sessionScope
      : summary.sinceSummary;
  const totals = useMemo(() => scopeTotals(scope), [scope]);
  const fileCount = scope.files.length + (scope.omittedFiles ?? 0);
  const capturedAt = new Date(summary.capturedAt).toLocaleString();

  return (
    <section
      class={`work-summary${collapsed ? " collapsed" : ""}`}
      aria-label="Work summary"
    >
      <div class="work-summary-header">
        <button
          type="button"
          class="work-summary-title work-summary-collapse"
          aria-expanded={!collapsed}
          title={collapsed ? "Show work summary" : "Hide work summary"}
          onClick={() => setCollapsed((value) => !value)}
        >
          <i
            class={`codicon codicon-chevron-${collapsed ? "right" : "down"}`}
            aria-hidden="true"
          />
          <i class="codicon codicon-diff" aria-hidden="true" />
          Work summary
          {collapsed && fileCount > 0 && (
            <span class="work-summary-collapsed-totals">
              <span>{plural(fileCount, "file")} changed</span>
              <DiffCounts added={totals.added} removed={totals.removed} />
            </span>
          )}
        </button>
        {!collapsed && sessionScope && (
          <div class="work-summary-scopes" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={scopeKey === "since"}
              class={`work-summary-scope${scopeKey === "since" ? " active" : ""}`}
              onClick={() => setScopeKey("since")}
            >
              Since previous summary
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scopeKey === "session"}
              class={`work-summary-scope${scopeKey === "session" ? " active" : ""}`}
              onClick={() => setScopeKey("session")}
            >
              Session so far
            </button>
          </div>
        )}
      </div>
      {!collapsed && (
        <WorkSummaryBody
          scope={scope}
          scopeKey={scopeKey}
          fileCount={fileCount}
          totals={totals}
          capturedAt={capturedAt}
          onOpenFile={onOpenFile}
        />
      )}
    </section>
  );
}

function WorkSummaryBody({
  scope,
  scopeKey,
  fileCount,
  totals,
  capturedAt,
  onOpenFile,
}: {
  scope: WorkSummaryScope;
  scopeKey: ScopeKey;
  fileCount: number;
  totals: ReturnType<typeof scopeTotals>;
  capturedAt: string;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  return (
    <>
      <div
        class="work-summary-totals"
        title={`Changes captured through AgentLink file tools, frozen at ${capturedAt}`}
      >
        {fileCount === 0 ? (
          <span>No file changes since the previous summary</span>
        ) : (
          <>
            <span>{plural(fileCount, "file")} changed</span>
            <DiffCounts added={totals.added} removed={totals.removed} />
            {totals.uncounted > 0 && (
              <span class="work-summary-muted">
                ({plural(totals.uncounted, "file")} without a net diff)
              </span>
            )}
          </>
        )}
      </div>
      {scope.files.length > 0 && (
        <ul class="work-summary-files">
          {scope.files.map((file) => (
            <WorkSummaryFileRow
              key={`${scopeKey}:${file.absolutePath}`}
              file={file}
              onOpenFile={onOpenFile}
            />
          ))}
        </ul>
      )}
      {scope.omittedFiles ? (
        <div class="work-summary-muted work-summary-omitted">
          {plural(scope.omittedFiles, "more file")} not listed.
        </div>
      ) : null}
      {scope.coverageNotes.length > 0 && (
        <ul class="work-summary-notes">
          {scope.coverageNotes.map((note) => (
            <li key={note}>
              <i class="codicon codicon-info" aria-hidden="true" />
              <span>{COVERAGE_NOTE_TEXT[note]}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function DiffCounts({ added, removed }: { added?: number; removed?: number }) {
  return (
    <span class="work-summary-counts">
      {added !== undefined && added > 0 && (
        <span class="work-summary-added">+{added}</span>
      )}
      {removed !== undefined && removed > 0 && (
        <span class="work-summary-removed">−{removed}</span>
      )}
    </span>
  );
}

function WorkSummaryFileRow({
  file,
  onOpenFile,
}: {
  file: WorkSummaryFileChange;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const counts = fileCounts(file);
  const mixed = file.segments.length > 1;
  const formatted = file.segments.some((segment) => segment.formatted);
  return (
    <li class="work-summary-file">
      <div class="work-summary-file-row">
        <button
          type="button"
          class="work-summary-file-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          title={file.path}
        >
          <i
            class={`codicon codicon-chevron-${expanded ? "down" : "right"}`}
            aria-hidden="true"
          />
          <span class={`work-summary-op work-summary-op-${file.operation}`}>
            {OPERATION_LABEL[file.operation]}
          </span>
          <span class="work-summary-path">{file.path}</span>
          {counts && (
            <DiffCounts added={counts.added} removed={counts.removed} />
          )}
          {mixed && (
            <span
              class="work-summary-badge work-summary-badge-warning"
              title="This file changed outside AgentLink between edits. Each captured run of edits is shown separately."
            >
              changed between edits
            </span>
          )}
          {file.diskCheck === "changed" && (
            <span
              class="work-summary-badge work-summary-badge-warning"
              title="The file on disk differed from AgentLink's last edit when this summary was captured."
            >
              changed on disk after
            </span>
          )}
          {file.diskCheck === "missing" && (
            <span class="work-summary-badge work-summary-badge-warning">
              missing on disk
            </span>
          )}
          {formatted && (
            <span
              class="work-summary-badge"
              title="Saved content includes format-on-save changes."
            >
              formatted
            </span>
          )}
        </button>
        {onOpenFile && file.operation !== "deleted" && (
          <button
            type="button"
            class="work-summary-open"
            title={`Open ${file.path}`}
            aria-label={`Open ${file.path}`}
            onClick={() => onOpenFile(file.absolutePath)}
          >
            <i class="codicon codicon-go-to-file" aria-hidden="true" />
          </button>
        )}
      </div>
      {expanded && (
        <div class="work-summary-detail">
          {file.segments.map((segment, index) => (
            <div key={index} class="work-summary-segment">
              {mixed && (
                <div class="work-summary-segment-header">
                  Captured edits {index + 1} of {file.segments.length}
                  <DiffCounts added={segment.added} removed={segment.removed} />
                </div>
              )}
              <WorkSummaryDiffView diff={segment} />
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

function WorkSummaryDiffView({ diff }: { diff: WorkSummaryDiff }) {
  if (!diff.hunks) {
    return (
      <div class="work-summary-muted work-summary-unavailable">
        {diff.omitted ? OMISSION_TEXT[diff.omitted] : "No diff available."}
      </div>
    );
  }
  if (diff.hunks.length === 0) {
    return <div class="work-summary-muted">Empty file.</div>;
  }
  return (
    <pre class="inline-diff-code work-summary-diff">
      {diff.hunks.map((hunk, index) => (
        <WorkSummaryHunk key={index} hunk={hunk} first={index === 0} />
      ))}
    </pre>
  );
}

function WorkSummaryHunk({
  hunk,
  first,
}: {
  hunk: WorkSummaryDiffHunk;
  first: boolean;
}) {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const rows = hunk.lines.map((line, index) => {
    const marker = line[0];
    const text = line.slice(1);
    if (marker === "\\") {
      return (
        <div key={index} class="inline-diff-line work-summary-eof">
          <span class="work-summary-line-no" />
          <span class="work-summary-line-no" />
          <span class="inline-diff-text">{text.trim()}</span>
        </div>
      );
    }
    const type =
      marker === "+" ? "added" : marker === "-" ? "removed" : "context";
    const oldNo = type === "added" ? "" : String(oldLine++);
    const newNo = type === "removed" ? "" : String(newLine++);
    return (
      <div key={index} class={`inline-diff-line inline-diff-${type}`}>
        <span class="work-summary-line-no">{oldNo}</span>
        <span class="work-summary-line-no">{newNo}</span>
        <span class="inline-diff-marker">
          {type === "removed" ? "−" : type === "added" ? "+" : " "}
        </span>
        <span class="inline-diff-text">{text}</span>
      </div>
    );
  });
  return (
    <>
      {!first && <div class="work-summary-hunk-gap">⋯</div>}
      {rows}
    </>
  );
}
