import type { ComponentChildren, Ref } from "preact";
import { useCallback, useLayoutEffect, useRef, useState } from "preact/hooks";

import { createPortal } from "preact/compat";

interface ToolbarSelectorProps {
  containerRef?: Ref<HTMLDivElement>;
  open: boolean;
  trigger: ComponentChildren;
  children?: ComponentChildren;
  className?: string;
  dropdownClassName?: string;
}

interface ToolbarControlButtonProps {
  active?: boolean;
  children: ComponentChildren;
  className?: string;
  disabled?: boolean;
  title?: string;
  "aria-pressed"?: boolean;
  type?: "button" | "submit" | "reset";
  onClick?: () => void;
}

export function ToolbarSelector({
  containerRef,
  open,
  trigger,
  children,
  className,
  dropdownClassName,
}: ToolbarSelectorProps) {
  const localRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const updatePositionRef = useRef<(() => void) | null>(null);
  const [dropdownStyle, setDropdownStyle] = useState<{
    left: number;
    top: number;
    minWidth: number;
    maxHeight: number;
    openBelow: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setDropdownStyle(null);
      return;
    }

    const updatePosition = () => {
      const triggerEl = localRef.current;
      if (!triggerEl) return;

      const rect = triggerEl.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const gap = 6;
      const margin = 8;
      const maxDropdownWidth = Math.min(320, viewportWidth - margin * 2);
      const minWidth = Math.min(Math.max(rect.width, 140), maxDropdownWidth);
      const measuredWidth = dropdownRef.current?.getBoundingClientRect().width;
      const clampedWidth = Math.min(
        Math.max(measuredWidth ?? minWidth, minWidth),
        maxDropdownWidth,
      );
      const left = Math.min(
        Math.max(rect.left, margin),
        Math.max(margin, viewportWidth - margin - clampedWidth),
      );
      const spaceAbove = rect.top - margin - gap;
      const spaceBelow = viewportHeight - rect.bottom - margin - gap;
      const openBelow = spaceBelow > spaceAbove;
      const availableHeight = Math.max(
        120,
        openBelow ? spaceBelow : spaceAbove,
      );
      const measuredHeight =
        dropdownRef.current?.getBoundingClientRect().height;
      const clampedHeight = Math.min(
        measuredHeight ?? availableHeight,
        availableHeight,
      );
      const maxHeight = Math.max(120, availableHeight);
      const top = openBelow
        ? Math.min(rect.bottom + gap, viewportHeight - margin - clampedHeight)
        : Math.max(margin, rect.top - gap - clampedHeight);

      setDropdownStyle({ left, top, minWidth, maxHeight, openBelow });
    };

    updatePosition();
    updatePositionRef.current = updatePosition;
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      updatePositionRef.current = null;
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      localRef.current = node;
      if (typeof containerRef === "function") {
        containerRef(node);
      } else if (containerRef) {
        containerRef.current = node;
      }
    },
    [containerRef],
  );

  const setDropdownRef = useCallback((node: HTMLDivElement | null) => {
    dropdownRef.current = node;
    if (node) {
      updatePositionRef.current?.();
    }
  }, []);

  const dropdown =
    open && dropdownStyle
      ? createPortal(
          <div
            ref={setDropdownRef}
            class={`toolbar-selector-dropdown toolbar-selector-dropdown-portal ${dropdownStyle.openBelow ? "toolbar-selector-dropdown-below" : "toolbar-selector-dropdown-above"}${dropdownClassName ? ` ${dropdownClassName}` : ""}`}
            onMouseDown={(event) => event.stopPropagation()}
            style={{
              left: `${dropdownStyle.left}px`,
              top: `${dropdownStyle.top}px`,
              minWidth: `${dropdownStyle.minWidth}px`,
              maxHeight: `${dropdownStyle.maxHeight}px`,
            }}
          >
            {children}
          </div>,
          document.body,
        )
      : null;

  return (
    <div
      class={`toolbar-selector${className ? ` ${className}` : ""}`}
      ref={setRefs}
    >
      {trigger}
      {dropdown}
    </div>
  );
}

export function ToolbarControlButton({
  active = false,
  className,
  children,
  ...props
}: ToolbarControlButtonProps) {
  return (
    <button
      {...props}
      class={`toolbar-control${active ? " active" : ""}${className ? ` ${className}` : ""}`}
    >
      {children}
    </button>
  );
}
