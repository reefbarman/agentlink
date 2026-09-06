import { useEffect, useRef, useState } from "preact/hooks";

import type { ComponentChildren } from "preact";

export function DesktopMoreActions({
  children,
}: {
  children: ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div
      class="desktop-more-actions"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={trigger}
        class="desktop-more-trigger"
        type="button"
        aria-expanded={open}
        aria-controls="desktop-more-panel"
        onClick={() => setOpen((value) => !value)}
      >
        <i class="codicon codicon-more" aria-hidden="true" />
        More
      </button>
      {open && (
        <div
          id="desktop-more-panel"
          class="desktop-more-panel"
          role="group"
          aria-label="More chat actions"
          onClick={(event) => {
            if ((event.target as Element).closest("button")) {
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
