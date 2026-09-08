import type {
  ManageMemoryToolInput,
  MemoryArchiveV1,
  MemoryAuditEvent,
  MemoryInspectionQueryRequest,
  MemoryKind,
  MemoryPanelSnapshot,
  MemoryRecord,
  MemoryStatus,
  MemoryToolScope,
} from "@agentlink/protocol/autonomous-memory";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

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
  onManage: (input: ManageMemoryToolInput) => Promise<void>;
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
  const [editor, setEditor] = useState<{
    record?: MemoryRecord;
    scope: MemoryToolScope;
  } | null>(null);
  const [statement, setStatement] = useState("");
  const [draftKind, setDraftKind] = useState<MemoryKind>("preference");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const navigationLocked = loading || editor !== null;
  const selectedId = snapshot?.selected?.record.id;

  useEffect(() => {
    setConfirmClear(false);
    setSaveMessage(null);
    setSaveError(null);
  }, [scope]);

  const openEditor = (record?: MemoryRecord) => {
    setEditor({ record, scope });
    setStatement(record?.statement ?? "");
    setDraftKind(record?.kind ?? "preference");
    setConfirmClear(false);
    setSaveMessage(null);
    setSaveError(null);
  };

  const saveMemory = async () => {
    if (
      !editor ||
      editor.scope !== scope ||
      loading ||
      saving ||
      !statement.trim()
    )
      return;
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await onManage({
        operation: editor.record ? "update" : "remember",
        scope,
        kind: draftKind,
        statement: statement.trim(),
        source_evidence: editor.record
          ? "User edited memory from /memory."
          : "User added memory from /memory.",
        ...(editor.record
          ? {
              target_id: editor.record.id,
              expected_revision: editor.record.revision,
            }
          : {}),
      });
      setEditor(null);
      setSaveMessage("Memory saved. It remains evidence, not an instruction.");
    } catch (cause) {
      setSaveError(
        cause instanceof Error
          ? cause.message
          : "The memory could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };

  const manageMemory = async (input: ManageMemoryToolInput) => {
    setSaveError(null);
    setSaveMessage(null);
    try {
      await onManage(input);
    } catch (cause) {
      setSaveError(
        cause instanceof Error
          ? cause.message
          : "The memory operation could not be completed.",
      );
    }
  };

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
          <span>
            Facts and preferences remembered across chats. Never permissions or
            instructions.
          </span>
        </div>
        <button
          class="memory-panel-icon-button"
          onClick={onClose}
          disabled={editor !== null}
          title={
            editor
              ? "Save or cancel editing before closing"
              : "Close memory manager"
          }
          type="button"
        >
          ×
        </button>
      </header>

      <form
        class="memory-panel-toolbar"
        aria-label="Filter memories"
        onSubmit={(event) => {
          event.preventDefault();
          if (!navigationLocked) void runQuery();
        }}
      >
        {availableScopes.map((value) => (
          <button
            class={value === scope ? "active" : ""}
            disabled={navigationLocked}
            aria-pressed={value === scope}
            key={value}
            onClick={() => {
              setConfirmClear(false);
              setSaveMessage(null);
              void runQuery(value);
            }}
            type="button"
          >
            {value === "project" ? "Project" : "Global"}
          </button>
        ))}
        <input
          aria-label="Search memory"
          disabled={navigationLocked}
          onInput={(event) =>
            setQuery((event.target as HTMLInputElement).value)
          }
          placeholder="Search memory"
          type="search"
          value={query}
        />
        <select
          aria-label="Memory kind"
          disabled={navigationLocked}
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
          disabled={navigationLocked}
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
        <button disabled={navigationLocked} type="submit">
          Search
        </button>
        <button
          disabled={navigationLocked}
          type="button"
          onClick={() => {
            setQuery("");
            setKind("all");
            setStatus("all");
            void onQuery({ scope, limit: 100 });
          }}
        >
          Reset filters
        </button>
        <button
          disabled={navigationLocked || !snapshot?.health.crud}
          type="button"
          onClick={() => openEditor()}
        >
          Add memory
        </button>
      </form>

      {(error || importError || saveError) && (
        <div class="memory-panel-error" role="alert">
          {saveError ?? error ?? importError}
        </div>
      )}
      {saveMessage && (
        <p class="memory-panel-stats" role="status">
          {saveMessage}
        </p>
      )}
      {editor && (
        <form
          class="memory-panel-editor"
          aria-label={editor.record ? "Edit memory" : "Add memory"}
          onSubmit={(event) => {
            event.preventDefault();
            void saveMemory();
          }}
        >
          <strong>
            {editor.record ? "Edit memory" : "Add memory"} ·{" "}
            {editor.scope === "global" ? "Global" : "Project"}
          </strong>
          {editor.scope !== scope && (
            <p role="alert">
              The active scope changed. Your draft is preserved, but cannot be
              saved here. Copy it before cancelling, then reopen the intended
              scope.
            </p>
          )}
          <p>
            {editor.scope === "global"
              ? "Available across projects and Browser Ask Agent."
              : "Available only in this project."}{" "}
            Keep it specific and leave out secrets.
          </p>
          <label>
            Kind
            <select
              aria-label="Record kind"
              value={draftKind}
              disabled={loading || saving}
              onChange={(event) =>
                setDraftKind(event.currentTarget.value as MemoryKind)
              }
            >
              {KINDS.map((value) => (
                <option key={value} value={value}>
                  {value.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label>
            Memory
            <textarea
              aria-label="Memory statement"
              rows={4}
              required
              value={statement}
              disabled={loading || saving}
              onInput={(event) => setStatement(event.currentTarget.value)}
            />
          </label>
          <div class="memory-panel-actions">
            <button
              type="submit"
              disabled={
                loading || saving || editor.scope !== scope || !statement.trim()
              }
            >
              {saving ? "Saving…" : "Save memory"}
            </button>
            <button
              type="button"
              disabled={loading || saving}
              onClick={() => {
                setEditor(null);
                setSaveError(null);
              }}
            >
              Cancel editing
            </button>
          </div>
        </form>
      )}
      <div class="memory-panel-stats" role="status">
        <span>Status: {snapshot?.health.status ?? "loading"}</span>
        <span>Active: {snapshot?.health.activeRecordCount ?? "—"}</span>
        <span>
          {loading
            ? "Loading…"
            : `Showing ${snapshot?.records.length ?? 0} of ${snapshot?.total ?? 0} matches`}
        </span>
      </div>

      <div class="memory-panel-content">
        <div class="memory-panel-records">
          {snapshot?.records.length ? (
            snapshot.records.map((record) => (
              <button
                class={record.id === selectedId ? "selected" : ""}
                disabled={navigationLocked}
                aria-pressed={record.id === selectedId}
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
            <p>
              {loading
                ? "Loading memories…"
                : query || kind !== "all" || status !== "all"
                  ? "No matching memories. Try resetting the filters."
                  : "No memories yet. Add a fact or preference you want to keep across chats."}
            </p>
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
              Updated:{" "}
              {new Date(snapshot.selected.record.updatedAt).toLocaleString()}
            </span>
            <span>
              Confidence:{" "}
              {Math.round(snapshot.selected.record.confidence * 100)}%
            </span>
            {snapshot.selected.record.expiresAt && (
              <span>
                Expires:{" "}
                {new Date(snapshot.selected.record.expiresAt).toLocaleString()}
              </span>
            )}
            <details class="memory-panel-history">
              <summary>
                Sources ({snapshot.selected.record.provenance.length})
              </summary>
              <ul>
                {snapshot.selected.record.provenance.map((source, index) => (
                  <li key={index}>
                    <strong>{source.source.replaceAll("_", " ")}</strong>
                    <small>
                      {new Date(source.observedAt).toLocaleString()}
                    </small>
                    {source.evidence && <p>{source.evidence}</p>}
                  </li>
                ))}
              </ul>
            </details>
            <details class="memory-panel-history">
              <summary>
                Revisions ({snapshot.selected.revisions.length})
              </summary>
              <ul>
                {snapshot.selected.revisions.map((revision) => (
                  <li key={revision.revision}>
                    <small>
                      Revision {revision.revision} ·{" "}
                      {new Date(revision.recordedAt).toLocaleString()} ·{" "}
                      {revision.record.status}
                    </small>
                    <p>{revision.record.statement}</p>
                  </li>
                ))}
              </ul>
            </details>
            <span>Audit events: {snapshot.selected.audit.length}</span>
            <div class="memory-panel-actions">
              {snapshot.selected.record.status !== "forgotten" && (
                <button
                  type="button"
                  disabled={navigationLocked || !snapshot.health.crud}
                  onClick={() => openEditor(snapshot.selected!.record)}
                >
                  Edit
                </button>
              )}
              {snapshot.selected.record.status === "forgotten" ? (
                <button
                  disabled={navigationLocked}
                  onClick={() =>
                    void manageMemory({
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
                  disabled={navigationLocked}
                  onClick={() =>
                    void manageMemory({
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
                disabled={navigationLocked}
                undone={undoneIds.has(event.id)}
                onUndo={() =>
                  manageMemory({
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
          disabled={navigationLocked}
          onClick={() => void onExport(scope)}
          type="button"
        >
          Export JSON
        </button>
        <button
          disabled={navigationLocked}
          onClick={() => importRef.current?.click()}
          type="button"
        >
          Import JSON
        </button>
        <input
          accept="application/json,.json"
          aria-label="Import memory archive"
          disabled={navigationLocked}
          hidden
          onChange={(event) =>
            void importFile((event.target as HTMLInputElement).files?.[0])
          }
          ref={importRef}
          type="file"
        />
        {confirmClear ? (
          <>
            <span>
              Forget all {scope} memories, including records hidden by filters?
              You can undo this in recent activity.
            </span>
            <button
              disabled={navigationLocked}
              onClick={() => {
                setConfirmClear(false);
                void onClear(scope);
              }}
              type="button"
            >
              Confirm clear
            </button>
            <button
              disabled={navigationLocked}
              onClick={() => setConfirmClear(false)}
              type="button"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            disabled={navigationLocked}
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
      <small>{new Date(event.occurredAt).toLocaleString()}</small>
      <small>
        {event.changes[0]?.after?.statement ??
          event.changes[0]?.before?.statement}
      </small>
      {reversible && (
        <button disabled={disabled} onClick={() => void onUndo()} type="button">
          Undo
        </button>
      )}
    </li>
  );
}
