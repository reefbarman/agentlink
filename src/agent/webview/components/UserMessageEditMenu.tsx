import { useEffect, useRef, useState } from "preact/hooks";

export interface UserMessageEditMenuProps {
  /** Cut this chat back to before the message; files are untouched. */
  onRewind?: () => void;
  /** Cut this chat back and restore files from the message's checkpoint. */
  onRewindRestoreFiles?: () => void;
  /** Edit the message in a new fork, leaving this chat as it is. */
  onFork?: () => void;
}

interface EditMenuItem {
  key: string;
  icon: string;
  label: string;
  detail: string;
  run: () => void;
}

/**
 * Pencil button on a user message that offers the ways to edit it: rewind
 * this chat, rewind and restore files, or edit in a new fork.
 */
export function UserMessageEditMenu({
  onRewind,
  onRewindRestoreFiles,
  onFork,
}: UserMessageEditMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const items: EditMenuItem[] = [];
  if (onRewind) {
    items.push({
      key: "rewind",
      icon: "discard",
      label: "Edit here",
      detail: "Rewind this chat. Files stay as they are.",
      run: onRewind,
    });
  }
  if (onRewindRestoreFiles) {
    items.push({
      key: "rewind-restore-files",
      icon: "history",
      label: "Edit here and restore files",
      detail: "Rewind this chat and roll files back to this point.",
      run: onRewindRestoreFiles,
    });
  }
  if (onFork) {
    items.push({
      key: "fork",
      icon: "repo-forked",
      label: "Edit in new fork",
      detail: "Keep this chat and edit in a new tab.",
      run: onFork,
    });
  }
  if (items.length === 0) return null;

  return (
    <div
      class={`user-message-edit${open ? " open" : ""}`}
      ref={rootRef}
      data-testid="user-message-edit"
    >
      <button
        class="user-message-edit-button"
        onClick={() => setOpen((value) => !value)}
        title="Edit this message"
        aria-label="Edit this message"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <i class="codicon codicon-edit" />
      </button>
      {open && (
        <div class="user-message-edit-menu" role="menu">
          {items.map((item) => (
            <button
              key={item.key}
              class="user-message-edit-menu-item"
              role="menuitem"
              data-edit-action={item.key}
              onClick={() => {
                setOpen(false);
                item.run();
              }}
            >
              <i class={`codicon codicon-${item.icon}`} />
              <span class="user-message-edit-menu-text">
                <span class="user-message-edit-menu-label">{item.label}</span>
                <span class="user-message-edit-menu-detail">{item.detail}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
