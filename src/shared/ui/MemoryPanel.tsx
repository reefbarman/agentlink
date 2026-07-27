import type {
  ManageMemoryToolInput,
  MemoryInspectionQueryRequest,
  MemoryPanelSnapshot,
  MemoryToolScope,
} from "../../core/capabilities/memory.js";
import type {
  MemoryArchiveV1,
  MemoryAuditEvent,
  MemoryKind,
  MemoryStatus,
} from "../../core/memory/contracts.js";
import { useMemo, useRef, useState } from "preact/hooks";

const KINDS: MemoryKind[] = [
  "preference",
  "project_fact",
  "gotcha",
  "decision",
  "workflow_hint",
  "correction",
];
const STATUSES: MemoryStatus[] = [
  "active",
  "superseded",
  "contested",
  "forgotten",
  "expired",
];

export interface MemoryPanelProps {
  snapshot: MemoryPanelSnapshot | null;
  scope: MemoryToolScope;
  availableScopes: MemoryToolScope[];
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  onQuery: (request: MemoryInspectionQueryRequest) => void | Promise<void>;
  onDetail: (recordId: string) => void | Promise<void>;
  onManage: (input: ManageMemoryToolInput) => void | Promise<void>;
  onClear: (scope: MemoryToolScope) => void | Promise<void>;
  onExport: (scope: MemoryToolScope) => void | Promise<void>;
  onImport: (
    archive: MemoryArchiveV1,
    scope: MemoryToolScope,
  ) => void | Promise<void>;
}

