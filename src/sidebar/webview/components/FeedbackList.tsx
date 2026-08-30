import type {
  FeedbackEntry,
  FeedbackPriority,
  PostCommand,
} from "@agentlink/protocol/sidebar-transport";
import { useMemo, useState } from "preact/hooks";

import { CollapsibleSection } from "./common/CollapsibleSection.js";

interface Props {
  entries: FeedbackEntry[];
  postCommand: PostCommand;
}

type TriageFilter = "all" | "untriaged" | "triaged";
type GroupBy = "none" | "tool" | "priority";
type GroupSort = "name-asc" | "name-desc" | "count-desc" | "count-asc";

const PRIORITIES: FeedbackPriority[] = ["P0", "P1", "P2", "P3"];

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function groupEntries(
  entries: FeedbackEntry[],
  groupBy: GroupBy,
  groupSort: GroupSort,
): Array<{ label?: string; entries: FeedbackEntry[] }> {
  if (groupBy === "none") return [{ entries }];

  const grouped = new Map<string, FeedbackEntry[]>();
  for (const entry of entries) {
    const key =
      groupBy === "tool" ? entry.tool_name : (entry.priority ?? "Untriaged");
    const group = grouped.get(key) ?? [];
    group.push(entry);
    grouped.set(key, group);
  }

  const priorityOrder = [...PRIORITIES, "Untriaged"];
  const compareNames = (a: string, b: string) =>
    groupBy === "tool"
      ? a.localeCompare(b)
      : priorityOrder.indexOf(a as FeedbackPriority) -
        priorityOrder.indexOf(b as FeedbackPriority);
  const nameDirection = groupSort === "name-desc" ? -1 : 1;
  const keys = [...grouped.keys()].sort((a, b) => {
    if (groupSort === "name-asc" || groupSort === "name-desc") {
      return compareNames(a, b) * nameDirection;
    }
    const countDifference =
      (grouped.get(a)?.length ?? 0) - (grouped.get(b)?.length ?? 0);
    if (countDifference !== 0) {
      return groupSort === "count-desc" ? -countDifference : countDifference;
    }
    return compareNames(a, b);
  });
  return keys.map((label) => ({ label, entries: grouped.get(label) ?? [] }));
}

