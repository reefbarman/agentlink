import type { AppState } from "../../../shared/chatProjection";
import { useState } from "preact/hooks";

export type MessageQueueItem = AppState["messageQueue"][number];

export function MessageQueuePanel({
  queue,
  pendingIds,
  onSteer,
  onInterject,
  onEdit,
  onEditingChange,
  onRemove,
}: {
  queue: MessageQueueItem[];
  pendingIds?: ReadonlySet<string>;
  onSteer: (item: MessageQueueItem) => void;
  onInterject: (item: MessageQueueItem) => void;
  onEdit?: (item: MessageQueueItem, text: string) => void;
  onEditingChange?: (item: MessageQueueItem, editing: boolean) => void;
  onRemove?: (item: MessageQueueItem) => void;
}) {
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingQueueText, setEditingQueueText] = useState("");
  const [expandedQueueIds, setExpandedQueueIds] = useState<Set<string>>(
    () => new Set(),
  );

  if (queue.length === 0) return null;

  return (
    <div class="queue-panel">
      <div class="queue-header">
        <i class="codicon codicon-list-ordered" />
        <span>Queued ({queue.length})</span>
      </div>
      {queue.map((item) => (
        <div
          key={item.id}
          class={`queue-item${item.interjectionReady ? " interjection-ready" : ""}`}
        >
          {editingQueueId === item.id && onEdit ? (
            <textarea
              class="queue-item-textarea"
              value={editingQueueText}
              onInput={(e) =>
                setEditingQueueText((e.target as HTMLTextAreaElement).value)
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  const trimmed = editingQueueText.trim();
                  if (trimmed) {
                    onEdit(item, trimmed);
                  }
                  setEditingQueueId(null);
                  onEditingChange?.(item, false);
                } else if (e.key === "Escape") {
                  setEditingQueueId(null);
                  onEditingChange?.(item, false);
                }
              }}
              autoFocus
            />
          ) : (
            <span
              class={`queue-item-text${expandedQueueIds.has(item.id) ? " expanded" : ""}`}
              title="Click to expand/collapse"
              onClick={() =>
                setExpandedQueueIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(item.id)) next.delete(item.id);
                  else next.add(item.id);
                  return next;
                })
              }
            >
              {item.text}
            </span>
          )}
          <div class="queue-item-actions">
            <button
              class="icon-button queue-item-steer"
              title={
                pendingIds?.has(item.id)
                  ? "Waiting for queue confirmation"
                  : editingQueueId === item.id
                    ? "Finish editing before steering"
                    : "Steer now"
              }
              disabled={pendingIds?.has(item.id) || editingQueueId === item.id}
              onClick={() => {
                if (!pendingIds?.has(item.id) && editingQueueId !== item.id) {
                  onSteer(item);
                }
              }}
            >
              <i class="codicon codicon-compass-active" />
            </button>
            <button
              class={`icon-button queue-item-interject${item.interjectionReady ? " active" : ""}`}
              title={
                pendingIds?.has(item.id)
                  ? "Waiting for queue confirmation"
                  : editingQueueId === item.id
                    ? "Finish editing before interjecting"
                    : item.interjectionReady
                      ? "Ready to interject at next break"
                      : "Interject at next break"
              }
              disabled={pendingIds?.has(item.id) || editingQueueId === item.id}
              onClick={() => {
                if (!pendingIds?.has(item.id) && editingQueueId !== item.id) {
                  onInterject(item);
                }
              }}
            >
              <i class="codicon codicon-reply" />
            </button>
            {onEdit && editingQueueId !== item.id && (
              <button
                class="icon-button queue-item-edit"
                title={
                  pendingIds?.has(item.id)
                    ? "Waiting for queue confirmation"
                    : editingQueueId === null
                      ? "Edit"
                      : "Finish current edit first"
                }
                disabled={pendingIds?.has(item.id) || editingQueueId !== null}
                onClick={() => {
                  if (pendingIds?.has(item.id) || editingQueueId !== null)
                    return;
                  setEditingQueueText(item.text);
                  setEditingQueueId(item.id);
                  onEditingChange?.(item, true);
                }}
              >
                <i class="codicon codicon-edit" />
              </button>
            )}
            {onRemove && (
              <button
                class="icon-button queue-item-remove"
                title={
                  pendingIds?.has(item.id)
                    ? "Waiting for queue confirmation"
                    : editingQueueId === item.id
                      ? "Finish editing before removing"
                      : "Remove"
                }
                disabled={
                  pendingIds?.has(item.id) || editingQueueId === item.id
                }
                onClick={() => {
                  if (!pendingIds?.has(item.id) && editingQueueId !== item.id) {
                    onRemove(item);
                  }
                }}
              >
                <i class="codicon codicon-close" />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
