import type { ComponentChildren, Ref } from "preact";

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
  return (
    <div
      class={`toolbar-selector${className ? ` ${className}` : ""}`}
      ref={containerRef}
    >
      {trigger}
      {open && (
        <div
          class={`toolbar-selector-dropdown${dropdownClassName ? ` ${dropdownClassName}` : ""}`}
        >
          {children}
        </div>
      )}
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