export function FeedbackList({ entries, postCommand }: Props) {
  const [triageFilter, setTriageFilter] = useState<TriageFilter>("untriaged");
  const [priorities, setPriorities] = useState<FeedbackPriority[]>(PRIORITIES);
  const [groupBy, setGroupBy] = useState<GroupBy>("tool");
  const [groupSort, setGroupSort] = useState<GroupSort>("count-desc");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const [query, setQuery] = useState("");

  const visibleEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return entries.filter((entry) => {
      if (triageFilter === "triaged" && !entry.triaged) return false;
      if (triageFilter === "untriaged" && entry.triaged) return false;
      if (
        triageFilter !== "untriaged" &&
        priorities.length < PRIORITIES.length &&
        (!entry.priority || !priorities.includes(entry.priority))
      ) {
        return false;
      }
      if (!normalizedQuery) return true;
      return `${entry.tool_name}\n${entry.feedback}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [entries, priorities, query, triageFilter]);

  const groups = useMemo(
    () => groupEntries(visibleEntries, groupBy, groupSort),
    [groupBy, groupSort, visibleEntries],
  );
  const visibleGroupKeys = groups.flatMap((group) =>
    group.label ? [`${groupBy}:${group.label}`] : [],
  );
  const allGroupsCollapsed =
    visibleGroupKeys.length > 0 &&
    visibleGroupKeys.every((key) => collapsedGroups.has(key));
  const badge = (
    <span
      class={`badge ${entries.length > 0 ? "badge-warn" : ""}`}
      style={{ marginLeft: "6px" }}
    >
      {entries.length}
    </span>
  );

  const togglePriority = (priority: FeedbackPriority) => {
    setPriorities((current) => {
      if (current.includes(priority)) {
        const next = current.filter((candidate) => candidate !== priority);
        return next.length > 0 ? next : current;
      }
      return PRIORITIES.filter(
        (candidate) => current.includes(candidate) || candidate === priority,
      );
    });
  };

  const renderEntry = (entry: FeedbackEntry) => (
    <div key={entry.id} class="feedback-row">
      <div class="feedback-header">
        <code class="tool-call-name">{entry.tool_name}</code>
        <span class="feedback-time" title={entry.timestamp}>
          {formatDate(entry.timestamp)} {formatTime(entry.timestamp)}
        </span>
      </div>
      <div class="feedback-text">{entry.feedback}</div>
      {entry.tool_params && (
        <details class="feedback-details">
          <summary>Params</summary>
          <pre>{entry.tool_params}</pre>
        </details>
      )}
      {entry.tool_result_summary && (
        <details class="feedback-details">
          <summary>Result</summary>
          <pre>{entry.tool_result_summary}</pre>
        </details>
      )}
      <div class="feedback-triage">
        <select
          class="feedback-priority-select"
          aria-label={`Priority for ${entry.tool_name} feedback`}
          value={entry.priority ?? ""}
          onChange={(event) => {
            const priority = event.currentTarget.value as FeedbackPriority;
            if (PRIORITIES.includes(priority)) {
              postCommand("triageFeedbackEntry", {
                id: entry.id,
                triaged: true,
                priority,
              });
            }
          }}
        >
          <option value="" disabled>
            Set priority…
          </option>
          {PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {priority}
            </option>
          ))}
        </select>
        {entry.triaged && (
          <button
            class="btn-inline"
            title="Return this feedback to the untriaged queue"
            onClick={() =>
              postCommand("triageFeedbackEntry", {
                id: entry.id,
                triaged: false,
              })
            }
          >
            Untriage
          </button>
        )}
        <button
          class="btn-inline btn-cancel feedback-delete"
          title="Delete this feedback item from the active list; the raw record remains on disk"
          onClick={() => postCommand("deleteFeedbackEntry", { id: entry.id })}
        >
          Delete
        </button>
      </div>
      <div class="feedback-meta">
        <span title="Extension version">v{entry.extension_version}</span>
        {entry.session_id && (
          <span title="Session ID">{entry.session_id.slice(0, 8)}</span>
        )}
        {entry.triaged_at && (
          <span title={`Triaged ${entry.triaged_at}`}>{entry.priority}</span>
        )}
      </div>
    </div>
  );

  return (
    <CollapsibleSection title="Feedback" titleExtra={badge}>
      <div class="feedback-actions">
        <button
          class="btn"
          title="Reload feedback entries from disk"
          onClick={() => postCommand("refreshFeedback")}
        >
          Refresh
        </button>
        {entries.length > 0 && (
          <button
            class="btn btn-cancel"
            title="Hide every active feedback entry; raw records remain in the append-only file"
            onClick={() => postCommand("clearAllFeedback")}
          >
            Hide All
          </button>
        )}
        <button
          class="btn"
          title="Open the feedback data file in the editor"
          onClick={() => postCommand("openFeedbackFile")}
        >
          Open File
        </button>
      </div>

      {entries.length > 0 ? (
        <>
          <div class="feedback-filters">
            <input
              class="feedback-search"
              type="search"
              value={query}
              placeholder="Search feedback or tool name…"
              aria-label="Search feedback text or tool name"
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
            <div class="feedback-filter-row">
              <label>
                State
                <select
                  value={triageFilter}
                  onChange={(event) =>
                    setTriageFilter(event.currentTarget.value as TriageFilter)
                  }
                >
                  <option value="all">All</option>
                  <option value="untriaged">Untriaged</option>
                  <option value="triaged">Triaged</option>
                </select>
              </label>
              <label>
                Group
                <select
                  value={groupBy}
                  onChange={(event) =>
                    setGroupBy(event.currentTarget.value as GroupBy)
                  }
                >
                  <option value="none">None</option>
                  <option value="tool">Tool name</option>
                  <option value="priority">Priority</option>
                </select>
              </label>
              <label>
                Sort groups
                <select
                  value={groupSort}
                  disabled={groupBy === "none"}
                  onChange={(event) =>
                    setGroupSort(event.currentTarget.value as GroupSort)
                  }
                >
                  <option value="count-desc">Count: high to low</option>
                  <option value="count-asc">Count: low to high</option>
                  <option value="name-asc">Name: A–Z</option>
                  <option value="name-desc">Name: Z–A</option>
                </select>
              </label>
            </div>
            <fieldset
              class="feedback-priority-filter"
              disabled={triageFilter === "untriaged"}
            >
              <legend>Priority</legend>
              {PRIORITIES.map((priority) => (
                <label key={priority}>
                  <input
                    type="checkbox"
                    checked={priorities.includes(priority)}
                    onChange={() => togglePriority(priority)}
                  />
                  {priority}
                </label>
              ))}
            </fieldset>
            <div class="feedback-filter-summary">
              <span class="feedback-visible-count">
                {visibleEntries.length} of {entries.length}
              </span>
              {groupBy !== "none" && visibleGroupKeys.length > 0 && (
                <button
                  class="btn-inline"
                  disabled={allGroupsCollapsed}
                  title="Collapse every visible feedback group"
                  onClick={() =>
                    setCollapsedGroups((current) => {
                      const next = new Set(current);
                      for (const key of visibleGroupKeys) next.add(key);
                      return next;
                    })
                  }
                >
                  Collapse all
                </button>
              )}
            </div>
          </div>

          {visibleEntries.length > 0 ? (
            groups.map((group) =>
              group.label ? (
                <details
                  key={`${groupBy}:${group.label}`}
                  class="feedback-group"
                  open={!collapsedGroups.has(`${groupBy}:${group.label}`)}
                  onToggle={(event) => {
                    const key = `${groupBy}:${group.label}`;
                    const open = event.currentTarget.open;
                    setCollapsedGroups((current) => {
                      const next = new Set(current);
                      if (open) next.delete(key);
                      else next.add(key);
                      return next;
                    });
                  }}
                >
                  <summary class="feedback-group-heading">
                    <span>{group.label}</span>
                    <span>{group.entries.length}</span>
                  </summary>
                  {group.entries.map(renderEntry)}
                </details>
              ) : (
                <div key="all" class="feedback-group">
                  {group.entries.map(renderEntry)}
                </div>
              ),
            )
          ) : (
            <p class="help-text">No feedback matches these filters.</p>
          )}
        </>
      ) : (
        <p class="help-text">No feedback recorded.</p>
      )}
    </CollapsibleSection>
  );
}