export function MemoryPanel({
  snapshot,
  scope,
  availableScopes,
  loading = false,
  error,
  onClose,
  onQuery,
  onDetail,
  onManage,
  onClear,
  onExport,
  onImport,
}: MemoryPanelProps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<MemoryKind | "all">("all");
  const [status, setStatus] = useState<MemoryStatus | "all">("all");
  const [confirmClear, setConfirmClear] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const selectedId = snapshot?.selected?.record.id;
  const undoneIds = useMemo(
    () =>
      new Set(
        snapshot?.events.flatMap((event) =>
          event.undoneAuditEventId ? [event.undoneAuditEventId] : [],
        ) ?? [],
      ),
    [snapshot?.events],
  );

  const runQuery = (nextScope = scope) =>
    onQuery({
      scope: nextScope,
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(kind === "all" ? {} : { kinds: [kind] }),
      ...(status === "all" ? {} : { statuses: [status] }),
      limit: 100,
    });

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setImportError(null);
    try {
      const parsed = JSON.parse(await file.text()) as MemoryArchiveV1;
      await onImport(parsed, scope);
    } catch (cause) {
      setImportError(
        cause instanceof SyntaxError
          ? "The selected file is not valid JSON."
          : "The memory archive could not be imported.",
      );
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  return (
    <section class="memory-panel" aria-label="Autonomous memory manager">
      <header class="memory-panel-header">
        <div>
          <strong>Autonomous memory</strong>
          <span>Low-authority evidence with provenance, audit, and undo.</span>
        </div>
        <button
          class="memory-panel-icon-button"
          onClick={onClose}
          title="Close memory manager"
          type="button"
        >
          ×
        </button>
      </header>

      <div class="memory-panel-toolbar">
        {availableScopes.map((value) => (
          <button
            class={value === scope ? "active" : ""}
            disabled={loading}
            key={value}
            onClick={() => void runQuery(value)}
            type="button"
          >
            {value === "project" ? "Project" : "Global"}
          </button>
        ))}
        <input
          aria-label="Search memory"
          disabled={loading}
          onInput={(event) =>
            setQuery((event.target as HTMLInputElement).value)
          }
          placeholder="Search memory"
          type="search"
          value={query}
        />
        <select
          aria-label="Memory kind"
          disabled={loading}
          onChange={(event) =>
            setKind(
              (event.target as HTMLSelectElement).value as MemoryKind | "all",
            )
          }
          value={kind}
        >
          <option value="all">All kinds</option>
          {KINDS.map((value) => (
            <option key={value} value={value}>
              {value.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <select
          aria-label="Memory status"
          disabled={loading}
          onChange={(event) =>
            setStatus(
              (event.target as HTMLSelectElement).value as MemoryStatus | "all",
            )
          }
          value={status}
        >
          <option value="all">All statuses</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <button
          disabled={loading}
          onClick={() => void runQuery()}
          type="button"
        >
          Search
        </button>
      </div>

      {(error || importError) && (
        <div class="memory-panel-error" role="alert">
          {error ?? importError}
        </div>
      )}
      <div class="memory-panel-stats" role="status">
        <span>Status: {snapshot?.health.status ?? "loading"}</span>
        <span>Active: {snapshot?.health.activeRecordCount ?? "—"}</span>
        <span>Results: {snapshot?.total ?? 0}</span>
      </div>

      <div class="memory-panel-content">
        <div class="memory-panel-records">
          {snapshot?.records.length ? (
            snapshot.records.map((record) => (
              <button
                class={record.id === selectedId ? "selected" : ""}
                disabled={loading}
                key={record.id}
                onClick={() => void onDetail(record.id)}
                type="button"
              >
                <span>
                  {record.kind.replaceAll("_", " ")} · {record.status}
                </span>
                <strong>{record.statement}</strong>
                <small>
                  {record.scope.kind} · rev {record.revision}
                </small>
              </button>
            ))
          ) : (
            <p>No matching memory records.</p>
          )}
        </div>

        {snapshot?.selected && (
          <div class="memory-panel-detail">
            <strong>{snapshot.selected.record.statement}</strong>
            <span>
              {snapshot.selected.record.kind.replaceAll("_", " ")} ·{" "}
              {snapshot.selected.record.status}
            </span>
            <span>
              Provenance:{" "}
              {snapshot.selected.record.provenance
                .map((item) => item.source)
                .join(", ")}
            </span>
            <span>Revisions: {snapshot.selected.revisions.length}</span>
            <span>Audit events: {snapshot.selected.audit.length}</span>
            <div class="memory-panel-actions">
              {snapshot.selected.record.status === "forgotten" ? (
                <button
                  disabled={loading}
                  onClick={() =>
                    void onManage({
                      operation: "restore",
                      scope,
                      target_id: snapshot.selected!.record.id,
                      expected_revision: snapshot.selected!.record.revision,
                      source_evidence: "User restored memory from /memory.",
                    })
                  }
                  type="button"
                >
                  Restore
                </button>
              ) : (
                <button
                  disabled={loading}
                  onClick={() =>
                    void onManage({
                      operation: "forget",
                      scope,
                      target_id: snapshot.selected!.record.id,
                      expected_revision: snapshot.selected!.record.revision,
                      source_evidence: "User forgot memory from /memory.",
                    })
                  }
                  type="button"
                >
                  Forget
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {snapshot?.events.length ? (
        <details class="memory-panel-activity">
          <summary>Recent activity ({snapshot.events.length})</summary>
          <ul>
            {snapshot.events.map((event) => (
              <ActivityItem
                event={event}
                key={event.id}
                disabled={loading}
                undone={undoneIds.has(event.id)}
                onUndo={() =>
                  onManage({
                    operation: "undo",
                    scope,
                    undo_audit_event_id: event.id,
                    source_evidence:
                      "User selected undo from /memory activity.",
                  })
                }
              />
            ))}
          </ul>
        </details>
      ) : null}

      <footer class="memory-panel-footer">
        <button
          disabled={loading}
          onClick={() => void onExport(scope)}
          type="button"
        >
          Export JSON
        </button>
        <button
          disabled={loading}
          onClick={() => importRef.current?.click()}
          type="button"
        >
          Import JSON
        </button>
        <input
          accept="application/json,.json"
          aria-label="Import memory archive"
          disabled={loading}
          hidden
          onChange={(event) =>
            void importFile((event.target as HTMLInputElement).files?.[0])
          }
          ref={importRef}
          type="file"
        />
        {confirmClear ? (
          <>
            <span>Clear tombstones all non-forgotten {scope} records.</span>
            <button
              disabled={loading}
              onClick={() => {
                setConfirmClear(false);
                void onClear(scope);
              }}
              type="button"
            >
              Confirm clear
            </button>
            <button
              disabled={loading}
              onClick={() => setConfirmClear(false)}
              type="button"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            disabled={loading}
            onClick={() => setConfirmClear(true)}
            type="button"
          >
            Clear…
          </button>
        )}
      </footer>
    </section>
  );
}

function ActivityItem({
  event,
  disabled,
  undone,
  onUndo,
}: {
  event: MemoryAuditEvent;
  disabled: boolean;
  undone: boolean;
  onUndo: () => void | Promise<void>;
}) {
  const reversible =
    event.operation !== "undo" &&
    event.changes.length > 0 &&
    !event.disposition.startsWith("rejected-") &&
    event.disposition !== "not-found" &&
    event.disposition !== "stale-revision" &&
    !undone;
  return (
    <li>
      <span>
        {event.operation} · {event.disposition}
      </span>
      <small>{event.occurredAt}</small>
      {reversible && (
        <button disabled={disabled} onClick={() => void onUndo()} type="button">
          Undo
        </button>
      )}
    </li>
  );
}
