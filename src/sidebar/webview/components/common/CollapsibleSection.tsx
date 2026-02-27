import { useState, useCallback } from "preact/hooks";
import type { ComponentChildren } from "preact";

const STORAGE_PREFIX = "section:";

function readState(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(STORAGE_PREFIX + key);
    if (v === "0") return false;
    if (v === "1") return true;
  } catch {}
  return fallback;
}

interface Props {
  title: string;
  /** Extra content rendered after the title (e.g. badges) */
  titleExtra?: ComponentChildren;
  /** Additional CSS class on the wrapper div */
  className?: string;
  defaultOpen?: boolean;
  children: ComponentChildren;
}

export function CollapsibleSection({
  title,
  titleExtra,
  className,
  defaultOpen = true,
  children,
}: Props) {
  const [open, setOpen] = useState(() => readState(title, defaultOpen));

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_PREFIX + title, next ? "1" : "0");
      } catch {}
      return next;
    });
  }, [title]);

  return (
    <div class={`section ${className ?? ""}`}>
      <h3 class="section-header" onClick={toggle}>
        <span class={`chevron ${open ? "open" : ""}`}>&#9656;</span>
        {title}
        {titleExtra}
      </h3>
      {open && children}
    </div>
  );
}
